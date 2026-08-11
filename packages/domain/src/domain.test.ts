import { describe, expect, it } from 'vitest';
import type { Envelope, TemplateVersion } from '@esign/contracts';
import {
  DomainError,
  appendAudit,
  canonicalJson,
  denormalizeRect,
  normalizeRect,
  safeAuditPayload,
  seedState,
  sha256,
  transitionEnvelope,
  validateTemplateForPublication,
  verifyAuditChain,
} from './index';

function envelope(status: Envelope['status'] = 'PREPARED'): Envelope {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    templateId: '33333333-3333-4333-8333-333333333333',
    templateVersionId: '44444444-4444-4444-8444-444444444444',
    subject: 'Test agreement',
    message: '',
    status,
    jurisdiction: 'NY',
    businessDomain: 'REAL_ESTATE',
    approvalRequired: false,
    expiresAt: '2027-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    documents: [],
    fields: [],
    recipients: [],
    retentionPolicyId: 'real-estate-7y',
  };
}

describe('envelope state machine', () => {
  it('applies allowed transitions and increments concurrency version', () => {
    const item = envelope();
    transitionEnvelope(item, 'READY_TO_SEND', '2026-02-01T00:00:00.000Z');
    expect(item.status).toBe('READY_TO_SEND');
    expect(item.version).toBe(2);
  });

  it('rejects forbidden and terminal transitions', () => {
    expect(() =>
      transitionEnvelope(envelope('COMPLETED'), 'VOIDED', '2026-02-01T00:00:00.000Z'),
    ).toThrowError(
      new DomainError(
        'invalid_transition',
        'Envelope cannot transition from COMPLETED to VOIDED.',
        409,
      ),
    );
  });
});

describe('audit evidence', () => {
  it('chains canonical event hashes and detects tampering', () => {
    const state = seedState();
    const base = {
      workspaceId: state.workspaces[0]!.id,
      envelopeId: '11111111-1111-4111-8111-111111111111',
      actorType: 'system' as const,
      actorId: 'test',
      occurredAt: '2026-01-01T00:00:00.000Z',
      payload: {},
    };
    appendAudit(state, { ...base, type: 'first' });
    appendAudit(state, { ...base, type: 'second' });
    expect(verifyAuditChain(state.auditEvents)).toBe(true);
    state.auditEvents[1]!.type = 'altered';
    expect(verifyAuditChain(state.auditEvents)).toBe(false);
  });

  it('redacts credential and signature-shaped payload keys', () => {
    expect(
      safeAuditPayload({
        token: 'secret',
        signatureImage: 'pixels',
        status: 'ok',
        documentBody: 'bytes',
      }),
    ).toEqual({
      token: '[REDACTED]',
      signatureImage: '[REDACTED]',
      status: 'ok',
      documentBody: '[REDACTED]',
    });
  });

  it('canonicalizes key order before hashing', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(sha256(canonicalJson({ b: 2, a: 1 }))).toBe(sha256(canonicalJson({ a: 1, b: 2 })));
  });
});

describe('template geometry and publication', () => {
  it('round-trips normalized coordinates independent of pixels', () => {
    const normalized = normalizeRect(
      { x: 50, y: 100, width: 200, height: 40 },
      { width: 500, height: 800 },
    );
    expect(denormalizeRect(normalized, { width: 1000, height: 1600 })).toEqual({
      x: 100,
      y: 200,
      width: 400,
      height: 80,
    });
  });

  it('blocks a real-estate template without jurisdiction and role ownership', () => {
    const version: TemplateVersion = {
      id: '11111111-1111-4111-8111-111111111111',
      version: 1,
      status: 'DRAFT',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceName: 'Source',
      licenseOwner: 'Owner',
      edition: '1',
      effectiveDate: '2026-01-01',
      jurisdiction: 'NONE',
      businessDomain: 'REAL_ESTATE',
      approvalRequired: false,
      retentionPolicyId: 'real-estate-7y',
      documents: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'form.pdf',
          objectKey: 'templates/form.pdf',
          sha256: 'a'.repeat(64),
          pageCount: 1,
          order: 0,
          retentionClass: 'real-estate-7y',
          detectedMime: 'application/pdf',
        },
      ],
      roles: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          name: 'Buyer',
          kind: 'signer',
          routingOrder: 1,
        },
      ],
      fields: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          documentId: '22222222-2222-4222-8222-222222222222',
          page: 1,
          type: 'signature',
          roleId: null,
          label: 'Buyer signature',
          required: true,
          readOnly: false,
          sensitive: false,
          tabIndex: 0,
          rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05, rotation: 0 },
        },
      ],
    };
    expect(() => validateTemplateForPublication(version)).toThrowError(DomainError);
  });
});

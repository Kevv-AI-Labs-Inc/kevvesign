import { describe, expect, it } from 'vitest';
import { composePreparedParts } from '../packages.js';
import { composeInput } from '../model.js';
import type { PreparedPart, Connection } from '../model.js';
function part(name: string, role = 'SIGNER', actor: 'owner' | 'customer' = 'owner'): PreparedPart {
  return {
    connection: { id: 'same-company' } as Connection,
    files: [{ name, bytes: new Uint8Array([1, 2, 3]) }],
    bindings: [{ key: 'agent', email: 'agent@example.invalid', name: 'Agent', role, actor }],
    payload: {
      recipients: [
        {
          email: 'agent@example.invalid',
          name: 'Agent',
          role,
          signingOrder: 9,
          fields: [{ identifier: 0, type: role === 'SIGNER' ? 'SIGNATURE' : 'TEXT', page: 1 }],
        },
      ],
      meta: { signingOrder: 'SEQUENTIAL' },
    },
  };
}
describe('independently approved documents in one native envelope', () => {
  it('preserves separate bytes and routes each field to its original PDF while unifying the agent', () => {
    const documents = [part('acknowledgement', 'APPROVER'), part('agreement')];
    const result = composePreparedParts(documents, 'Buyer package', 'SEQUENTIAL');
    expect(result.files).toEqual(documents.flatMap((p) => p.files));
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].role).toBe('SIGNER');
    expect(result.payload.recipients).toEqual([
      {
        email: 'agent@example.invalid',
        name: 'Agent',
        role: 'SIGNER',
        signingOrder: 1,
        fields: [
          { identifier: 0, type: 'TEXT', page: 1 },
          { identifier: 1, type: 'SIGNATURE', page: 1 },
        ],
      },
    ]);
    expect(documents[0].bindings[0].role).toBe('APPROVER');
  });
  it('rejects company and role identity conflicts rather than handing a field to another signer', () => {
    const wrongCompany = part('wrong');
    wrongCompany.connection = { ...wrongCompany.connection, id: 'other-company' };
    expect(() => composePreparedParts([part('first'), wrongCompany], 'test', 'PARALLEL')).toThrow(
      'PACKAGE_COMPANY_MISMATCH',
    );
    expect(() =>
      composePreparedParts(
        [part('first'), part('wrong', 'SIGNER', 'customer')],
        'test',
        'PARALLEL',
      ),
    ).toThrow('PACKAGE_ROLE_MISMATCH');
    const second = part('wrong');
    second.bindings[0].email = 'another@example.invalid';
    expect(() => composePreparedParts([part('first'), second], 'test', 'PARALLEL')).toThrow(
      'PACKAGE_ROLE_MISMATCH',
    );
  });
  it('requires an explicit review and distinct pinned version IDs', () => {
    const input = {
      packageKey: 'buyer',
      version: 1,
      title: 'Buyer',
      scenario: 'buyer',
      companyKey: 'company',
      documentIds: ['00000000-0000-4000-8000-000000000001'],
      reviewed: true,
    };
    expect(composeInput.safeParse(input).success).toBe(true);
    expect(composeInput.safeParse({ ...input, reviewed: false }).success).toBe(false);
    expect(
      composeInput.safeParse({
        ...input,
        documentIds: [...input.documentIds, ...input.documentIds],
      }).success,
    ).toBe(false);
  });
});

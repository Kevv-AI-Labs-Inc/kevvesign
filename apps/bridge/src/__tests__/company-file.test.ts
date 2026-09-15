import { describe, expect, it } from 'vitest';
import { publishInput } from '../model.js';
import { assertNewSigningScenario, isCompanyPackage, isHr } from '../policy.js';

const owner = { key: 'agent', actor: 'owner', label: 'Preparing agent', templateRecipientId: 1 };
const template = (roles = [owner]) => ({
  packageKey: 'deal-sheet',
  version: 1,
  title: 'Deal Sheet',
  scenario: 'company_file',
  companyKey: 'homix_realty',
  applicableCompanyKeys: ['homix_realty', 'homix_living'],
  parts: [{ title: 'Deal Sheet', templateId: 'company-template', roles, prefill: [] }],
});

describe('Company File stays internal', () => {
  it('shares a company master with exactly the initiating agent', () => {
    expect(publishInput.safeParse(template()).success).toBe(true);
    expect(isCompanyPackage('company_file')).toBe(true);
    expect(isHr('company_file')).toBe(false);
  });
  it('rejects customer, company-mailbox, optional and extra-owner recipients', () => {
    for (const actor of ['customer', 'company'])
      expect(publishInput.safeParse(template([{ ...owner, actor }])).success).toBe(false);
    expect(
      publishInput.safeParse(template([{ ...owner, optional: true } as typeof owner])).success,
    ).toBe(false);
    expect(
      publishInput.safeParse(
        template([owner, { ...owner, key: 'someone_else', templateRecipientId: 2 }]),
      ).success,
    ).toBe(false);
  });
  it('requires company membership even though the only recipient is the agent', () => {
    const agent = {
      clientId: 'portal',
      agentId: 1,
      admin: false,
      verifiedEmails: ['agent@example.invalid'],
      allowedCompanyKeys: ['homix_living'],
      portalOrigin: 'https://agents.example.invalid',
    };
    expect(() => assertNewSigningScenario(agent, 'company_file', 'homix_living')).not.toThrow();
    expect(() => assertNewSigningScenario(agent, 'company_file', 'homix_realty')).toThrow(
      'COMPANY_ACCESS_DENIED',
    );
  });
});

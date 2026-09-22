import { describe, expect, it } from 'vitest';
import { assertNewSigningScenario, isHr, isCompanyPackage } from '../policy.js';
import { createInput } from '../model.js';
const principal = {
  clientId: 'qa',
  agentId: 1,
  admin: false,
  verifiedEmails: ['admin@example.invalid'],
  allowedCompanyKeys: ['homix_realty'],
  portalOrigin: 'https://portal.example.invalid',
};
describe('termination package and identity', () => {
  it('uses the HR scope and requires an administrator', () => {
    expect(isHr('offboarding')).toBe(true);
    expect(isCompanyPackage('offboarding')).toBe(false);
    expect(() => assertNewSigningScenario(principal, 'offboarding', 'homix_realty')).toThrow(
      'ADMIN_REQUIRED',
    );
    expect(() =>
      assertNewSigningScenario({ ...principal, admin: true }, 'offboarding', 'homix_realty'),
    ).not.toThrow();
  });
  it('requires a published package and distinct recipient keys', () => {
    const input = {
      idempotencyKey: 'test',
      externalReference: 'test',
      title: 'Termination',
      scenario: 'offboarding',
      companyKey: 'homix_realty',
      ownerAgentId: 1,
      recipients: [],
    };
    expect(createInput.safeParse(input).success).toBe(false);
    expect(
      createInput.safeParse({
        ...input,
        packageId: '91927028-59cc-446a-a9f5-8b1eb5255497',
        recipients: [
          { key: 'agent', name: 'Test', email: 'agent@example.invalid' },
          { key: 'company', name: 'Broker', email: 'broker@example.invalid' },
        ],
      }).success,
    ).toBe(true);
  });
});

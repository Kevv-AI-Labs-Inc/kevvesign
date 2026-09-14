import type { Principal } from './config.js';
import { BridgeError } from './model.js';

export const isCustomerPackage = (scenario: string) =>
  scenario === 'buyer' || scenario === 'seller';
export const isHr = (scenario: string) => scenario === 'onboarding' || scenario === 'team_leader';

export function assertCompanyAccess(principal: Principal, companyKey: string) {
  if (!principal.admin && !principal.allowedCompanyKeys?.includes(companyKey))
    throw new BridgeError('COMPANY_ACCESS_DENIED', 403);
}

export function assertNewSigningScenario(
  principal: Principal,
  scenario: string,
  companyKey: string,
) {
  if (scenario === 'custom') throw new BridgeError('PERSONAL_SIGNING_UNAVAILABLE', 403);
  if (isCustomerPackage(scenario)) assertCompanyAccess(principal, companyKey);
}

import type { Principal } from './config.js';
import { BridgeError, type PackageRow } from './model.js';

export function packageCompanyKeys(
  item: Pick<PackageRow, 'company_key' | 'applicable_company_keys'>,
) {
  return item.applicable_company_keys?.length ? item.applicable_company_keys : [item.company_key];
}

export const isCompanyPackage = (scenario: string) =>
  ['buyer', 'seller', 'commercial', 'company_file'].includes(scenario);
export const isHr = (scenario: string) =>
  ['onboarding', 'team_leader', 'offboarding'].includes(scenario);

export function assertCompanyAccess(principal: Principal, companyKey: string) {
  if (!principal.admin && !principal.allowedCompanyKeys?.includes(companyKey))
    throw new BridgeError('COMPANY_ACCESS_DENIED', 403);
}

export function assertNewSigningScenario(
  principal: Principal,
  scenario: string,
  companyKey: string,
) {
  if (scenario === 'offboarding' && !principal.admin) throw new BridgeError('ADMIN_REQUIRED', 403);
  if (scenario === 'custom') throw new BridgeError('PERSONAL_SIGNING_UNAVAILABLE', 403);
  if (isCompanyPackage(scenario)) assertCompanyAccess(principal, companyKey);
}

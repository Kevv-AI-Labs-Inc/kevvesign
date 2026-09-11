import { expect, it } from 'vitest';
import { isValidSigningDate } from './index';
it('validates calendar dates without normalizing impossible days or changing timezone', () => {
  for (const value of ['2024-02-29', '2026-09-11', '2026-12-31'])
    expect(isValidSigningDate(value)).toBe(true);
  for (const value of [
    '2026-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-09-11T00:00:00Z',
    '09/11/2026',
    'anything',
    '',
    true,
  ])
    expect(isValidSigningDate(value)).toBe(false);
});

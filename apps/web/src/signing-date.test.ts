import { describe, expect, it } from 'vitest';
import { localSigningDate } from './signing-date';

describe('localSigningDate', () => {
  it('uses the signers local calendar date', () => {
    expect(localSigningDate(new Date(2026, 7, 27, 23, 59))).toBe('2026-08-27');
  });
});

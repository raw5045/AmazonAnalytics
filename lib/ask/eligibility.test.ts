import { describe, it, expect } from 'vitest';
import { askAiEligible } from './eligibility';

describe('askAiEligible', () => {
  it('admits admins regardless of account, and members only with an account that has access', () => {
    expect(askAiEligible('admin', null)).toBe(true);
    expect(askAiEligible('admin', { access: false })).toBe(true);
    expect(askAiEligible('standard_user', null)).toBe(false);
    expect(askAiEligible('standard_user', { access: false })).toBe(false);
    expect(askAiEligible('standard_user', { access: true })).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { connectAiEligible } from './eligibility';

describe('connectAiEligible', () => {
  it('admins always; everyone once the audience is all', () => {
    expect(connectAiEligible('admin', 'admin')).toBe(true);
    expect(connectAiEligible('standard_user', 'admin')).toBe(false);
    expect(connectAiEligible('standard_user', 'all')).toBe(true);
  });

  it('admins are eligible under the all audience too', () => {
    expect(connectAiEligible('admin', 'all')).toBe(true);
  });
});

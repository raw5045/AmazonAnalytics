import { describe, it, expect } from 'vitest';
import { isUuid } from './uuid';

describe('isUuid', () => {
  it('accepts a uuid in either case and rejects anything else', () => {
    expect(isUuid('abcdef12-abcd-4abc-8abc-abcdef123456')).toBe(true);
    expect(isUuid('ABCDEF12-ABCD-4ABC-8ABC-ABCDEF123456')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});

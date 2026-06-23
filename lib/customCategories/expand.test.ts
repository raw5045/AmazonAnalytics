import { describe, it, expect, vi } from 'vitest';

// Mock the DB client so this unit test can run without env vars.
// The DB-dependent expandCustomCategories is tested via integration tests.
vi.mock('@/db/client', () => ({ db: {} }));

import { mergeCustomLeaves } from './expand';

describe('mergeCustomLeaves', () => {
  it('unions selected categories leaves into the base set, deduped + sorted', () => {
    const rows = [
      { id: 'a', leafNames: ['Collagen', 'Iron'] },
      { id: 'b', leafNames: ['Iron', 'Zinc'] },
    ];
    expect(mergeCustomLeaves(['Magnesium'], rows)).toEqual(['Collagen', 'Iron', 'Magnesium', 'Zinc']);
  });
  it('returns the base unchanged (deduped+sorted) when no rows', () => {
    expect(mergeCustomLeaves(['Collagen'], [])).toEqual(['Collagen']);
  });
});

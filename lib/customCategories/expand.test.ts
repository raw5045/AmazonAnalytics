import { describe, it, expect, vi } from 'vitest';
vi.mock('@/db/client', () => ({ db: {} }));
import { mergeCustomPaths } from './expand';

describe('mergeCustomPaths', () => {
  it('unions selected categories paths into the base set, deduped + sorted', () => {
    const rows = [
      { id: 'a', leafPaths: ['H › Collagen', 'H › Iron'] },
      { id: 'b', leafPaths: ['H › Iron', 'H › Zinc'] },
    ];
    expect(mergeCustomPaths(['H › Magnesium'], rows))
      .toEqual(['H › Collagen', 'H › Iron', 'H › Magnesium', 'H › Zinc']);
  });
  it('returns base unchanged when no rows', () =>
    expect(mergeCustomPaths(['H › Collagen'], [])).toEqual(['H › Collagen']));
});

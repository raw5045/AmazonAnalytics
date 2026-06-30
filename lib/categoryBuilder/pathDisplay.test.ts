import { describe, it, expect } from 'vitest';
import { splitCategoryPath } from './pathDisplay';

describe('splitCategoryPath', () => {
  it('splits a multi-segment path into leaf + prefix', () =>
    expect(splitCategoryPath('A › B › C')).toEqual({ leaf: 'C', prefix: 'A › B' }));
  it('handles a single-segment (department-only) path', () =>
    expect(splitCategoryPath('Books')).toEqual({ leaf: 'Books', prefix: '' }));
});

// lib/keepa/readSource.test.ts
import { describe, it, expect } from 'vitest';
import { keepaReadSource } from './readSource';

describe('keepaReadSource', () => {
  it('defaults to the per-week table and switches only on the exact value', () => {
    expect(keepaReadSource({})).toBe('weekly');
    expect(keepaReadSource({ KEEPA_READ_SOURCE: 'products' })).toBe('products');
    expect(keepaReadSource({ KEEPA_READ_SOURCE: 'Products' })).toBe('weekly');
    expect(keepaReadSource({ KEEPA_READ_SOURCE: '' })).toBe('weekly');
  });
});

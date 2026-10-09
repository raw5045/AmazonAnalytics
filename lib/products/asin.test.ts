// lib/products/asin.test.ts
import { it, expect } from 'vitest';
import { ASIN_RE, isAsin } from './asin';

it('isAsin: exactly ten upper-case letters or digits (ASIN_RE)', () => {
  expect(['B000000001', '0123456789'].map(isAsin)).toEqual([true, true]);
  expect(['b000000001', 'B00000001', 'B0000000012', 'B0000?#001', 'B000000001\n', ''].map(isAsin)).toEqual([false, false, false, false, false, false]);
  expect(ASIN_RE.source).toBe('^[A-Z0-9]{10}$');
});

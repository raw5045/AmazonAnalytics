// lib/products/filterParams.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PRODUCT_SORTS, SORT_KEY_LABEL, sortHidesNullKey } from './filterParams';
import * as searchProducts from './searchProducts';

const source = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

/** The module names a file imports values (not `import type`) from under @/lib/products/. */
const productValueImports = (file: string) =>
  [...source(file).matchAll(/^import\s+(?!type\b)[^;]*?\sfrom\s+'@\/lib\/products\/([^']+)'/gm)].map((m) => m[1]);

/** Every .ts/.tsx file under `dir` (repo-relative, forward slashes), route-group and dynamic-segment folders included. */
const filesUnder = (dir: string): string[] =>
  readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(`${dir}/${entry.name}`) : /\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : [],
  );

/** The Products page's client components (they ship to the browser): every file under the route whose first line is the 'use client' directive. */
const CLIENT_COMPONENTS = filesUnder('app/(app)/products').filter((file) => /^['"]use client['"];?\s*$/.test(source(file).split(/\r?\n/, 1)[0]));

describe('filterParams (the zod-free half of the product filters)', () => {
  it('has no runtime imports, so it can never pull zod (or anything else) into a client bundle', () => {
    expect(source('lib/products/filterParams.ts')).not.toMatch(/^\s*import\s+(?!type\b)/m);
  });

  it("the client components import lib/products values only from filterParams, format and asin (never filters' zod)", () => {
    // The glob finds the page's client components and the pattern sees the panel's imports (so an empty list below means none, not a miss).
    expect(CLIENT_COMPONENTS).toEqual(expect.arrayContaining(['app/(app)/products/ProductFilterPanel.tsx', 'app/(app)/products/ProductResultsTable.tsx']));
    expect(productValueImports('app/(app)/products/ProductFilterPanel.tsx')).toEqual(expect.arrayContaining(['filterParams', 'format']));
    for (const file of CLIENT_COMPONENTS) {
      expect(productValueImports(file).filter((m) => !['filterParams', 'format', 'asin'].includes(m)), file).toEqual([]);
    }
  });

  it('searchProducts re-exports the sort-key rule as the same objects', () => {
    expect(searchProducts.SORT_KEY_LABEL).toBe(SORT_KEY_LABEL);
    expect(searchProducts.sortHidesNullKey).toBe(sortHidesNullKey);
  });

  it('every sort but keywords hides products without its key, and each of those has a label', () => {
    expect(PRODUCT_SORTS.filter(sortHidesNullKey)).toEqual(Object.keys(SORT_KEY_LABEL));
    expect(sortHidesNullKey('keywords')).toBe(false);
  });
});

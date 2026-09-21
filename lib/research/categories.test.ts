// lib/research/categories.test.ts
import { describe, it, expect, vi } from 'vitest';
// @/lib/env parses process.env at import time (throws on the missing NEXT_PUBLIC_* vars without
// a mock — see lib/research/cursor.test.ts) and @/db/client opens a driver at import (see
// lib/notifications/digest/loadDigestData.test.ts). Neither is exercised by the pure functions
// under test here (buildCategoryCatalog/rankCandidates/expandSelections never touch db or env),
// so a minimal stub of each is enough to let the module load.
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
vi.mock('@/db/client', () => ({ db: {} }));

import { buildCategoryCatalog, rankCandidates, expandSelections } from './categories';

const SNAP = 'snap-1';
const facets = [
  { categoryPath: 'Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades › Table Lamps', allCount: 120 },
  { categoryPath: 'Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades › Lampshades', allCount: 15 },
  { categoryPath: 'Tools & Home Improvement › Lighting & Ceiling Fans › Outdoor Lighting › Path Lights', allCount: 40 },
  { categoryPath: 'Electronics › Camera & Photo › Lighting & Studio › Continuous Lighting', allCount: 9 },
  { categoryPath: 'Home & Kitchen › Lamps', allCount: 3 },
];
const catalog = buildCategoryCatalog(SNAP, facets);

describe('buildCategoryCatalog', () => {
  it('indexes leaves with counts and parents with descendant counts; the same label under different parents stays distinct (Q07)', () => {
    expect(catalog.byPath.get('Home & Kitchen › Lamps')).toEqual({ path: 'Home & Kitchen › Lamps', terminal: true, keywordCount: 3, descendantLeafCount: 0 });
    expect(catalog.byPath.get('Tools & Home Improvement › Lighting & Ceiling Fans')?.descendantLeafCount).toBe(3);
    expect(catalog.byPath.get('Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades')?.terminal).toBe(false);
    const paths = catalog.entries.map((e) => e.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });
});

describe('rankCandidates', () => {
  it('ranks exact label, then prefix, then contains, then full-path matches, deterministically', () => {
    const { candidates, total } = rankCandidates(catalog, { query: 'lamps', parentPath: null, offset: 0, limit: 10 });
    expect(candidates.map((c) => c.path)).toEqual([
      'Home & Kitchen › Lamps',
      'Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades',
      'Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades › Lampshades',
      'Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades › Table Lamps',
    ]);
    expect(total).toBe(4);
    expect(candidates[0]).toMatchObject({ kind: 'taxonomy', terminal: true, keywordCount: 3, selection: { kind: 'taxonomy', path: 'Home & Kitchen › Lamps', includeDescendants: false } });
    expect(candidates[1].selection).toEqual({ kind: 'taxonomy', path: 'Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades', includeDescendants: true });
  });
  it('a broad word surfaces every branch so the host can ask which (Q10)', () => {
    const paths = rankCandidates(catalog, { query: 'lighting', parentPath: null, offset: 0, limit: 50 }).candidates.map((c) => c.path);
    expect(paths).toContain('Tools & Home Improvement › Lighting & Ceiling Fans');
    expect(paths).toContain('Electronics › Camera & Photo › Lighting & Studio');
    expect(paths).toContain('Tools & Home Improvement › Lighting & Ceiling Fans › Outdoor Lighting');
  });
  it('browses direct children of a parentPath with an empty query, pages, and rejects an unknown parent', () => {
    const parent = 'Tools & Home Improvement › Lighting & Ceiling Fans';
    const page = rankCandidates(catalog, { query: '', parentPath: parent, offset: 0, limit: 1 });
    expect(page.total).toBe(2);
    expect(page.candidates.map((c) => c.path)).toEqual([`${parent} › Lamps & Shades`]);
    expect(rankCandidates(catalog, { query: '', parentPath: parent, offset: 1, limit: 1 }).candidates[0].path).toBe(`${parent} › Outdoor Lighting`);
    expect(() => rankCandidates(catalog, { query: '', parentPath: 'Nope', offset: 0, limit: 5 })).toThrow(expect.objectContaining({ code: 'CATEGORY_NOT_AVAILABLE' }));
  });
});

describe('expandSelections', () => {
  const custom = [{ id: '11111111-1111-4111-8111-111111111111', leafPaths: ['Home & Kitchen › Lamps', 'Electronics › Camera & Photo › Lighting & Studio › Continuous Lighting'] }];
  it('expands a parent to its terminal descendants, unions a custom category and explicit leaves, dedupes, sorts, hashes, previews (Q06)', () => {
    const out = expandSelections(catalog, {
      selections: [
        { kind: 'taxonomy', path: 'Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades', includeDescendants: true },
        { kind: 'custom', id: custom[0].id },
      ],
      leafPaths: ['Home & Kitchen › Lamps'],
    }, custom, 2000);
    expect(out.leaves).toEqual([
      'Electronics › Camera & Photo › Lighting & Studio › Continuous Lighting',
      'Home & Kitchen › Lamps',
      'Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades › Lampshades',
      'Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades › Table Lamps',
    ]);
    expect(out.scope).toMatchObject({ expandedLeafCount: 4, previewComplete: true });
    expect(out.scope.leafSetHash).toMatch(/^[0-9a-f]{16}$/);
    expect(out.scope.previewPaths).toEqual(out.leaves);
  });
  it('a path prefix never matches a sibling: "Lamps" does not expand to "Lampshades"', () => {
    const out = expandSelections(catalog, { selections: [{ kind: 'taxonomy', path: 'Home & Kitchen › Lamps', includeDescendants: true }], leafPaths: [] }, [], 2000);
    expect(out.leaves).toEqual(['Home & Kitchen › Lamps']);
  });
  it('rejects unknown paths, a parent without includeDescendants, an unknown/foreign/empty custom id (Q08), and an over-limit scope (Q09)', () => {
    const notAvail = expect.objectContaining({ code: 'CATEGORY_NOT_AVAILABLE' });
    const sel = (s: unknown) => ({ selections: [s] as never, leafPaths: [] });
    expect(() => expandSelections(catalog, sel({ kind: 'taxonomy', path: 'Made Up', includeDescendants: true }), [], 2000)).toThrow(notAvail);
    expect(() => expandSelections(catalog, sel({ kind: 'taxonomy', path: 'Tools & Home Improvement', includeDescendants: false }), [], 2000)).toThrow(notAvail);
    expect(() => expandSelections(catalog, sel({ kind: 'custom', id: '22222222-2222-4222-8222-222222222222' }), custom, 2000)).toThrow(notAvail);
    expect(() => expandSelections(catalog, sel({ kind: 'custom', id: custom[0].id }), [{ id: custom[0].id, leafPaths: [] }], 2000)).toThrow(notAvail);
    expect(() => expandSelections(catalog, { selections: [], leafPaths: ['Tools & Home Improvement'] }, [], 2000)).toThrow(notAvail);
    expect(() => expandSelections(catalog, sel({ kind: 'taxonomy', path: 'Tools & Home Improvement', includeDescendants: true }), [], 2)).toThrow(expect.objectContaining({ code: 'INVALID_FILTERS' }));
  });
  it('an empty selection means no category scope (all categories), never a failed lookup', () => {
    const out = expandSelections(catalog, { selections: [], leafPaths: [] }, [], 2000);
    expect(out.leaves).toEqual([]);
    expect(out.scope).toEqual({ selections: [], expandedLeafCount: 0, leafSetHash: null, previewPaths: [], previewComplete: true });
  });
});

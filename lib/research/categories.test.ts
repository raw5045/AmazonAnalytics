// lib/research/categories.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// @/lib/env parses process.env at import time (throws on the missing NEXT_PUBLIC_* vars without
// a mock — see lib/research/cursor.test.ts). It's pulled in transitively via ./pool and ./limits
// (loadCategoryCatalog/loadCustomRows/listCustomCandidates now run through the dedicated research
// pool, not a direct db import), so a minimal stub is enough to let the module load. The pure
// functions under test (buildCategoryCatalog/rankCandidates/expandSelections) and the loader tests
// below (which inject a fake CategoryTxRunner) never touch it directly.
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));

import {
  buildCategoryCatalog,
  rankCandidates,
  expandSelections,
  loadCategoryCatalog,
  loadCustomRows,
  listCustomCandidates,
  resolveScope,
  resetCategoryCatalogCacheForTests,
  type CatalogEntry,
  type CategoryTxRunner,
  type CategoryDeps,
} from './categories';
import type { TxClient } from '@/lib/db/tcpPool';

/** Catches and returns a thrown value instead of letting it propagate; fails the test if `fn` doesn't throw. */
function captureError(fn: () => unknown): { message: string; code?: string } {
  try {
    fn();
  } catch (e) {
    return e as { message: string; code?: string };
  }
  throw new Error('expected fn to throw');
}

/** A CategoryTxRunner that hands `fn` a fake TxClient wrapping the given `query` mock — the pool module is never touched. */
function runWith(query: ReturnType<typeof vi.fn>): CategoryTxRunner {
  return async (fn) => fn({ query } as unknown as TxClient);
}

const META = { snapshotVersion: 'snap-1', datasetWeek: '2026-09-12' };
const facets = [
  { categoryPath: 'Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades › Table Lamps', allCount: 120 },
  { categoryPath: 'Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades › Lampshades', allCount: 15 },
  { categoryPath: 'Tools & Home Improvement › Lighting & Ceiling Fans › Outdoor Lighting › Path Lights', allCount: 40 },
  { categoryPath: 'Electronics › Camera & Photo › Lighting & Studio › Continuous Lighting', allCount: 9 },
  { categoryPath: 'Home & Kitchen › Lamps', allCount: 3 },
];
const catalog = buildCategoryCatalog(META, facets);

describe('buildCategoryCatalog', () => {
  it('indexes leaves with counts and parents with descendant counts; the same label under different parents stays distinct (Q07)', () => {
    expect(catalog.byPath.get('Home & Kitchen › Lamps')).toEqual({ path: 'Home & Kitchen › Lamps', terminal: true, keywordCount: 3, descendantLeafCount: 0 });
    expect(catalog.byPath.get('Tools & Home Improvement › Lighting & Ceiling Fans')?.descendantLeafCount).toBe(3);
    expect(catalog.byPath.get('Tools & Home Improvement › Lighting & Ceiling Fans › Lamps & Shades')?.terminal).toBe(false);
    const paths = catalog.entries.map((e) => e.path);
    expect(paths).toEqual([...paths].sort());
  });

  it('carries the snapshot version and dataset week from the meta row', () => {
    expect(catalog.snapshotVersion).toBe('snap-1');
    expect(catalog.datasetWeek).toBe('2026-09-12');
  });

  it('orders by plain code units, not locale collation: NFC and NFD forms of the same visual text are distinct entries in a deterministic order', () => {
    const nfc = 'A › Café'; // 'é' as one code point, U+00E9
    const nfd = 'A › Café'; // 'e' + combining acute accent, U+0301
    expect(nfc).not.toBe(nfd);
    // Motivation (not asserted — host ICU data is not guaranteed, so this would be flaky): on
    // most hosts these two collate as EQUAL under localeCompare, which is exactly why
    // localeCompare is unsafe for deterministic ordering here. The assertions below prove the
    // actual property this module relies on — deterministic code-unit ordering — without
    // depending on any particular collation behavior.
    const cat = buildCategoryCatalog(META, [
      { categoryPath: nfc, allCount: 1 },
      { categoryPath: nfd, allCount: 2 },
    ]);
    const leafPaths = cat.entries.map((e) => e.path).filter((p) => p !== 'A');
    expect(leafPaths).toHaveLength(2);
    expect(new Set(leafPaths).size).toBe(2); // two DISTINCT entries — never merged by the collation-equal sort
    expect(leafPaths).toEqual([nfd, nfc]); // deterministic code-unit order (nfd < nfc), not input order
    expect(cat.byPath.get(nfc)).toMatchObject({ keywordCount: 1 });
    expect(cat.byPath.get(nfd)).toMatchObject({ keywordCount: 2 });
  });

  it('freezes the catalog object, its entries, and every entry so no caller can mutate the shared instance the cache hands to every concurrent caller', () => {
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.entries)).toBe(true);
    expect(Object.isFrozen(catalog.entries[0])).toBe(true);
    expect(() => {
      (catalog as unknown as { snapshotVersion: string }).snapshotVersion = 'zzz';
    }).toThrow(TypeError);
    expect(() => {
      (catalog.entries[0] as unknown as { keywordCount: number | null }).keywordCount = 999;
    }).toThrow(TypeError);
    expect(() => {
      (catalog.entries as unknown as CatalogEntry[]).push({ path: 'zzz', terminal: true, keywordCount: 1, descendantLeafCount: 0 });
    }).toThrow(TypeError);
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
  it('rejects an empty query without a parentPath — the pure function enforces what the input schema also guards at the API boundary (parent §10 forbids a full-taxonomy dump)', () => {
    expect(() => rankCandidates(catalog, { query: '', parentPath: null, offset: 0, limit: 10 })).toThrow(
      expect.objectContaining({ code: 'INVALID_FILTERS', details: [{ path: 'query', message: 'empty' }] }),
    );
    expect(() => rankCandidates(catalog, { query: '   ', parentPath: null, offset: 0, limit: 10 })).toThrow(expect.objectContaining({ code: 'INVALID_FILTERS' }));
  });
  it('an exact full-path match scores 0 even though the label alone does not equal the query, ranking ahead of a full-path substring match', () => {
    const fixture = buildCategoryCatalog(META, [
      { categoryPath: 'Parent › Leaf', allCount: 1 },
      { categoryPath: 'Parent › Leafy', allCount: 2 },
    ]);
    const { candidates, total } = rankCandidates(fixture, { query: 'parent › leaf', parentPath: null, offset: 0, limit: 10 });
    expect(candidates.map((c) => c.path)).toEqual(['Parent › Leaf', 'Parent › Leafy']);
    expect(total).toBe(2);
  });
  it('a multi-token match confined to the label (score 3) ranks ahead of one that only spans the full path (score 5)', () => {
    const fixture = buildCategoryCatalog(META, [
      { categoryPath: 'Dept › Zeta Alpha', allCount: 1 }, // both tokens in the label itself
      { categoryPath: 'Dept Zeta › Gamma Alpha', allCount: 2 }, // "zeta" only in the parent segment
    ]);
    const { candidates, total } = rankCandidates(fixture, { query: 'alpha zeta', parentPath: null, offset: 0, limit: 10 });
    expect(candidates.map((c) => c.path)).toEqual(['Dept › Zeta Alpha', 'Dept Zeta › Gamma Alpha']);
    expect(total).toBe(2);
  });
  it('is case-insensitive', () => {
    const lower = rankCandidates(catalog, { query: 'lamps', parentPath: null, offset: 0, limit: 10 });
    const upper = rankCandidates(catalog, { query: 'LAMPS', parentPath: null, offset: 0, limit: 10 });
    expect(upper).toEqual(lower);
  });
  it('an offset beyond total returns an empty page with the correct total', () => {
    const { candidates, total } = rankCandidates(catalog, { query: 'lamps', parentPath: null, offset: 999, limit: 10 });
    expect(candidates).toEqual([]);
    expect(total).toBe(4);
  });
});

describe('sibling and cross-branch discrimination (a dedicated mini-fixture so the shared ranking fixture/expectations above stay untouched)', () => {
  const sib = buildCategoryCatalog(META, [
    { categoryPath: 'Home & Kitchen › Lamps', allCount: 3 }, // terminal AND parent
    { categoryPath: 'Home & Kitchen › Lamps › Desk Lamps', allCount: 2 },
    { categoryPath: 'Home & Kitchen › Lampshades', allCount: 5 }, // text-prefix sibling
    { categoryPath: 'Electronics › Camera & Photo › Lighting & Studio › Lamps', allCount: 7 }, // same label, other parent
  ]);

  it('"Home & Kitchen › Lamps" is both terminal and a parent, with exactly its one real descendant', () => {
    expect(sib.byPath.get('Home & Kitchen › Lamps')).toEqual({
      path: 'Home & Kitchen › Lamps',
      terminal: true,
      keywordCount: 3,
      descendantLeafCount: 1,
    });
  });

  it('expanding it with includeDescendants pulls in only its real descendant, never the text-prefix sibling "Lampshades"', () => {
    const out = expandSelections(sib, { selections: [{ kind: 'taxonomy', path: 'Home & Kitchen › Lamps', includeDescendants: true }], leafPaths: [] }, [], 2000);
    expect(out.leaves).toEqual(['Home & Kitchen › Lamps', 'Home & Kitchen › Lamps › Desk Lamps']);
  });

  it('the same label under two different parents ranks as two distinct candidates with their own counts and selections', () => {
    const { candidates } = rankCandidates(sib, { query: 'lamps', parentPath: null, offset: 0, limit: 50 });
    const home = candidates.find((c) => c.path === 'Home & Kitchen › Lamps');
    const electronics = candidates.find((c) => c.path === 'Electronics › Camera & Photo › Lighting & Studio › Lamps');
    expect(home).toBeDefined();
    expect(electronics).toBeDefined();
    expect(home).not.toBe(electronics);
    expect(home).toMatchObject({ terminal: true, keywordCount: 3, descendantLeafCount: 1 });
    expect(home!.selection).toEqual({ kind: 'taxonomy', path: 'Home & Kitchen › Lamps', includeDescendants: true });
    expect(electronics).toMatchObject({ terminal: true, keywordCount: 7, descendantLeafCount: 0 });
    expect(electronics!.selection).toEqual({ kind: 'taxonomy', path: 'Electronics › Camera & Photo › Lighting & Studio › Lamps', includeDescendants: false });
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
  it('pinpoints the offending selections[i]/leafPaths[i] index in CATEGORY_NOT_AVAILABLE details', () => {
    expect(() =>
      expandSelections(catalog, {
        selections: [
          { kind: 'taxonomy', path: 'Home & Kitchen › Lamps', includeDescendants: false }, // valid — index 0
          { kind: 'taxonomy', path: 'Made Up', includeDescendants: true }, // invalid — index 1
        ],
        leafPaths: [],
      }, [], 2000),
    ).toThrow(expect.objectContaining({ code: 'CATEGORY_NOT_AVAILABLE', details: [{ path: 'filters.categories.selections[1]', message: 'not_available' }] }));
    expect(() => expandSelections(catalog, { selections: [], leafPaths: ['Home & Kitchen › Lamps', 'Nope'] }, [], 2000)).toThrow(
      expect.objectContaining({ code: 'CATEGORY_NOT_AVAILABLE', details: [{ path: 'filters.categories.leafPaths[1]', message: 'not_available' }] }),
    );
  });
  it('never echoes a custom id in the error message — unknown, foreign, and empty ids stay indistinguishable (Q08)', () => {
    const unknown = captureError(() => expandSelections(catalog, { selections: [{ kind: 'custom', id: '22222222-2222-4222-8222-222222222222' }], leafPaths: [] }, custom, 2000));
    const empty = captureError(() => expandSelections(catalog, { selections: [{ kind: 'custom', id: custom[0].id }], leafPaths: [] }, [{ id: custom[0].id, leafPaths: [] }], 2000));
    expect(unknown.message).toBe(empty.message);
    expect(unknown.message).not.toContain('22222222-2222-4222-8222-222222222222');
    expect(empty.message).not.toContain(custom[0].id);
  });
  it('a custom category with one live and one dead path (weekly catalog rotation) expands only the live leaf', () => {
    const mixed = [{ id: custom[0].id, leafPaths: ['Home & Kitchen › Lamps', 'Extinct › Category › Gone'] }];
    const out = expandSelections(catalog, { selections: [{ kind: 'custom', id: custom[0].id }], leafPaths: [] }, mixed, 2000);
    expect(out.leaves).toEqual(['Home & Kitchen › Lamps']);
  });
  it('a custom category whose paths are all dead (none in the current catalog) is CATEGORY_NOT_AVAILABLE with a specific message', () => {
    const dead = [{ id: custom[0].id, leafPaths: ['Extinct › Category › Gone', 'Another › Dead › One'] }];
    expect(() => expandSelections(catalog, { selections: [{ kind: 'custom', id: custom[0].id }], leafPaths: [] }, dead, 2000)).toThrow(
      expect.objectContaining({ code: 'CATEGORY_NOT_AVAILABLE', message: 'None of the paths in that custom category have keywords in the current dataset.' }),
    );
  });
});

describe('loadCategoryCatalog', () => {
  beforeEach(() => resetCategoryCatalogCacheForTests());

  const SNAP_A_ROWS = [
    { sv: 'snap-a', week: '2026-09-12', category_path: 'A', all_count: 5 },
    { sv: 'snap-a', week: '2026-09-12', category_path: 'A › B', all_count: 3 },
  ];
  const SNAP_B_ROWS = [{ sv: 'snap-b', week: '2026-09-19', category_path: 'C', all_count: 7 }];
  const NO_FACETS_YET_ROW = [{ sv: 'snap-a', week: '2026-09-12', category_path: null, all_count: null }];
  const NO_FACETS_YET_ROW_SNAP_B = [{ sv: 'snap-b', week: '2026-09-19', category_path: null, all_count: null }];

  it('serves the cached catalog within the TTL without querying', async () => {
    const query = vi.fn(async () => ({ rows: SNAP_A_ROWS }));
    const run = runWith(query);
    const first = await loadCategoryCatalog(1000, run);
    const second = await loadCategoryCatalog(1000 + 59_000, run); // < 60s later
    expect(second).toBe(first);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('past the TTL with an unchanged snapshot version but rewritten facets (Keepa sync rebuilds them in place), rebuilds from the fresh rows', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: SNAP_A_ROWS })
      .mockResolvedValueOnce({ rows: [...SNAP_A_ROWS, { sv: 'snap-a', week: '2026-09-12', category_path: 'A › C', all_count: 9 }] });
    const run = runWith(query);
    const first = await loadCategoryCatalog(0, run);
    expect(first.byPath.has('A › C')).toBe(false);
    const second = await loadCategoryCatalog(60_001, run);
    expect(second.snapshotVersion).toBe('snap-a');
    expect(second.byPath.get('A › C')).toMatchObject({ terminal: true, keywordCount: 9 });
    const third = await loadCategoryCatalog(60_001 + 59_000, run);
    expect(third).toBe(second);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('past the TTL with a changed snapshot version, rebuilds a new catalog object with the new snapshotVersion/datasetWeek', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: SNAP_A_ROWS }).mockResolvedValueOnce({ rows: SNAP_B_ROWS });
    const run = runWith(query);
    const first = await loadCategoryCatalog(0, run);
    const second = await loadCategoryCatalog(60_001, run);
    expect(second).not.toBe(first);
    expect(second.snapshotVersion).toBe('snap-b');
    expect(second.datasetWeek).toBe('2026-09-19');
  });

  it('no rows (meta truncated) throws DATA_UNAVAILABLE, never falling back to a previously cached catalog', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: SNAP_A_ROWS }).mockResolvedValueOnce({ rows: [] });
    const run = runWith(query);
    await loadCategoryCatalog(0, run);
    await expect(loadCategoryCatalog(60_001, run)).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE', retryable: true });
  });

  it('a single meta row with no facets yet throws DATA_UNAVAILABLE and caches nothing, so the next call queries again', async () => {
    const query = vi.fn(async () => ({ rows: NO_FACETS_YET_ROW }));
    const run = runWith(query);
    await expect(loadCategoryCatalog(0, run)).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE', retryable: true });
    await expect(loadCategoryCatalog(1, run)).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    expect(query).toHaveBeenCalledTimes(2); // no caching short-circuit between the two failing calls
  });

  it('zero facets mid-Keepa-sync (DELETE→INSERT window) with a cached catalog for the SAME snapshot version serves the cached catalog instead of throwing', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: SNAP_A_ROWS })
      .mockResolvedValueOnce({ rows: NO_FACETS_YET_ROW }); // same sv ('snap-a'), facets table momentarily empty
    const run = runWith(query);
    const first = await loadCategoryCatalog(0, run);
    const second = await loadCategoryCatalog(60_001, run); // past TTL, mid-rebuild
    expect(second).toBe(first); // served from cache, not rebuilt, and does not throw
    expect(query).toHaveBeenCalledTimes(2);
    const third = await loadCategoryCatalog(60_001 + 59_000, run); // within TTL of the refreshed `at`
    expect(third).toBe(first);
    expect(query).toHaveBeenCalledTimes(2); // no further query — TTL was refreshed when the cache was served
  });

  it('zero facets with a cached catalog for a DIFFERENT snapshot version throws and does not serve the stale catalog', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: SNAP_A_ROWS }) // caches snap-a
      .mockResolvedValueOnce({ rows: NO_FACETS_YET_ROW_SNAP_B }); // now snap-b, but its facets aren't in yet
    const run = runWith(query);
    await loadCategoryCatalog(0, run);
    await expect(loadCategoryCatalog(60_001, run)).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE', retryable: true });
  });

  it('a runner timeout surfaces as QUERY_TIMEOUT, retryable', async () => {
    const timeoutRun: CategoryTxRunner = async () => 'timeout';
    await expect(loadCategoryCatalog(0, timeoutRun)).rejects.toMatchObject({ code: 'QUERY_TIMEOUT', retryable: true });
  });

  it('a runner that throws propagates the raw error, never wrapped into DATA_UNAVAILABLE/QUERY_TIMEOUT (withReadOnlyTx rejects raw on a connect-queue timeout — see lib/db/tcpPool.ts)', async () => {
    const throwingRun: CategoryTxRunner = async () => {
      throw new Error('boom');
    };
    await expect(loadCategoryCatalog(0, throwingRun)).rejects.toThrow('boom');
  });
});

describe('loadCustomRows', () => {
  it('queries by user and ids, filtering non-string jsonb elements', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'c1', leaf_paths: ['A › B', 42, null, 'A › C'] }] }));
    const run = runWith(query);
    const rows = await loadCustomRows('u1', ['c1'], run);
    expect(query).toHaveBeenCalledWith('SELECT id, leaf_paths FROM custom_categories WHERE user_id = $1 AND id = ANY($2::uuid[])', ['u1', ['c1']]);
    expect(rows).toEqual([{ id: 'c1', leafPaths: ['A › B', 'A › C'] }]);
  });
  it('short-circuits on empty ids without querying', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const run = runWith(query);
    expect(await loadCustomRows('u1', [], run)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
  it('a runner timeout surfaces as QUERY_TIMEOUT, retryable', async () => {
    const timeoutRun: CategoryTxRunner = async () => 'timeout';
    await expect(loadCustomRows('u1', ['c1'], timeoutRun)).rejects.toMatchObject({ code: 'QUERY_TIMEOUT', retryable: true });
  });
});

describe('listCustomCandidates', () => {
  it('selects a leaf count instead of leaf_paths, and orders by name then id', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'c1', name: 'My niche', leaf_count: 5 }] }));
    const run = runWith(query);
    const candidates = await listCustomCandidates('u1', '50% off_', run);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("CASE WHEN jsonb_typeof(leaf_paths) = 'array' THEN jsonb_array_length(leaf_paths) ELSE 0 END");
    // "leaf_paths" appears exactly twice — inside jsonb_typeof(...) and jsonb_array_length(...) — never selected as its own column.
    expect(sql.split('leaf_paths').length - 1).toBe(2);
    expect(sql).toContain('ORDER BY name, id');
    expect(params).toEqual(['u1', '%50\\% off\\_%']);
    expect(candidates).toEqual([{ kind: 'custom', label: 'My niche', path: null, id: 'c1', terminal: true, descendantLeafCount: 5, keywordCount: null, selection: { kind: 'custom', id: 'c1' } }]);
  });
  it('omits the ILIKE clause and its param for an empty query', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const run = runWith(query);
    await listCustomCandidates('u1', '', run);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).not.toContain('ILIKE');
    expect(params).toEqual(['u1']);
  });
  it('a runner timeout surfaces as QUERY_TIMEOUT, retryable', async () => {
    const timeoutRun: CategoryTxRunner = async () => 'timeout';
    await expect(listCustomCandidates('u1', 'x', timeoutRun)).rejects.toMatchObject({ code: 'QUERY_TIMEOUT', retryable: true });
  });
});

describe('resolveScope', () => {
  it('loads the catalog, resolves only the custom ids referenced in selections for this actor, and stamps the catalog snapshot/week', async () => {
    const zCatalog = buildCategoryCatalog({ snapshotVersion: 'snap-z', datasetWeek: '2026-09-12' }, [{ categoryPath: 'A › B', allCount: 1 }]);
    const loadCustomRowsSpy = vi.fn(async () => [{ id: 'custom-1', leafPaths: ['A › B'] }]);
    const deps: CategoryDeps = {
      loadCatalog: async () => zCatalog,
      loadCustomRows: loadCustomRowsSpy,
      listCustom: async () => [],
    };
    const out = await resolveScope('user-1', {
      selections: [
        { kind: 'taxonomy', path: 'A › B', includeDescendants: false },
        { kind: 'custom', id: 'custom-1' },
      ],
      leafPaths: [],
    }, 2000, deps);
    expect(loadCustomRowsSpy).toHaveBeenCalledWith('user-1', ['custom-1']);
    expect(out.snapshotVersion).toBe('snap-z');
    expect(out.datasetWeek).toBe('2026-09-12');
    expect(out.leaves).toEqual(['A › B']);
  });
});

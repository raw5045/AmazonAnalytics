// lib/research/service.test.ts
import { describe, it, expect, vi } from 'vitest';
// @/lib/env parses process.env at import time (see lib/research/cursor.test.ts /
// lib/research/usage.test.ts); this is the first lib/research/*.test.ts file whose subject
// (service.ts) transitively imports ./usage, which imports @/db/client — createDb() there
// calls neon(env.DATABASE_URL) EAGERLY at module load (unlike every other research loader,
// which only calls neon() lazily inside a function body), so a non-URL-shaped DATABASE_URL
// throws just from importing the module graph. Both are mocked so importing this test file
// never touches a real database.
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test', APP_PUBLIC_URL: 'https://keywordquarry.com', CLERK_SECRET_KEY: 'sk_test' } }));
vi.mock('@/db/client', () => ({ db: {} }));

import { createResearchService, type ResearchActor, type ResearchServiceDeps } from './service';
import { buildCategoryCatalog } from './categories';
import { DEFAULT_LIMITS } from './limits';
import { signCursor, verifyCursor } from './cursor';
import type { RawSearchRow } from './query';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'client_claude', channel: 'mcp' };
const META = { currentWeekEndDate: '2026-09-12', snapshotVersion: 'snap-a', refreshedAt: '2026-09-13T06:00:00.000Z', volumeFitRunId: null, calibrationMonthEndDate: null, isExtrapolated: false };
// C1: buildCategoryCatalog's first argument is now { snapshotVersion, datasetWeek } (lib/research/categories.ts), not a bare snapshot string.
const catalog = buildCategoryCatalog({ snapshotVersion: 'snap-a', datasetWeek: '2026-09-12' }, [{ categoryPath: 'A › B', allCount: 10 }, { categoryPath: 'A › C', allCount: 5 }]);
const raw = (i: number): RawSearchRow => ({
  search_term_id: `id-${i}`, search_term_raw: `kw ${i}`, first_seen_week: '2025-01-04', last_seen_week: '2026-09-12', current_rank: i,
  estimated_monthly_volume_current: String(100000 - i), avg_reviews: 100, word_count: 2, top_clicked_category_path: 'A › B', top_clicked_category_1_current: 'A',
  fake_volume_severity_current: null, prior_rank: null, prior_volume_raw: null, volume_delta: null,
  keyword_in_title_1_loose_current: null, keyword_in_title_2_loose_current: null, keyword_in_title_3_loose_current: null,
  keyword_in_title_1_current: null, keyword_in_title_2_current: null, keyword_in_title_3_current: null,
});

function makeDeps(over: Partial<ResearchServiceDeps> = {}) {
  const deps: ResearchServiceDeps = {
    pool: {} as never,
    limits: { ...DEFAULT_LIMITS },
    appUrl: 'https://keywordquarry.com',
    cursorSecret: 'test-secret',
    audience: () => 'admin',
    now: () => new Date('2026-09-21T12:00:00Z'),
    reserve: vi.fn(async () => ({ requests: 1, rows: 50 })),
    record: vi.fn(),
    categories: { loadCatalog: async () => catalog, loadCustomRows: async () => [], listCustom: async () => [] },
    details: { appUrl: 'https://keywordquarry.com', header: async () => null, products: async () => ({ currentWeekProductSlots: [], enrichedProductsByAsin: {} }), summary: async () => null, meta: async () => META },
    history: { fetchFits: async () => [] },
    meta: async () => META,
    runSearch: vi.fn(async (_pool, _t, compile) => ({ meta: META, rows: Array.from({ length: 51 }, (_, i) => raw(i + 1)), compiled: compile(META) })),
    countMatches: vi.fn(async () => ({ kind: 'exact' as const, value: 137 })),
    ...over,
  };
  return deps;
}

describe('search: a new request', () => {
  it('reserves the page, resolves scope, runs with the meta week, pages with a signed cursor, and records rows', async () => {
    const deps = makeDeps();
    const svc = createResearchService(deps);
    const res = await svc.search(actor, { schemaVersion: 1, filters: { estimatedMonthlySearches: { gt: 10000 }, categories: { selections: [{ kind: 'taxonomy', path: 'A', includeDescendants: true }] } } });
    expect(deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', channel: 'mcp', rows: 50 }));
    expect(res.rows).toHaveLength(50);
    expect(res.rows[0]).toMatchObject({ searchTermId: 'id-1', keyword: 'kw 1', estimatedMonthlySearches: 99999, keywordUrl: 'https://keywordquarry.com/explorer/keyword/id-1' });
    expect(res.resolvedCategoryScope).toMatchObject({ expandedLeafCount: 2, previewPaths: ['A › B', 'A › C'] });
    expect(res.pagination).toMatchObject({ pageSize: 50, returnedCount: 50, offset: 0, totalMatches: { kind: 'exact', value: 137 }, capped: false, capReason: null });
    expect(res.pagination.expiresAt).toBe('2026-09-21T12:15:00.000Z');
    const cursor = verifyCursor(res.pagination.nextCursor!, 'test-secret', 0);
    expect(cursor).toMatchObject({ off: 50, ps: 50, snap: 'snap-a', uid: 'u1', ch: 'mcp', tm: { kind: 'exact', value: 137 } });
    expect(res.provenance).toMatchObject({ datasetWeek: '2026-09-12', snapshotVersion: 'snap-a', guideVersion: 1, queryVersion: 1 });
    expect(res.warnings.map((w) => w.code)).toEqual(['ESTIMATED_VOLUME', 'LIVE_PAGINATION']);
    expect(deps.record).toHaveBeenCalledWith('u1', 50);
    const call = (deps.runSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[3]).toEqual({ expectedSnapshot: null });
    expect(call[1]).toBe(DEFAULT_LIMITS.sqlTimeoutMs);
    // C2: countMatches now takes { expectedSnapshot } too — the service counts against the
    // EXACT snapshot the just-completed search actually ran on (run.meta.snapshotVersion),
    // not blindly, so a snapshot swap between the search and the count is caught as `unknown`
    // rather than counting a different population than what the rows came from.
    const countCall = (deps.countMatches as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(countCall[3]).toEqual({ expectedSnapshot: 'snap-a' });
  });
  it('rate limiting stops everything before any scope or query work', async () => {
    const deps = makeDeps({ reserve: vi.fn(async () => { throw Object.assign(new Error('slow'), { code: 'RATE_LIMITED' }); }) });
    await expect(createResearchService(deps).search(actor, { schemaVersion: 1 })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(deps.runSearch).not.toHaveBeenCalled();
  });
  it('an invalid request never reserves', async () => {
    const deps = makeDeps();
    await expect(createResearchService(deps).search(actor, { schemaVersion: 1, pageSize: 500 })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
    expect(deps.reserve).not.toHaveBeenCalled();
  });
  it('C7: classifies a pool connect-queue timeout as retryable DATA_UNAVAILABLE, and rethrows any other raw error unchanged', async () => {
    const timeoutErr = new Error('timeout exceeded when trying to connect');
    const deps1 = makeDeps({ runSearch: vi.fn(async () => { throw timeoutErr; }) });
    await expect(createResearchService(deps1).search(actor, { schemaVersion: 1 })).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE', retryable: true, retryAfterSeconds: 5 });

    const boom = new Error('boom');
    const deps2 = makeDeps({ runSearch: vi.fn(async () => { throw boom; }) });
    await expect(createResearchService(deps2).search(actor, { schemaVersion: 1 })).rejects.toBe(boom);
  });
});

describe('search: continuation and caps', () => {
  it('a cursor re-runs the same request at its offset against the same snapshot without recounting', async () => {
    const deps = makeDeps();
    const svc = createResearchService(deps);
    const first = await svc.search(actor, { schemaVersion: 1, filters: { averageReviews: { lt: 500 } } });
    const second = await svc.search(actor, { cursor: first.pagination.nextCursor });
    expect(deps.countMatches).toHaveBeenCalledTimes(1);
    const call = (deps.runSearch as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(call[3]).toEqual({ expectedSnapshot: 'snap-a' });
    expect(second.pagination.offset).toBe(50);
    expect(second.appliedFilters.averageReviews).toEqual({ lt: 500 });
    expect(second.pagination.totalMatches).toEqual({ kind: 'exact', value: 137 });
  });
  it("another account's cursor is INVALID_CURSOR", async () => {
    const deps = makeDeps();
    const foreign = signCursor({ v: 1, req: { schemaVersion: 1, presetIds: [], filters: {} as never, sort: { field: 'rank', direction: 'asc' }, pageSize: 50 } as never, snap: 'snap-a', off: 50, ps: 50, exp: 9_999_999_999, uid: 'someone-else', ch: 'mcp', tm: { kind: 'unknown', value: null } }, 'test-secret');
    await expect(createResearchService(deps).search(actor, { cursor: foreign })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
  it('stops at 1,000 reachable rows with capReason max_rows and no cursor (Q23)', async () => {
    const deps = makeDeps({ limits: { ...DEFAULT_LIMITS, maxRowsPerSearch: 120 } });
    const svc = createResearchService(deps);
    const first = await svc.search(actor, { schemaVersion: 1, pageSize: 50 });
    expect(first.pagination).toMatchObject({ returnedCount: 50, capped: false });
    const cursor = signCursor({ ...verifyCursor(first.pagination.nextCursor!, 'test-secret', 0), off: 100 }, 'test-secret');
    const last = await svc.search(actor, { cursor });
    expect(last.pagination).toMatchObject({ offset: 100, returnedCount: 20, capped: true, capReason: 'max_rows', nextCursor: null });
    expect(last.warnings.map((w) => w.code)).toContain('RESULTS_CAPPED');
  });
  it('shrinks a page that would exceed the payload budget and advances by the rows actually returned (Q39)', async () => {
    const deps = makeDeps({ limits: { ...DEFAULT_LIMITS, maxPayloadBytes: 6000 } });
    const res = await createResearchService(deps).search(actor, { schemaVersion: 1 });
    expect(res.pagination.returnedCount).toBeLessThan(50);
    expect(res.pagination.returnedCount).toBeGreaterThan(0);
    expect(res.pagination.capReason).toBe('payload');
    expect(verifyCursor(res.pagination.nextCursor!, 'test-secret', 0).off).toBe(res.pagination.returnedCount);
    expect(Buffer.byteLength(JSON.stringify(res))).toBeLessThanOrEqual(6000);
    await expect(createResearchService(makeDeps({ limits: { ...DEFAULT_LIMITS, maxPayloadBytes: 200 } })).search(actor, { schemaVersion: 1 })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
  it('C5: a cursor too large to sign still returns the already-computed page, capped at payload with a warning — never discarded', async () => {
    // 60 leaf paths of ~140 chars: small enough for categoriesSchema (max 256 chars, max 2000
    // entries) and for the response payload budget (well under the 256 KB default), but large
    // enough that embedding the full request (including these paths) into the NEXT cursor's
    // signed token pushes it past cursor.ts's own MAX_CURSOR_LENGTH (8192).
    const leafPaths = Array.from({ length: 60 }, (_, i) => `Leaf-${String(i).padStart(3, '0')}-${'x'.repeat(130)}`);
    const bigCatalog = buildCategoryCatalog(
      { snapshotVersion: 'snap-a', datasetWeek: '2026-09-12' },
      leafPaths.map((p) => ({ categoryPath: p, allCount: 1 })),
    );
    const deps = makeDeps({ categories: { loadCatalog: async () => bigCatalog, loadCustomRows: async () => [], listCustom: async () => [] } });
    const res = await createResearchService(deps).search(actor, { schemaVersion: 1, filters: { categories: { leafPaths } } });
    expect(res.rows).toHaveLength(50);
    expect(res.pagination.nextCursor).toBeNull();
    expect(res.pagination.capped).toBe(true);
    expect(res.pagination.capReason).toBe('payload');
    expect(res.pagination.expiresAt).toBeNull();
    expect(res.warnings.map((w) => w.code)).toContain('CURSOR_TOO_LARGE');
    expect(deps.record).toHaveBeenCalledWith('u1', 50);
  });
});

describe('the other tools', () => {
  it('resolveCategories mixes ranked taxonomy candidates with the account’s custom categories and pages the taxonomy part', async () => {
    const deps = makeDeps({ categories: { loadCatalog: async () => catalog, loadCustomRows: async () => [], listCustom: async () => [{ kind: 'custom', label: 'My niche', path: null, id: '11111111-1111-4111-8111-111111111111', terminal: true, descendantLeafCount: null, keywordCount: null, selection: { kind: 'custom', id: '11111111-1111-4111-8111-111111111111' } }] } });
    const svc = createResearchService(deps);
    const res = await svc.resolveCategories(actor, { query: 'a', limit: 1 });
    expect(res.candidates.map((c) => c.label)).toEqual(['A', 'My niche']);
    expect(res.totalCandidates).toBe(4);
    expect(res.nextCursor).toBe('1');
    expect(res.noMatch).toBe(false);
    // C4: provenance comes from the catalog (loadCategoryCatalog's own datasetWeek/snapshotVersion), never a `?? ''` fallback off a separate deps.meta() read.
    expect(res.provenance).toEqual({ datasetWeek: '2026-09-12', snapshotVersion: 'snap-a' });
    const page2 = await svc.resolveCategories(actor, { query: 'a', limit: 1, cursor: res.nextCursor });
    expect(page2.candidates.map((c) => c.label)).toEqual(['A › B']);
    expect(deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ rows: 0 }));
    await expect(svc.resolveCategories(actor, { query: 'a', cursor: 'zzz' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    expect((await svc.resolveCategories(actor, { query: 'zzzz', source: 'taxonomy' })).noMatch).toBe(true);
  });
  it('details and history validate, reserve, delegate, and record', async () => {
    const details = vi.fn(async () => ({ searchTermId: 'x', keyword: 'x', keywordUrl: 'u', status: 'dormant' as const, firstSeenWeek: 'a', lastSeenWeek: 'b', current: null, products: [], provenance: { datasetWeek: '', snapshotVersion: '', resultCapturedAt: '' }, warnings: [] }));
    const history = vi.fn(async () => ({ searchTermId: 'x', keyword: 'x', windowStart: 'a', windowEnd: 'b', requestedWeeks: 4, points: [{ weekEndDate: 'b', rank: 1, estimatedMonthlySearches: null, volumeIsExtrapolated: false, severity: null }], missingWeeks: [], source: 'chart_series' as const, seriesUpdatedAt: null, warnings: [] }));
    const deps = makeDeps({ loadDetails: details, loadHistory: history } as Partial<ResearchServiceDeps>);
    const svc = createResearchService(deps);
    await svc.details(actor, { searchTermId: '11111111-1111-4111-8111-111111111111' });
    expect(deps.record).toHaveBeenCalledWith('u1', 1);
    await svc.history(actor, { searchTermId: '11111111-1111-4111-8111-111111111111', weeks: 4 });
    expect(history).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 4, expect.objectContaining({ timeoutMs: DEFAULT_LIMITS.sqlTimeoutMs }));
    expect(deps.record).toHaveBeenCalledWith('u1', 1);
    await expect(svc.details(actor, { searchTermId: 'nope' })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
  });
  it('guide reports the dataset week and audience, and reserves without rows', async () => {
    const deps = makeDeps({ audience: () => 'all' });
    const g = await createResearchService(deps).guide(actor);
    expect(g).toMatchObject({ datasetWeek: '2026-09-12', audience: 'all' });
    expect(deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ rows: 0 }));
  });
});

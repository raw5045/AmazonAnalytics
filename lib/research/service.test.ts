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
// M10: defaultResearchService() (via defaultResearchDeps()) calls getResearchPool() eagerly;
// stub it so building the default service never constructs a real pg.Pool.
vi.mock('./pool', () => ({ getResearchPool: () => ({}) }));

import { createResearchService, defaultResearchService, resetResearchServiceForTests, type ResearchActor, type ResearchServiceDeps } from './service';
import { buildCategoryCatalog } from './categories';
import { DEFAULT_LIMITS } from './limits';
import { signCursor, verifyCursor } from './cursor';
import { ResearchError, searchExpiredError } from './errors';
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
    // M7: a real ResearchError, as reserve() actually throws — not an ad-hoc Error/code shape.
    const deps = makeDeps({ reserve: vi.fn(async () => { throw new ResearchError('RATE_LIMITED', 'slow', { retryable: true, retryAfterSeconds: 30 }); }) });
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
    // I2: poolBusyError()'s own message — never dataUnavailableError's "dataset is being
    // refreshed" wording, which would misstate a busy pool as a missing snapshot.
    await expect(createResearchService(deps1).search(actor, { schemaVersion: 1 })).rejects.toMatchObject({
      code: 'DATA_UNAVAILABLE', retryable: true, retryAfterSeconds: 5, message: 'KeywordQuarry is busy right now; try again in a few seconds.',
    });

    const boom = new Error('boom');
    const deps2 = makeDeps({ runSearch: vi.fn(async () => { throw boom; }) });
    await expect(createResearchService(deps2).search(actor, { schemaVersion: 1 })).rejects.toBe(boom);
  });
  it('I4c: an extrapolated volume fit produces EXTRAPOLATED_VOLUME with the details.ts wording, and marks provenance', async () => {
    const extrapMeta = { ...META, isExtrapolated: true };
    const deps = makeDeps({ runSearch: vi.fn(async (_pool, _t, compile) => ({ meta: extrapMeta, rows: Array.from({ length: 51 }, (_, i) => raw(i + 1)), compiled: compile(extrapMeta) })) });
    const res = await createResearchService(deps).search(actor, { schemaVersion: 1 });
    expect(res.warnings).toContainEqual({
      code: 'EXTRAPOLATED_VOLUME',
      message: 'The dataset week predates every calibration month, so this volume estimate applies the earliest calibration fit backward in time; treat it as directional.',
    });
    expect(res.provenance.volumeIsExtrapolated).toBe(true);
  });
  it('I4d: a SEARCH_EXPIRED thrown by runSearch propagates unchanged, and record is never called', async () => {
    const err = searchExpiredError('snapshot_changed');
    const deps = makeDeps({ runSearch: vi.fn(async () => { throw err; }) });
    await expect(createResearchService(deps).search(actor, { schemaVersion: 1 })).rejects.toBe(err);
    expect(deps.record).not.toHaveBeenCalled();
  });
  it('S1: page one returning fewer rows than the page size proves the total without a count query', async () => {
    const deps = makeDeps({ runSearch: vi.fn(async (_pool, _t, compile) => ({ meta: META, rows: [raw(1), raw(2), raw(3)], compiled: compile(META) })) });
    const res = await createResearchService(deps).search(actor, { schemaVersion: 1 });
    expect(deps.countMatches).not.toHaveBeenCalled();
    expect(res.pagination.totalMatches).toEqual({ kind: 'exact', value: 3 });
    expect(res.pagination.returnedCount).toBe(3);
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
  it('I4e: an expired cursor is SEARCH_EXPIRED, and never reserves', async () => {
    const deps = makeDeps();
    const expired = signCursor({ v: 1, req: { schemaVersion: 1, presetIds: [], filters: {} as never, sort: { field: 'rank', direction: 'asc' }, pageSize: 50 } as never, snap: 'snap-a', off: 50, ps: 50, exp: 1_000_000_000, uid: 'u1', ch: 'mcp', tm: { kind: 'unknown', value: null } }, 'test-secret');
    await expect(createResearchService(deps).search(actor, { cursor: expired })).rejects.toMatchObject({ code: 'SEARCH_EXPIRED' });
    expect(deps.reserve).not.toHaveBeenCalled();
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
    // I1: the page WAS actually shortened by the halving loop, so PAYLOAD_LIMITED fires, and
    // since a nextCursor exists here, its message carries the "cursor continues" clause.
    expect(res.warnings).toContainEqual({
      code: 'PAYLOAD_LIMITED',
      message: 'This page was shortened to fit the response size limit; the cursor continues from the last row returned.',
    });
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
    // I1: the page itself was never shortened (still 50 full rows, asserted above) — only the
    // cursor was dropped — so PAYLOAD_LIMITED must NOT fire; it would contradict nextCursor: null
    // by claiming "the cursor continues from the last row returned".
    expect(res.warnings.map((w) => w.code)).not.toContain('PAYLOAD_LIMITED');
    expect(deps.record).toHaveBeenCalledWith('u1', 50);
  });
  it('I1: halving AND a too-large cursor together report PAYLOAD_LIMITED (without the cursor clause) alongside CURSOR_TOO_LARGE', async () => {
    // Same oversized leafPaths as C5 (cursor never signs), but with maxPayloadBytes small
    // enough that the response itself — dominated by those same leafPaths, echoed back in
    // appliedFilters — also needs the halving loop to run at least once. So this response
    // is BOTH actually shortened (pageShortened: true) AND has its cursor dropped for size;
    // PAYLOAD_LIMITED must fire (the page really was cut) but without the "cursor continues"
    // clause (there is no cursor — cursorTooLarge forced nextCursor to null).
    const leafPaths = Array.from({ length: 60 }, (_, i) => `Leaf-${String(i).padStart(3, '0')}-${'x'.repeat(130)}`);
    const bigCatalog = buildCategoryCatalog(
      { snapshotVersion: 'snap-a', datasetWeek: '2026-09-12' },
      leafPaths.map((p) => ({ categoryPath: p, allCount: 1 })),
    );
    const deps = makeDeps({
      categories: { loadCatalog: async () => bigCatalog, loadCustomRows: async () => [], listCustom: async () => [] },
      limits: { ...DEFAULT_LIMITS, maxPayloadBytes: 15000 },
    });
    const res = await createResearchService(deps).search(actor, { schemaVersion: 1, filters: { categories: { leafPaths } } });
    expect(res.rows.length).toBeLessThan(50);
    expect(res.pagination.nextCursor).toBeNull();
    expect(res.pagination.capReason).toBe('payload');
    expect(res.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['PAYLOAD_LIMITED', 'CURSOR_TOO_LARGE']));
    expect(res.warnings).toContainEqual({ code: 'PAYLOAD_LIMITED', message: 'This page was shortened to fit the response size limit.' });
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
    // I3: resolveCategories now records a request too (RESERVE_NO_ROWS), same as guide — every
    // accepted tool call must bump Task 17's mcp_request counter, not just search/details/history.
    expect(deps.record).toHaveBeenCalledWith('u1', 0);
    await expect(svc.resolveCategories(actor, { query: 'a', cursor: 'zzz' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    expect((await svc.resolveCategories(actor, { query: 'zzzz', source: 'taxonomy' })).noMatch).toBe(true);
  });
  it('details and history validate, reserve, delegate, and record', async () => {
    const details = vi.fn(async () => ({ searchTermId: 'x', keyword: 'x', keywordUrl: 'u', status: 'dormant' as const, firstSeenWeek: 'a', lastSeenWeek: 'b', current: null, products: [], provenance: { datasetWeek: '', snapshotVersion: '', resultCapturedAt: '' }, warnings: [] }));
    // I4a: 2 points, distinct from details' 1-row record, so the two record() calls can't be
    // confused by asserting the same ('u1', 1) shape for both.
    const history = vi.fn(async () => ({ searchTermId: 'x', keyword: 'x', windowStart: 'a', windowEnd: 'b', requestedWeeks: 4, points: [{ weekEndDate: 'a', rank: 2, estimatedMonthlySearches: null, volumeIsExtrapolated: false, severity: null }, { weekEndDate: 'b', rank: 1, estimatedMonthlySearches: null, volumeIsExtrapolated: false, severity: null }], missingWeeks: [], source: 'chart_series' as const, seriesUpdatedAt: null, warnings: [] }));
    const deps = makeDeps({ loadDetails: details, loadHistory: history } as Partial<ResearchServiceDeps>);
    const svc = createResearchService(deps);
    await svc.details(actor, { searchTermId: '11111111-1111-4111-8111-111111111111' });
    // I4b: details reserves rows: 1.
    expect(deps.reserve).toHaveBeenNthCalledWith(1, expect.objectContaining({ rows: 1 }));
    expect(deps.record).toHaveBeenNthCalledWith(1, 'u1', 1);
    await svc.history(actor, { searchTermId: '11111111-1111-4111-8111-111111111111', weeks: 4 });
    expect(history).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 4, expect.objectContaining({ timeoutMs: DEFAULT_LIMITS.sqlTimeoutMs }));
    // I4b: history reserves rows: 4 (the requested weeks, not the 2 points actually returned).
    expect(deps.reserve).toHaveBeenNthCalledWith(2, expect.objectContaining({ rows: 4 }));
    // I4a: history records the delivered point count (2), distinct from details' ('u1', 1) above.
    expect(deps.record).toHaveBeenNthCalledWith(2, 'u1', 2);
    await expect(svc.details(actor, { searchTermId: 'nope' })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
  });
  it('guide reports the dataset week and audience, and reserves without rows', async () => {
    const deps = makeDeps({ audience: () => 'all' });
    const g = await createResearchService(deps).guide(actor);
    expect(g).toMatchObject({ datasetWeek: '2026-09-12', audience: 'all' });
    expect(deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ rows: 0 }));
    // I3: guide records a request too (RESERVE_NO_ROWS) — every accepted tool call bumps
    // Task 17's mcp_request counter, not just search/details/history.
    expect(deps.record).toHaveBeenCalledWith('u1', 0);
  });
});

describe('defaultResearchService', () => {
  // M10: one shared service per process, memoised on first use; resetResearchServiceForTests()
  // clears the memo so the next call rebuilds from scratch (as production code needs it to, in
  // the rare case the underlying deps — e.g. an env-driven singleton — must be re-read).
  it('memoises one service per process, and resetResearchServiceForTests clears it for the next call', () => {
    resetResearchServiceForTests();
    const a = defaultResearchService();
    const b = defaultResearchService();
    expect(b).toBe(a);
    resetResearchServiceForTests();
    const c = defaultResearchService();
    expect(c).not.toBe(a);
  });
});

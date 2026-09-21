// lib/research/service.ts
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { env } from '@/lib/env';
import { isPoolConnectTimeout } from '@/lib/db/tcpPool';
import { fetchFits } from '@/lib/explorer/fetchKeywordDetail';
import { mcpAudience } from '@/lib/mcp/config';
import { applyPresets, buildGuide, GUIDE_VERSION, QUERY_VERSION } from './catalog';
import { defaultCategoryDeps, rankCandidates, resolveScope, type CategoryDeps } from './categories';
import {
  invalid, keywordDetailsInputSchema, keywordHistoryInputSchema, parseSearchInput, resolveCategoriesInputSchema,
  type Filters, type GuideResponse, type KeywordDetailsResponse, type KeywordHistoryResponse, type Pagination,
  type ResolveCategoriesResponse, type SearchRequest, type SearchResponse, type SearchRow, type Sort, type TotalMatches, type Warning,
} from './contracts';
import { cursorSecret, signCursor, verifyCursor, type CursorPayload } from './cursor';
import { defaultDetailsDeps, loadKeywordDetails, type DetailsDeps } from './details';
import { invalidCursorError, poolBusyError, ResearchError } from './errors';
import { loadKeywordHistory, type HistoryDeps } from './history';
import { researchLimits, type ResearchLimits } from './limits';
import { getResearchPool } from './pool';
import { compileSearch, mapSearchRow, type CompiledSearch } from './query';
import { countMatches, runSearch } from './search';
import { loadSnapshotMetaHttp, type SnapshotMeta } from './snapshot';
import { recordMcpActivity, reserveResearchRequest } from './usage';

/** Supplied by a trusted adapter (the MCP gate), never by tool arguments. */
export interface ResearchActor { localUserId: string; clerkUserId: string; clientId: string; channel: 'mcp' }

/**
 * The five MCP research tools, each independently callable. Every method validates its own
 * `input` (an `unknown` from the wire) and rejects with a `ResearchError` — see `guarded()`
 * below for how a non-`ResearchError` failure (a raw DB/pool error) is classified before it
 * ever reaches a caller.
 */
export interface ResearchService {
  guide(actor: ResearchActor): Promise<GuideResponse>;
  resolveCategories(actor: ResearchActor, input: unknown): Promise<ResolveCategoriesResponse>;
  search(actor: ResearchActor, input: unknown): Promise<SearchResponse>;
  details(actor: ResearchActor, input: unknown): Promise<KeywordDetailsResponse>;
  history(actor: ResearchActor, input: unknown): Promise<KeywordHistoryResponse>;
}

/**
 * Every external dependency `createResearchService` needs, injected so tests are
 * deterministic and never touch a real database. `defaultResearchDeps()` wires the
 * production implementations; `loadDetails`/`loadHistory` are optional purely for tests that
 * want to stub the whole loader rather than its own inner deps (`details`/`history` above).
 */
export interface ResearchServiceDeps {
  pool: Pool;
  limits: ResearchLimits;
  appUrl: string;
  cursorSecret: string;
  audience: () => 'admin' | 'all';
  now: () => Date;
  reserve: typeof reserveResearchRequest;
  record: typeof recordMcpActivity;
  categories: CategoryDeps;
  details: DetailsDeps;
  history: Pick<HistoryDeps, 'fetchFits'>;
  meta: () => Promise<Pick<SnapshotMeta, 'currentWeekEndDate'> | null>;
  runSearch: typeof runSearch;
  countMatches: typeof countMatches;
  loadDetails?: typeof loadKeywordDetails;
  loadHistory?: typeof loadKeywordHistory;
}

export function defaultResearchDeps(): ResearchServiceDeps {
  const appUrl = env.APP_PUBLIC_URL;
  return {
    pool: getResearchPool(),
    limits: researchLimits(),
    appUrl,
    cursorSecret: cursorSecret(),
    audience: mcpAudience,
    now: () => new Date(),
    reserve: reserveResearchRequest,
    record: recordMcpActivity,
    categories: defaultCategoryDeps,
    details: defaultDetailsDeps(appUrl),
    history: { fetchFits: () => fetchFits(env.DATABASE_URL) },
    meta: loadSnapshotMetaHttp,
    runSearch,
    countMatches,
  };
}

let singleton: ResearchService | null = null;
/** One shared service per process, built from the production deps on first use. */
export function defaultResearchService(): ResearchService {
  if (!singleton) singleton = createResearchService(defaultResearchDeps());
  return singleton;
}

/** Test-only: clears the process memo so the next defaultResearchService() call rebuilds it. */
export function resetResearchServiceForTests(): void {
  singleton = null;
}

const RESERVE_NO_ROWS = 0;

function reserveFor(deps: ResearchServiceDeps, actor: ResearchActor, rows: number) {
  return deps.reserve({ userId: actor.localUserId, channel: actor.channel, rows, now: deps.now(), limits: deps.limits });
}

/**
 * Runs one tool operation and classifies what escapes it (Task 8/15 review): a `ResearchError`
 * is already a safe, client-facing shape and passes through unchanged. `isPoolConnectTimeout`
 * recognizes pg-pool's own connect-queue wait timing out — a plain `Error` with no SQLSTATE,
 * raised when every pooled connection is busy — and turns THAT SPECIFIC failure into
 * `poolBusyError()` (I2: its own message and a short 5s retry — the pool itself is healthy and
 * the caller just lost the race for a client, so `dataUnavailableError()`'s "dataset is being
 * refreshed" wording would misstate the cause). Anything else (a raw SQLSTATE, a compile-time
 * guard, a genuinely unexpected error) is rethrown unchanged, on purpose: the MCP tool layer
 * (Task 15) maps an unrecognized error to a generic message without ever echoing `e.message` to
 * a client, so there is no safety reason to reclassify it here too.
 */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ResearchError) throw e;
    if (isPoolConnectTimeout(e)) throw poolBusyError();
    throw e;
  }
}

function buildWarnings(args: { filters: Filters; sort: Sort; meta: SnapshotMeta; pagination: Pagination; pageShortened: boolean }): Warning[] {
  const w: Warning[] = [{ code: 'ESTIMATED_VOLUME', message: 'estimatedMonthlySearches values are estimates derived from rank and calibration, not measured counts.' }];
  // C6 (Task 11 review wording, matching lib/research/details.ts exactly): the flag means the
  // dataset week predates every calibration month, not "extrapolated from an earlier month".
  if (args.meta.isExtrapolated) {
    w.push({
      code: 'EXTRAPOLATED_VOLUME',
      message: 'The dataset week predates every calibration month, so this volume estimate applies the earliest calibration fit backward in time; treat it as directional.',
    });
  }
  if (args.filters.movement?.baseline === 'include_not_observed') w.push({ code: 'BASELINE_NOT_OBSERVED', message: 'Rows with baselineStatus not_observed use a zero baseline because the keyword was unranked then; that is not evidence demand was zero.' });
  if (args.filters.averageReviews || args.sort.field === 'averageReviews') w.push({ code: 'PARTIAL_REVIEW_COVERAGE_POSSIBLE', message: 'averageReviews is the stored average over the observed top-three products; some rows may cover fewer than three.' });
  if (args.pagination.nextCursor) w.push({ code: 'LIVE_PAGINATION', message: 'Pages are computed live; continue with {cursor} only. A mid-week product sync can shift review-sorted pages slightly; a weekly refresh expires the cursor.' });
  if (args.pagination.capReason === 'max_rows') w.push({ code: 'RESULTS_CAPPED', message: `Only the first ${args.pagination.offset + args.pagination.returnedCount} matching rows are reachable per search; more matches exist. Narrow the criteria to see them.` });
  // I1: PAYLOAD_LIMITED only when the halving loop below actually cut rows. capReason is
  // 'payload' in TWO distinct situations — a shortened page (this one) and a cursor too large
  // to sign with a full, un-shortened page (build()'s cursorTooLarge branch) — and only the
  // first one actually shortened anything; the second already reports CURSOR_TOO_LARGE and a
  // null nextCursor, which this warning's "the cursor continues from the last row returned"
  // clause would otherwise flatly contradict. The clause itself is conditional on nextCursor
  // too, since a page can be shortened AND still end up with no cursor (RESPONSE_TOO_LARGE's
  // sign-time failure can follow a halving that already happened).
  if (args.pageShortened) {
    w.push({
      code: 'PAYLOAD_LIMITED',
      message: args.pagination.nextCursor
        ? 'This page was shortened to fit the response size limit; the cursor continues from the last row returned.'
        : 'This page was shortened to fit the response size limit.',
    });
  }
  return w;
}

/**
 * M9: builds the five research tools over `deps`. Every tool's order of operations is:
 * validate → cursor verify + owner check (search's continuation path only) → presets → reserve
 * → resolve scope → run → count → bound the payload → sign the cursor → record activity.
 * `record` (the daily-digest counters, Task 17) runs only after every earlier step has already
 * succeeded — never before, and never on a rejected or failed call — so those counters only
 * ever reflect calls that actually returned a result to the caller.
 */
export function createResearchService(deps: ResearchServiceDeps): ResearchService {
  const loadDetails = deps.loadDetails ?? loadKeywordDetails;
  const loadHistory = deps.loadHistory ?? loadKeywordHistory;

  /**
   * M9: order of operations (see createResearchService's docstring above) — validate → cursor
   * verify + owner check → presets → reserve → resolve scope → run → count → bound → sign →
   * record. `record` runs once, at the very end, only after the response is fully built
   * (including the payload-shrink loop below); any failure before that point propagates without
   * ever bumping the caller's digest counters.
   */
  async function search(actor: ResearchActor, input: unknown): Promise<SearchResponse> {
    const parsed = parseSearchInput(input);
    const now = deps.now();
    const nowSec = Math.floor(now.getTime() / 1000);
    let request: SearchRequest;
    let offset: number;
    let pageSize: number;
    let expectedSnapshot: string | null;
    let carriedTotal: TotalMatches | null;
    let exp: number;
    if (parsed.kind === 'continuation') {
      const c: CursorPayload = verifyCursor(parsed.cursor, deps.cursorSecret, nowSec);
      // M1: the standard INVALID_CURSOR error, same as every other bad-cursor case — a foreign
      // cursor is deliberately indistinguishable from a malformed one, never its own bespoke
      // "belongs to a different account" message.
      if (c.uid !== actor.localUserId || c.ch !== actor.channel) {
        throw invalidCursorError();
      }
      request = c.req; offset = c.off; pageSize = c.ps; expectedSnapshot = c.snap; carriedTotal = c.tm; exp = c.exp;
    } else {
      request = parsed.request; offset = 0; pageSize = request.pageSize; expectedSnapshot = null; carriedTotal = null;
      exp = nowSec + deps.limits.cursorTtlSeconds;
    }
    const { filters, sort, comparisonWindow, applications } = applyPresets(request);
    await reserveFor(deps, actor, pageSize);
    const scope = await resolveScope(actor.localUserId, filters.categories, deps.limits.maxExpandedLeaves, deps.categories);

    // M5: reachable/visible must be known before compiling, so the SQL only ever asks for as
    // many rows as the response could actually show (visible + 1, to detect a next page) —
    // never a flat pageSize + 1 past the maxRowsPerSearch cap. An offset already beyond the cap
    // clamps `reachable` to 0 here rather than being rejected outright: that offset is only
    // ever reachable via a previously-signed cursor (never a request the service itself would
    // issue past the cap), and since cursors are signed, a client cannot forge one there either
    // — so clamping to an empty page is deliberate, simpler than a separate guard for a case
    // the signature already makes non-adversarial.
    const reachable = Math.max(0, deps.limits.maxRowsPerSearch - offset);
    const visible = Math.min(pageSize, reachable);
    // M2: compile() no longer stashes into a `let compiled` closure — runSearch's own return
    // (run.compiled) is the exact CompiledSearch it ran, so that's what count uses below.
    const compile = (meta: SnapshotMeta): CompiledSearch =>
      compileSearch({ filters, sort, window: comparisonWindow, leaves: scope.leaves, currentWeekEndDate: meta.currentWeekEndDate, offset, limit: visible + 1 });
    const run = await deps.runSearch(deps.pool, deps.limits.sqlTimeoutMs, compile, { expectedSnapshot });
    // M4: a second, later now() for provenance.resultCapturedAt, reported separately from the
    // first `now` above (kept fixed for the cursor's own nowSec/exp math) — this one marks when
    // the result was actually produced, after the SQL that produced it ran.
    const resultCapturedAt = deps.now();
    // S1: page one already proves the total when no probe row came back beyond the visible
    // budget (the query asks for visible + 1, and visible can be smaller than pageSize under a
    // low maxRowsPerSearch override) — then there is no row beyond it to count, so a whole second
    // transaction would only confirm what the page already showed. Otherwise, C2: countMatches takes
    // { expectedSnapshot } — always the snapshot the search actually ran against
    // (run.meta.snapshotVersion), even on a first page, so a weekly swap racing between the
    // search transaction and this separate count transaction is caught as `unknown` rather than
    // silently counting a different population than the rows just fetched.
    const totalMatches: TotalMatches = carriedTotal ?? (offset === 0 && run.rows.length <= visible
      ? { kind: 'exact', value: run.rows.length }
      : await deps.countMatches(deps.pool, deps.limits.countTimeoutMs, run.compiled, { expectedSnapshot: run.meta.snapshotVersion }));

    const available = Math.min(run.rows.length, visible);
    const moreExist = run.rows.length > visible;
    const rowCtx = { appUrl: deps.appUrl, window: comparisonWindow, includeMovement: filters.movement !== null || sort.field === 'volumeDelta', titleMode: filters.titleGap?.mode ?? null };
    let rows = run.rows.slice(0, available).map((r) => mapSearchRow(r, rowCtx));
    let capReason: Pagination['capReason'] = moreExist && offset + visible >= deps.limits.maxRowsPerSearch ? 'max_rows' : null;
    // One id for the whole search() call, not one per build() attempt: build() can run more
    // than once (the payload-shrink loop below), and every attempt describes the SAME request.
    const requestId = randomUUID();

    const build = (rowsOut: SearchRow[], reason: Pagination['capReason'], pageShortened: boolean): SearchResponse => {
      const returnedCount = rowsOut.length;
      const hasNext = reason !== 'max_rows' && (moreExist || returnedCount < available);
      let nextCursor: string | null = null;
      let cursorTooLarge = false;
      if (hasNext && returnedCount > 0) {
        try {
          nextCursor = signCursor({ v: 1, req: request, snap: run.meta.snapshotVersion, off: offset + returnedCount, ps: pageSize, exp, uid: actor.localUserId, ch: actor.channel, tm: totalMatches }, deps.cursorSecret);
        } catch (e) {
          // C5 (Task 7 review): a cursor too large to sign (mainly filters.categories.leafPaths
          // pushing the token past cursor.ts's MAX_CURSOR_LENGTH) must never discard the page
          // already computed — fall back to a terminal, uncached page instead of throwing.
          if (e instanceof ResearchError && e.code === 'RESPONSE_TOO_LARGE') {
            cursorTooLarge = true;
          } else {
            throw e;
          }
        }
      }
      const effectiveReason: Pagination['capReason'] = cursorTooLarge ? 'payload' : reason;
      const pagination: Pagination = {
        pageSize,
        returnedCount,
        offset,
        totalMatches,
        nextCursor: cursorTooLarge ? null : nextCursor,
        capped: cursorTooLarge ? true : reason !== null,
        capReason: effectiveReason,
        expiresAt: cursorTooLarge ? null : nextCursor ? new Date(exp * 1000).toISOString() : null,
      };
      const warnings = buildWarnings({ filters, sort, meta: run.meta, pagination, pageShortened });
      if (cursorTooLarge) {
        warnings.push({ code: 'CURSOR_TOO_LARGE', message: 'The search criteria are too large to page through; select a parent category or a custom category instead of many explicit leaf paths.' });
      }
      return {
        schemaVersion: 1,
        requestId,
        appliedFilters: filters,
        effectiveSort: sort,
        effectiveWindow: comparisonWindow,
        presetApplications: applications,
        resolvedCategoryScope: scope.scope,
        provenance: {
          datasetWeek: run.meta.currentWeekEndDate, snapshotVersion: run.meta.snapshotVersion, summaryRefreshedAt: run.meta.refreshedAt,
          resultCapturedAt: resultCapturedAt.toISOString(), volumeFitRunId: run.meta.volumeFitRunId, calibrationMonthEndDate: run.meta.calibrationMonthEndDate,
          volumeIsExtrapolated: run.meta.isExtrapolated, guideVersion: GUIDE_VERSION, queryVersion: QUERY_VERSION,
        },
        rows: rowsOut,
        pagination,
        warnings,
      };
    };

    let response = build(rows, capReason, false);
    // Payload bound (parent §9): the largest non-empty ordered prefix that fits; never drop a criterion.
    while (Buffer.byteLength(JSON.stringify(response)) > deps.limits.maxPayloadBytes) {
      if (rows.length <= 1) throw new ResearchError('RESPONSE_TOO_LARGE', 'Even one row does not fit the response size limit. Use fewer category selectors and try again.');
      rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
      capReason = 'payload';
      response = build(rows, capReason, true);
    }
    deps.record(actor.localUserId, response.rows.length);
    return response;
  }

  async function resolveCategories(actor: ResearchActor, input: unknown): Promise<ResolveCategoriesResponse> {
    const p = resolveCategoriesInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    const q = p.data;
    let offset = 0;
    if (q.cursor !== null) {
      if (!/^\d{1,6}$/.test(q.cursor)) throw new ResearchError('INVALID_CURSOR', 'The category cursor is not valid; repeat the query without it.');
      offset = Number(q.cursor);
    }
    await reserveFor(deps, actor, RESERVE_NO_ROWS);
    // C4: the catalog alone is the provenance source (it already carries its own
    // datasetWeek/snapshotVersion) — no separate deps.meta() read, and never a `?? ''`
    // fallback that could paper over a real gap between the two.
    const catalog = await deps.categories.loadCatalog();
    const taxonomy = q.source === 'custom'
      ? { candidates: [], total: 0 }
      : rankCandidates(catalog, { query: q.query, parentPath: q.parentPath, offset, limit: q.limit });
    const custom = q.source === 'taxonomy' || q.parentPath !== null || offset > 0
      ? []
      : await deps.categories.listCustom(actor.localUserId, q.query);
    const candidates = [...taxonomy.candidates, ...custom];
    const nextOffset = offset + q.limit;
    const response: ResolveCategoriesResponse = {
      query: q.query,
      source: q.source,
      parentPath: q.parentPath,
      candidates,
      nextCursor: nextOffset < taxonomy.total ? String(nextOffset) : null,
      // M6: custom is [] once offset > 0 (above), so this total — and candidates.length —
      // includes custom rows only on page 0, where it can therefore exceed `limit` by the
      // custom count. By design: custom categories are never paginated on their own, just
      // appended once, on the taxonomy's first page.
      totalCandidates: taxonomy.total + custom.length,
      provenance: { datasetWeek: catalog.datasetWeek, snapshotVersion: catalog.snapshotVersion },
      noMatch: candidates.length === 0,
    };
    // I3: every tool call records a request, even a rows: 0 one — Task 17's "MCP tool calls"
    // (mcp_request counter) must count this the same as search/details/history.
    deps.record(actor.localUserId, RESERVE_NO_ROWS);
    return response;
  }

  async function details(actor: ResearchActor, input: unknown): Promise<KeywordDetailsResponse> {
    const p = keywordDetailsInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await reserveFor(deps, actor, 1);
    const out = await loadDetails(p.data.searchTermId, deps.details);
    deps.record(actor.localUserId, 1);
    return out;
  }

  async function history(actor: ResearchActor, input: unknown): Promise<KeywordHistoryResponse> {
    const p = keywordHistoryInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await reserveFor(deps, actor, p.data.weeks);
    const out = await loadHistory(p.data.searchTermId, p.data.weeks, { pool: deps.pool, timeoutMs: deps.limits.sqlTimeoutMs, fetchFits: deps.history.fetchFits });
    deps.record(actor.localUserId, out.points.length);
    return out;
  }

  async function guide(actor: ResearchActor): Promise<GuideResponse> {
    await reserveFor(deps, actor, RESERVE_NO_ROWS);
    const meta = await deps.meta();
    const response = buildGuide({ datasetWeek: meta?.currentWeekEndDate ?? null, audience: deps.audience(), limits: deps.limits });
    // I3: every tool call records a request, even a rows: 0 one — Task 17's "MCP tool calls"
    // (mcp_request counter) must count this the same as search/details/history.
    deps.record(actor.localUserId, RESERVE_NO_ROWS);
    return response;
  }

  return {
    guide: (a) => guarded(() => guide(a)),
    resolveCategories: (a, i) => guarded(() => resolveCategories(a, i)),
    search: (a, i) => guarded(() => search(a, i)),
    details: (a, i) => guarded(() => details(a, i)),
    history: (a, i) => guarded(() => history(a, i)),
  };
}

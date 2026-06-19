# Explorer Filter Performance + Loading Overlay — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. TDD, frequent commits. Design reference: `docs/superpowers/specs/2026-06-19-explorer-filter-perf-design.md` (v2). Branch: `perf/explorer-filter-trigram`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Do NOT push. Do NOT apply DDL / run the backfill without explicit user go-ahead.**

**Goal:** Whole-word `q` matching (default) + an opt-in Broad toggle, served fast + correct from a denormalized, current-week-only column on `keyword_current_summary` (kcs); broad capped at 120 s.

**Already shipped (v1, unchanged):** LoadingOverlay + wiring (`4044cc8`, `048cbf7`), window-count `queryTotals` helpers (`cb84c4c`). The v1 substring-CTE q-path (`0b4fe81`) is **replaced** by Task C.

---

## Task A — Migration 0037: denormalized column (DDL file only)

**Files:** `db/migrations/0037_kcs_search_term_normalized.sql` (new), `db/schema/keywordCurrentSummary.ts`.

- [ ] SQL (no index here — built one-shot post-populate by the backfill/refresh to avoid slow incremental GIN maintenance during the bulk INSERT):
  ```sql
  ALTER TABLE keyword_current_summary       ADD COLUMN IF NOT EXISTS search_term_normalized varchar(512);
  ALTER TABLE keyword_current_summary_stage ADD COLUMN IF NOT EXISTS search_term_normalized varchar(512);
  ```
  (`pg_trgm` already installed, migration 0002.)
- [ ] Add `searchTermNormalized: varchar('search_term_normalized', { length: 512 })` to the kcs drizzle schema (nullable).
- [ ] `pnpm typecheck`. Commit. **Do not run `db:migrate`.**

---

## Task B — matchPattern helpers + `qMode` (TDD)

**Files:** `lib/explorer/matchPattern.ts` (+ `.test.ts`), `lib/explorer/parseFilters.ts` (+ test), `lib/explorer/types.ts`.

- [ ] `matchPattern.ts` (pure):
  ```ts
  export function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  export function escapeLike(s: string): string { return s.replace(/[\\%_]/g, '\\$&'); }
  /** Whole-word: Postgres word-boundary regex, lowercased + escaped. */
  export function wordPattern(q: string): string { return `\\m${escapeRegex(q.toLowerCase())}\\M`; }
  /** Broad: substring LIKE, lowercased + escaped (default backslash escape). */
  export function broadPattern(q: string): string { return `%${escapeLike(q.toLowerCase())}%`; }
  ```
  Tests: metachars (`c++`, `50%`, `a_b`) are escaped/literal; phrases keep internal spaces; lowercasing.
- [ ] `types.ts`: add `qMode: 'word' | 'broad'` to `ExplorerFilters`; add a `BroadTimeoutResult` marker (e.g. `{ broadTimedOut: true }`) the runner can return.
- [ ] `parseFilters.ts`: `EXPLORER_DEFAULTS.qMode = 'word'`; parse `qmode` via the enum helper (default `'word'`); include in the returned object. Tests: default `word`, `?qmode=broad` → broad, junk → word.
- [ ] `pnpm test matchPattern parseFilters && pnpm typecheck`. Commit.

---

## Task C — buildQuery single-table q-path + runQuery dual-driver (TDD)

**Files:** `lib/explorer/buildQuery.ts` (+ test), `lib/explorer/runQuery.ts`, `lib/explorer/types.ts`.

### buildQuery q-path (replaces the v1 CTE branch)
When `q` is set, match on the denormalized kcs column; inner subquery does match+sort+limit+window-count on kcs, outer joins `search_terms` for `search_term_raw` on the page rows only (so raw is read for ~100 rows, not the whole match set). Whole-word vs broad differ ONLY in the predicate:

```ts
if (filters.q && filters.q.length >= 3) {
  const op = filters.qMode === 'broad' ? 'LIKE' : '~';
  const patParam = next(filters.qMode === 'broad' ? broadPattern(filters.q) : wordPattern(filters.q));
  const where = pushKcsPredicates(filters, currentWeekEndDate, next);
  where.push(`kcs.search_term_normalized ${op} ${patParam}`);
  const whereClause = `WHERE ${where.join('\n      AND ')}`;
  const countArgs = [...args];
  const limitParam = next(filters.perPage);
  const offsetParam = next((filters.page - 1) * filters.perPage);

  const sql = `
    SELECT k.search_term_id, st.search_term_raw, ${OUTER_COLS}, k.total
    FROM (
      SELECT ${INNER_COLS}, (count(*) OVER ())::int AS total
      FROM keyword_current_summary kcs
      ${whereClause}
      ${buildOrderBy(filters.sort, improvementCol, filters.matchMode)}     -- inner: kcs.<col>
      LIMIT ${limitParam} OFFSET ${offsetParam}
    ) k
    JOIN search_terms st ON st.id = k.search_term_id
    ${buildOuterOrderBy(filters.sort, filters.matchMode)}                    -- outer: k.<stable alias>
  `.trim();
  return { sql, args, countSql: <CTE-free fallback count>, countArgs, countFromRows: true };
}
```

- **`INNER_COLS`** = the existing kcs display columns, with `kcs.<priorRankCol> AS prior_rank` and `kcs.<improvementCol> AS improvement` (the stable aliases), `kcs.current_rank`, the title/severity/product/volume/price/review/leaf columns — **no `search_term_raw`**.
- **`OUTER_COLS`** = the same columns referenced as `k.current_rank, k.prior_rank, k.improvement, k.…` (stable names).
- **`buildOuterOrderBy`** (new helper): mirrors `buildOrderBy` but sorts by the **outer aliases** on `k.` — `k.current_rank`, `k.improvement` (NOT `improvement_1w`), `k.keyword_title_match_count[_loose]_current`, `k.avg_price_cents`, `k.avg_reviews`. The outer ORDER BY is required because the join doesn't guarantee the inner's order survives.
- Fallback `countSql` (empty-page only): `SELECT count(*)::int AS total FROM keyword_current_summary kcs ${whereClause}` (single-table, no raw).
- No-`q` path: unchanged.

Tests: word path emits `kcs.search_term_normalized ~ $n` + the subquery + `(count(*) OVER ())::int AS total` + outer join; broad path emits `LIKE $n`; every sort emits the right inner+outer ORDER BY; other filters compose into the inner WHERE; arg order (pattern after the kcs predicate args? — pattern is pushed AFTER `pushKcsPredicates`, so order = [week, …kcs preds…, pattern, limit, offset]); `countArgs` excludes limit/offset; no-`q` byte-stable.

### runQuery dual-driver + broad timeout
- Whole-word + non-`q`: neon-http (current path), total via `extractWindowTotal` + `applyCountCap`, empty-page fallback.
- **Broad:** run via a node-postgres client (import `Pool` from `pg`, or reuse the app's TCP client factory if one exists — check `db/client.ts`) inside a transaction that first runs `SET LOCAL statement_timeout = 115000`, then the query. On a `statement_timeout`/cancel error (Postgres code `57014`), return the typed `BroadTimeoutResult`. Always release/end the connection.
- `runExplorerQuery` returns `rows | broadTimedOut`. The page renders the timeout case as a friendly message.

`pnpm test buildQuery && pnpm typecheck`. Commit.

---

## Task D — refresh upkeep + backfill

**Files:** `inngest/functions/refreshSummary.ts`, `scripts/backfillKcsNormalized.ts` (new).

- [ ] **refreshSummary:** in the stage INSERT (~line 204), add `LEFT JOIN search_terms st_n ON st_n.id = l.search_term_id` and select `st_n.search_term_normalized` into the new column.
  - **GIN index — mind the swap rotation (VERIFIED, the naive version collides).** The live + stage tables carry *distinct, non-overlapping* index name sets (measured: 26 on stage vs 20 on live, zero shared names) that rotate through the 3-way RENAME. A **fixed** GIN name therefore collides — the name you'd `CREATE` on stage already lives on the rotated-in live table. Correct approach:
    1. **After TRUNCATE, before the INSERT** — drop any GIN on the stage column (its name rotated in), so the bulk INSERT runs GIN-free (fast):
       ```sql
       DO $$ DECLARE r record; BEGIN
         FOR r IN SELECT indexname FROM pg_indexes WHERE tablename='keyword_current_summary_stage' AND indexdef ILIKE '%using gin%search_term_normalized%'
         LOOP EXECUTE format('DROP INDEX IF EXISTS %I', r.indexname); END LOOP;
       END $$;
       ```
    2. **After the INSERT + `ANALYZE`, before the swap** — one-shot build (~24 s, measured) under whichever of two alternating names is NOT currently on the **live** table (so the swap never collides):
       ```ts
       const liveGin = (await client.query(`SELECT indexname FROM pg_indexes WHERE tablename='keyword_current_summary' AND indexdef ILIKE '%using gin%search_term_normalized%' LIMIT 1`)).rows[0]?.indexname;
       const buildName = liveGin === 'kcs_norm_trgm_a_idx' ? 'kcs_norm_trgm_b_idx' : 'kcs_norm_trgm_a_idx';
       await client.query(`CREATE INDEX ${buildName} ON keyword_current_summary_stage USING gin (search_term_normalized gin_trgm_ops)`);
       ```
    The backfill seeds the live table with `kcs_norm_trgm_a_idx`; the first refresh builds `_b_` on stage; they alternate thereafter. Add an integration test (mirror `tests/integration/chartSeriesMaintenance.test.ts`) that runs a refresh and asserts the swapped-in live table ends with exactly one GIN on the column.
- [ ] **backfill script** (one-time, run later with user OK): set `statement_timeout = 0`; `UPDATE keyword_current_summary kcs SET search_term_normalized = st.search_term_normalized FROM search_terms st WHERE st.id = kcs.search_term_id AND kcs.search_term_normalized IS NULL` (set-based, ~minutes); then `CREATE INDEX IF NOT EXISTS … USING gin (… gin_trgm_ops)` on the live table (~24 s). Idempotent, read-mostly on `search_terms`. `--dry-run` prints counts.
- [ ] `pnpm typecheck`. Commit. **Do not run the backfill.**

---

## Task E — toggle + page maxDuration + prod gates + verify

**Files:** `app/(app)/explorer/FilterSidebar.tsx`, `app/(app)/explorer/page.tsx`, `lib/explorer/runQuery.ts` (broad-result rendering in `page.tsx`).

- [ ] `page.tsx`: `export const maxDuration = 120;` Render the `broadTimedOut` result as a friendly inline message ("This broad search matched too many keywords to rank in time — narrow it or switch to Whole word").
- [ ] `FilterSidebar`: a segmented **Whole word / Broad (slower)** control under "Search term contains"; plumbs `qmode` into the Apply URL (omit when `word`); when Broad, show the one-line note. Saved views already serialize the filter set — confirm `qMode` rides along.
- [ ] `pnpm test && pnpm typecheck && pnpm lint`. Commit.
- [ ] **PROD GATE 1 — apply migration** (`pnpm db:migrate` or apply 0037 SQL): ask the user; apply on confirmation.
- [ ] **PROD GATE 2 — run backfill** (`pnpm tsx scripts/backfillKcsNormalized.ts`): ask the user; run on confirmation.
- [ ] **Verify (live):** a script that builds the real q-query via `buildExplorerQuery` and times `collagen`/`hair` whole-word (fast, flat page 1 ≈ page 21) + `men` broad (graceful timeout). Full suite + manual UI smoke (toggle, note, overlay, timeout message). Hand back for push.

---

## Notes
- **No push; prod gates need explicit OK.** The q-path falls back gracefully if the column/index is missing (treat absent column as "no denormalized search" → could keep the no-`q` behavior or the v1 path during the window between deploy and backfill — implementer: simplest is to deploy code after the backfill so the column always exists).
- Pre-existing `importFile.test.ts` failure and the uncommitted integration-test WIP in the tree are unrelated — leave them.

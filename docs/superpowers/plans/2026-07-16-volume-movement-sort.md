# Volume-Based Movement Sorts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The explorer's `imp`/`decline` sorts order by estimated-search-volume delta (current − N weeks ago) instead of SFR-rank delta, with context-swapped table columns and index-backed performance.

**Architecture:** All volume lookbacks already exist in `kcs`. One shared expression (+ eligibility predicate) is emitted by `buildQuery` into ORDER BY, SELECT aliases (`volume_delta`, `volume_prior`), and WHERE; `runQuery`'s precomputed-count short-circuits learn to stand down under these sorts; the watchlist's by-IDs loader gets parity (minus the exclusion); the table context-swaps two columns; migration 0044 adds 5 partial expression indexes × 2 physical tables (live + stage twins).

**Tech Stack:** Postgres partial expression indexes (Neon), raw-SQL hand-numbered migration + gated apply script, vitest, Next App Router server components.

**Spec:** `docs/superpowers/specs/2026-07-16-volume-movement-sort-design.md` (incl. both amendments)

**Conventions (non-negotiable):** work on `main`; commit per task, **NEVER push** (owner-gated, Task 7); trailer exactly `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; `git add` named files only; DDL is NEVER executed by an implementer — Task 5 only *writes* migration files; the owner applies in Task 7.

**The two load-bearing strings** (byte-identical everywhere they appear, modulo alias prefix; `1w` uses `prior_week_rank`):

```
delta(W):   (estimated_monthly_volume_current - CASE WHEN <rankCol W> IS NULL THEN 0 ELSE <volCol W> END)
eligible(W): estimated_monthly_volume_current IS NOT NULL AND (<rankCol W> IS NULL OR <volCol W> IS NOT NULL)
```

---

### Task 1: buildQuery — expression helpers, predicate, ORDER BY, aliases (TDD)

**Files:**
- Modify: `lib/explorer/buildQuery.ts`
- Modify: `lib/explorer/types.ts`
- Test: `lib/explorer/buildQuery.test.ts`

- [ ] **Step 1: Read `lib/explorer/buildQuery.ts` and `lib/explorer/buildQuery.test.ts` fully.** The test file has an existing filter-fixture pattern (a defaults object or helper) — reuse it for the new tests; only the fixture-construction lines below may be adapted to match it.

- [ ] **Step 2: Write failing tests** (append a describe block to `buildQuery.test.ts`; `makeFilters` here stands for the file's existing fixture helper with overrides):

```ts
describe('volume-delta imp/decline sorts', () => {
  const DELTA_4W = '(kcs.estimated_monthly_volume_current - CASE WHEN kcs.rank_4w_ago IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_4w_ago END)';
  const ELIGIBLE_4W = '(kcs.estimated_monthly_volume_current IS NOT NULL AND (kcs.rank_4w_ago IS NULL OR kcs.estimated_monthly_volume_4w_ago IS NOT NULL))';

  it('legacy path: imp orders DESC by the delta expression and applies eligibility to rows AND count', () => {
    const { sql, countSql } = buildExplorerQuery(makeFilters({ sort: 'imp', window: '4w' }), '2026-07-05');
    expect(sql).toContain(`ORDER BY ${DELTA_4W} DESC`);
    expect(sql).toContain(ELIGIBLE_4W);
    expect(sql).toContain('AS volume_delta');
    expect(sql).toContain('AS volume_prior');
    expect(countSql).toContain(ELIGIBLE_4W);
  });

  it('legacy path: decline orders ASC', () => {
    const { sql } = buildExplorerQuery(makeFilters({ sort: 'decline', window: '4w' }), '2026-07-05');
    expect(sql).toContain(`ORDER BY ${DELTA_4W} ASC`);
  });

  it('1w window uses prior_week_rank as the discriminator', () => {
    const { sql } = buildExplorerQuery(makeFilters({ sort: 'imp', window: '1w' }), '2026-07-05');
    expect(sql).toContain('CASE WHEN kcs.prior_week_rank IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_1w_ago END');
  });

  it('other sorts get NO eligibility predicate and still select the aliases', () => {
    const { sql, countSql } = buildExplorerQuery(makeFilters({ sort: 'rank', window: '4w' }), '2026-07-05');
    expect(sql).not.toContain('IS NOT NULL AND (kcs.rank_4w_ago IS NULL');
    expect(countSql).not.toContain('IS NOT NULL AND (kcs.rank_4w_ago IS NULL');
    expect(sql).toContain('AS volume_delta');
  });

  it('q path: inner orders by the expression, outer by k.volume_delta, count keeps eligibility', () => {
    const { sql, countSql } = buildExplorerQuery(makeFilters({ sort: 'imp', window: '4w', q: 'gummies' }), '2026-07-05');
    expect(sql).toContain(`ORDER BY ${DELTA_4W} DESC`);
    expect(sql).toContain('ORDER BY k.volume_delta DESC');
    expect(sql).toContain('k.volume_prior');
    expect(countSql).toContain(ELIGIBLE_4W);
  });

  it('eligibility predicate binds no args (countArgs prefix invariant holds)', () => {
    const plain = buildExplorerQuery(makeFilters({ sort: 'rank', window: '4w' }), '2026-07-05');
    const withSort = buildExplorerQuery(makeFilters({ sort: 'imp', window: '4w' }), '2026-07-05');
    expect(withSort.args.length).toBe(plain.args.length);
  });

  it('sortUsesVolumeDelta is true only for imp/decline', () => {
    expect(sortUsesVolumeDelta('imp')).toBe(true);
    expect(sortUsesVolumeDelta('decline')).toBe(true);
    expect(sortUsesVolumeDelta('rank')).toBe(false);
    expect(sortUsesVolumeDelta('added_desc')).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure:** `pnpm vitest run lib/explorer/buildQuery.test.ts` → new tests FAIL (helpers/aliases missing).

- [ ] **Step 4: Implement in `buildQuery.ts`.** Add after `WINDOW_TO_IMPROVEMENT_COLUMN` (import `SortKey` in the existing type import from `./types`):

```ts
/**
 * Volume-delta sort machinery (spec 2026-07-16). The expression and the
 * eligibility predicate MUST stay byte-identical (modulo the alias prefix)
 * with migration 0044's partial indexes, or the planner won't match them
 * and the unfiltered sort degrades to a full top-N scan.
 * `alias` is 'kcs.' (inner queries) or '' (the migration DDL).
 */
export function volumeDeltaExpr(window: WindowKey, alias: string): string {
  const rankCol = WINDOW_TO_RANK_COLUMN[window];
  const volCol = WINDOW_TO_VOLUME_COLUMN[window];
  return `(${alias}estimated_monthly_volume_current - CASE WHEN ${alias}${rankCol} IS NULL THEN 0 ELSE ${alias}${volCol} END)`;
}

/** The prior-volume display value: unranked-then coalesces to 0 (spec). */
export function volumePriorExpr(window: WindowKey, alias: string): string {
  const rankCol = WINDOW_TO_RANK_COLUMN[window];
  const volCol = WINDOW_TO_VOLUME_COLUMN[window];
  return `CASE WHEN ${alias}${rankCol} IS NULL THEN 0 ELSE ${alias}${volCol} END`;
}

/**
 * Rows where the delta is computable. Under imp/decline this is a WHERE
 * clause (and the partial-index predicate); rows failing it are hidden
 * under these two sorts ONLY. Binds no args.
 */
export function volumeDeltaEligibility(window: WindowKey, alias: string): string {
  const rankCol = WINDOW_TO_RANK_COLUMN[window];
  const volCol = WINDOW_TO_VOLUME_COLUMN[window];
  return `${alias}estimated_monthly_volume_current IS NOT NULL AND (${alias}${rankCol} IS NULL OR ${alias}${volCol} IS NOT NULL)`;
}

/**
 * True when `sort` applies the eligibility predicate — which also means
 * precomputed totals (meta/facet) are WRONG for it. runQuery's count
 * short-circuits consult this.
 */
export function sortUsesVolumeDelta(sort: SortKey): boolean {
  return sort === 'imp' || sort === 'decline';
}
```

- [ ] **Step 5: Wire the predicate.** At the END of `pushKcsPredicates` (after the title-gap block, before `return where;`):

```ts
  if (sortUsesVolumeDelta(filters.sort)) {
    // No bound args — countArgs prefix invariant unaffected.
    where.push(`(${volumeDeltaEligibility(filters.window, 'kcs.')})`);
  }
```

- [ ] **Step 6: Wire ORDER BY.** Change `buildOrderBy`'s signature to `(sort, improvementCol, matchMode, window)` (add `window: WindowKey` last) and its two cases — the eligibility predicate guarantees non-NULL deltas, so no NULLS clause:

```ts
    case 'imp':
      return `ORDER BY ${volumeDeltaExpr(window, 'kcs.')} DESC`;
    case 'decline':
      return `ORDER BY ${volumeDeltaExpr(window, 'kcs.')} ASC`;
```

Update the call site: `const orderBy = buildOrderBy(filters.sort, improvementCol, filters.matchMode, filters.window);`

In `buildOuterOrderBy`, change the two cases to:

```ts
    case 'imp':
      return 'ORDER BY k.volume_delta DESC';
    case 'decline':
      return 'ORDER BY k.volume_delta ASC';
```

- [ ] **Step 7: Wire the SELECT aliases (both paths, always emitted).** In the q-path `innerCols` array, after the `improvement` line:

```ts
      `${volumePriorExpr(filters.window, 'kcs.')} AS volume_prior`,
      `${volumeDeltaExpr(filters.window, 'kcs.')} AS volume_delta`,
```

In `outerCols`, after `'k.improvement',`:

```ts
      'k.volume_prior',
      'k.volume_delta',
```

In the legacy `kcsSelect` template, after the `improvement` line:

```ts
      ${volumePriorExpr(filters.window, 'kcs.')} AS volume_prior,
      ${volumeDeltaExpr(filters.window, 'kcs.')} AS volume_delta,
```

- [ ] **Step 8: Extend `ExplorerRow` in `lib/explorer/types.ts`** after `estimatedMonthlyVolumeCurrent`:

```ts
  /**
   * Estimated monthly volume at the selected window's start; unranked-then
   * coalesces to 0 (spec 2026-07-16). NULL when no historical fit exists
   * for a then-ranked keyword (delta not computable).
   */
  volumePrior: number | null;
  /** estimatedMonthlyVolumeCurrent − volumePrior; the imp/decline sort key. */
  volumeDelta: number | null;
```

- [ ] **Step 9: Run tests:** `pnpm vitest run lib/explorer/buildQuery.test.ts` → ALL pass (old + new). `pnpm typecheck` → expect failures ONLY in `runQuery.ts`/`fetchExplorerRowsByIds.ts` mappers (missing new ExplorerRow fields) — those are Tasks 2–3; if typecheck fails elsewhere, fix here.

- [ ] **Step 10: Commit** (typecheck-red across tasks is not acceptable — see Step 9; if the mapper errors block, add the two fields to both mappers as `volumePrior: null, volumeDelta: null` placeholders ONLY if needed to keep `main` green, and say so in your report so Tasks 2–3 replace them):

```bash
git add lib/explorer/buildQuery.ts lib/explorer/buildQuery.test.ts lib/explorer/types.ts
git commit -m "feat(explorer): imp/decline sorts order by volume delta — expression + eligibility in buildQuery

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: runQuery — mapper fields + count short-circuits stand down

**Files:**
- Modify: `lib/explorer/runQuery.ts`

- [ ] **Step 1: Read `lib/explorer/runQuery.ts`.**

- [ ] **Step 2: RawRow.** After `estimated_monthly_volume_current` in the `RawRow` interface:

```ts
  volume_prior: string | number | null;
  volume_delta: string | number | null;
```

- [ ] **Step 3: Mapper.** In the `rows` mapping, after the `estimatedMonthlyVolumeCurrent` line:

```ts
    volumePrior: parseBigint(r.volume_prior),
    volumeDelta: parseBigint(r.volume_delta),
```

- [ ] **Step 4: Short-circuits stand down.** Import `sortUsesVolumeDelta` alongside `buildExplorerQuery`. In each of `canUseDefaultTotal`, `canUseCategoryFacet`, `canUseLeafCategoryFacet`, add as the FIRST condition of the returned `&&` chain:

```ts
    !sortUsesVolumeDelta(f.sort)
```

with a one-line comment above each function's return (once, same text): `// Volume-delta sorts filter rows by eligibility — precomputed totals overcount.` Under these sorts the default-landing/facet counts fall through to the deferred live count (`countExplorerMatches`), which inherits the predicate via the shared `countSql` and stays bounded by its `LIMIT COUNT_CAP + 1` inner query.

- [ ] **Step 5: Verify:** `pnpm typecheck` (green now if Task 1 left mapper placeholders, this task replaced them) and `pnpm vitest run lib/explorer` → green.

- [ ] **Step 6: Commit:**

```bash
git add lib/explorer/runQuery.ts
git commit -m "feat(explorer): map volume_prior/volume_delta; precomputed counts stand down under volume-delta sorts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: fetchExplorerRowsByIds — watchlist parity (NULLS LAST, no exclusion)

**Files:**
- Modify: `lib/explorer/fetchExplorerRowsByIds.ts`

- [ ] **Step 1: Read the file fully.** It deliberately duplicates the projection (header comment explains why). Identify: the SELECT projection, its kcs alias (match whatever it uses — instructions below assume `kcs.`), its ORDER BY switch, its `RawRow`, and its row mapper.

- [ ] **Step 2: Imports.** Add `import { volumeDeltaExpr, volumePriorExpr } from './buildQuery';` (no circularity: buildQuery imports only types/jumpPresets/matchPattern).

- [ ] **Step 3: Projection.** After the `improvement` select line add (adapting the alias if the file differs):

```ts
      ${volumePriorExpr(window, 'kcs.')} AS volume_prior,
      ${volumeDeltaExpr(window, 'kcs.')} AS volume_delta,
```

(If the projection is an array like buildQuery's, use the array form from Task 1 Step 7.)

- [ ] **Step 4: ORDER BY.** In its sort switch, the `imp`/`decline` cases become — **NULLS LAST here, deliberately** (spec amendment: a user's watched keywords are never hidden; non-computable rows sort last):

```ts
    case 'imp':
      return `ORDER BY ${volumeDeltaExpr(window, 'kcs.')} DESC NULLS LAST`;
    case 'decline':
      return `ORDER BY ${volumeDeltaExpr(window, 'kcs.')} ASC NULLS LAST`;
```

(Match the switch's actual return/assignment shape and alias.)

- [ ] **Step 5: RawRow + mapper.** Same two `RawRow` fields as Task 2 Step 2; same two mapper lines as Task 2 Step 3 (this file has its own `parseBigint` or equivalent — reuse whatever it uses for `estimated_monthly_volume_current`; if it inlines parsing, mirror that inline pattern).

- [ ] **Step 6: Verify:** `pnpm typecheck && pnpm vitest run lib/explorer` → green.

- [ ] **Step 7: Commit:**

```bash
git add lib/explorer/fetchExplorerRowsByIds.ts
git commit -m "feat(watchlist): volume-delta imp/decline parity in by-IDs loader (NULLS LAST, rows never hidden)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: UI — sidebar labels + ResultsTable context-swap

**Files:**
- Modify: `app/(app)/explorer/FilterSidebar.tsx` (SORTS labels only)
- Modify: `app/(app)/explorer/ResultsTable.tsx`

- [ ] **Step 1: Labels.** In `FilterSidebar.tsx`'s `SORTS` array change exactly two labels:

```ts
  { value: 'imp', label: 'Biggest improvement (search volume)' },
  { value: 'decline', label: 'Biggest decline (search volume)' },
```

- [ ] **Step 2: Read `ResultsTable.tsx` fully** (server component; keep it one).

- [ ] **Step 3: Add the volume window labels** after `WINDOW_LABEL`:

```ts
const VOLUME_WINDOW_LABEL: Record<WindowKey, string> = {
  '1w': 'Est. vol. prior week',
  '4w': 'Est. vol. 4w ago',
  '13w': 'Est. vol. 13w ago',
  '26w': 'Est. vol. 26w ago',
  '52w': 'Est. vol. 52w ago',
};
```

- [ ] **Step 4: Swap flag.** In the component body (near `fromParam`):

```ts
  // Volume-movement sorts context-swap the window + Δ columns (spec 2026-07-16).
  const volSort = currentSort === 'imp' || currentSort === 'decline';
```

- [ ] **Step 5: Window header** (the `<th className="p-2 text-right">{WINDOW_LABEL[window]}</th>` line) becomes:

```tsx
            <th
              className="p-2 text-right"
              title={volSort ? 'Estimated monthly search volume at the start of the selected window. 0 = not ranked that week.' : undefined}
            >
              {volSort ? VOLUME_WINDOW_LABEL[window] : WINDOW_LABEL[window]}
            </th>
```

- [ ] **Step 6: Δ header.** The Δ `SortableHeader` keeps its keys; label + title change (the title is accurate in BOTH modes — clicking it activates the volume sort):

```tsx
            <SortableHeader
              label={volSort ? 'Δ vol.' : 'Δ'}
              ascKey="decline"
              descKey="imp"
              firstClickKey="imp"
              currentSort={currentSort}
              align="right"
              title="Click to sort by estimated search-volume change in the selected window. First click shows biggest improvements first. Keywords whose volume can't be estimated for the comparison week are hidden under this sort."
            />
```

- [ ] **Step 7: Prior cell.** The prior-rank `<td>` body becomes:

```tsx
              <td className="p-2 text-right tabular-nums text-gray-600">
                {volSort
                  ? <PriorVolumeCell r={r} />
                  : (r.priorRank?.toLocaleString() ?? <span className="text-gray-400">—</span>)}
              </td>
```

- [ ] **Step 8: Δ cell.** The improvement `<td>` body becomes:

```tsx
              <td className="p-2 text-right tabular-nums">
                {volSort
                  ? (r.volumeDelta !== null
                      ? <DeltaVolCell value={r.volumeDelta} />
                      : <span className="text-gray-400">—</span>)
                  : (r.improvement !== null
                      ? <DeltaCell value={r.improvement} />
                      : <span className="text-gray-400">—</span>)}
              </td>
```

- [ ] **Step 9: New helpers** next to `DeltaCell`. First extract the numeric body of `formatVolume` into `formatVolumeCompact` — thresholds MUST match the existing `formatVolume` exactly (read it; expected: ≥1M → `x.xM`, ≥10K → `xK`, else `toLocaleString()`), and `formatVolume` becomes null-guard + `formatVolumeCompact(n)`:

```tsx
/** Compact magnitude shared by formatVolume + DeltaVolCell. */
function formatVolumeCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

/** Signed compact volume delta; same color convention as the rank DeltaCell. */
function DeltaVolCell({ value }: { value: number }) {
  if (value === 0) return <span className="text-gray-500">0</span>;
  const compact = formatVolumeCompact(Math.abs(value));
  if (value > 0) {
    return <span className="text-green-700" title={`+${value.toLocaleString()} searches / month (est.)`}>+{compact}</span>;
  }
  return <span className="text-red-700" title={`${value.toLocaleString()} searches / month (est.)`}>-{compact}</span>;
}

/**
 * Prior-window volume under the swap: 0 = newcomer (unranked then); em-dash =
 * no fit for that week. Keyed on priorRank/volumePrior, NOT volumeDelta, so the
 * watchlist's legal "prior present, delta null" rows still show their prior.
 * (Amended 2026-07-16 after Task 3 review.)
 */
function PriorVolumeCell({ r }: { r: ExplorerRow }) {
  if (r.priorRank === null) return <span title="Not ranked that week">0</span>;
  if (r.volumePrior === null) return <span className="text-gray-400">—</span>;
  return (
    <span title={`${r.volumePrior.toLocaleString()} searches / month (est.)`}>
      {formatVolume(r.volumePrior)}
    </span>
  );
}
```

- [ ] **Step 10: Verify:** `pnpm typecheck && pnpm test` → green (524+ incl. Task 1's).

- [ ] **Step 11: Commit:**

```bash
git add "app/(app)/explorer/FilterSidebar.tsx" "app/(app)/explorer/ResultsTable.tsx"
git commit -m "feat(explorer): search-volume sort labels + context-swapped vol-prior/Δ-vol columns

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Migration 0044 + gated apply script + EXPLAIN verify script (code only — DO NOT APPLY)

**Files:**
- Create: `db/migrations/0044_kcs_vol_delta_indexes.sql`
- Create: `scripts/applyMigration0044.ts`
- Create: `scripts/verifyVolDeltaPlan0716.ts` (throwaway — do NOT `git add` it; scripts/ throwaways stay untracked by convention)
- Modify: `db/schema/keywordCurrentSummary.ts` (comment only)

- [ ] **Step 1: Write `db/migrations/0044_kcs_vol_delta_indexes.sql`** — all 10 statements, expression/predicate byte-identical to Task 1's helpers with alias stripped. The 4w pair shown in full; 13w/26w/52w follow the same shape with their columns; 1w uses `prior_week_rank` + `estimated_monthly_volume_1w_ago`:

```sql
-- 0044: partial expression indexes for the volume-delta imp/decline sorts
-- (spec docs/superpowers/specs/2026-07-16-volume-movement-sort-design.md).
--
-- Expression + predicate MUST stay byte-identical (alias stripped) with
-- volumeDeltaExpr / volumeDeltaEligibility in lib/explorer/buildQuery.ts or
-- the planner won't match. Partial => entries only for computable deltas, so
-- the ORDER BY needs no NULLS handling and ONE index serves both directions
-- (forward scan = decline ASC, backward = imp DESC).
--
-- Twins on BOTH physical tables: the weekly refresh RENAME-swaps
-- keyword_current_summary <-> _stage and indexes travel with their physical
-- table — a single-sided index goes missing every other week (see 0041).
-- 1w uses prior_week_rank (kcs has no rank_1w_ago).

CREATE INDEX IF NOT EXISTS kcs_vol_delta_1w_idx
  ON keyword_current_summary
  (((estimated_monthly_volume_current - CASE WHEN prior_week_rank IS NULL THEN 0 ELSE estimated_monthly_volume_1w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (prior_week_rank IS NULL OR estimated_monthly_volume_1w_ago IS NOT NULL);

CREATE INDEX IF NOT EXISTS kcs_vol_delta_4w_idx
  ON keyword_current_summary
  (((estimated_monthly_volume_current - CASE WHEN rank_4w_ago IS NULL THEN 0 ELSE estimated_monthly_volume_4w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (rank_4w_ago IS NULL OR estimated_monthly_volume_4w_ago IS NOT NULL);

-- kcs_vol_delta_13w_idx / kcs_vol_delta_26w_idx / kcs_vol_delta_52w_idx: same
-- shape on keyword_current_summary with rank_13w_ago/estimated_monthly_volume_13w_ago,
-- rank_26w_ago/estimated_monthly_volume_26w_ago, rank_52w_ago/estimated_monthly_volume_52w_ago.
-- (WRITE ALL THREE OUT IN FULL — this comment is for the plan reader, not the file.)

CREATE INDEX IF NOT EXISTS kcs_stage_vol_delta_1w_idx
  ON keyword_current_summary_stage
  (((estimated_monthly_volume_current - CASE WHEN prior_week_rank IS NULL THEN 0 ELSE estimated_monthly_volume_1w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (prior_week_rank IS NULL OR estimated_monthly_volume_1w_ago IS NOT NULL);

-- kcs_stage_vol_delta_{4w,13w,26w,52w}_idx: same five expressions on
-- keyword_current_summary_stage. (WRITE ALL FOUR OUT IN FULL.)
```

The final file contains exactly **10 `CREATE INDEX IF NOT EXISTS` statements** and no plan-reader comments.

- [ ] **Step 2: Write `scripts/applyMigration0044.ts`.** First read `scripts/applyMigration0043.ts` — if present, replicate its structure exactly (gate env var name `APPLY_0044`, file path swapped). If it's absent, use:

```ts
// Gated one-off: applies db/migrations/0044_kcs_vol_delta_indexes.sql (10
// CREATE INDEX IF NOT EXISTS; ~30-60s each on ~4M-row kcs). Owner-run only:
//   APPLY_0044=yes npx tsx scripts/applyMigration0044.ts
import { config } from 'dotenv';
config({ path: '.env.local' });

import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

async function main() {
  if (process.env.APPLY_0044 !== 'yes') {
    console.error('Refusing to run: set APPLY_0044=yes to apply migration 0044.');
    process.exit(1);
  }
  const raw = readFileSync('db/migrations/0044_kcs_vol_delta_indexes.sql', 'utf8');
  const statements = raw
    .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    for (const [i, stmt] of statements.entries()) {
      const t = Date.now();
      await client.query(stmt);
      console.log(`[${i + 1}/${statements.length}] ${((Date.now() - t) / 1000).toFixed(1)}s  ${stmt.replace(/\s+/g, ' ').slice(0, 80)}…`);
    }
  } finally {
    client.release();
    await pool.end();
  }
  console.log('0044 applied.');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Schema breadcrumb.** In `db/schema/keywordCurrentSummary.ts`, extend the indexes callback comment block (near the existing jump-index comment) with:

```ts
    // Volume-delta partial expression indexes for the imp/decline sorts live
    // in raw SQL only (drizzle-kit can't emit expression indexes) — see
    // migration 0044 + volumeDeltaExpr in lib/explorer/buildQuery.ts.
```

- [ ] **Step 4: Write `scripts/verifyVolDeltaPlan0716.ts`** (throwaway; run happens in Task 7 with the owner):

```ts
// Throwaway (2026-07-16): EXPLAIN the volume-delta sorts after applying 0044.
// Verifies (a) unfiltered imp/decline use the partial indexes both directions,
// (b) filtered queries do NOT fall into the walk-the-sort-index planner trap.
import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';

const DELTA_4W = '(estimated_monthly_volume_current - CASE WHEN rank_4w_ago IS NULL THEN 0 ELSE estimated_monthly_volume_4w_ago END)';
const ELIGIBLE_4W = 'estimated_monthly_volume_current IS NOT NULL AND (rank_4w_ago IS NULL OR estimated_monthly_volume_4w_ago IS NOT NULL)';

async function explain(sql: ReturnType<typeof neon>, label: string, q: string) {
  const rows = (await sql.query(`EXPLAIN ${q}`)) as Array<Record<string, string>>;
  console.log(`\n=== ${label} ===`);
  for (const r of rows) console.log(' ', Object.values(r)[0]);
}

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const base = `FROM keyword_current_summary kcs WHERE ${ELIGIBLE_4W.replace(/estimated_monthly/g, 'kcs.estimated_monthly').replace(/rank_4w_ago/g, 'kcs.rank_4w_ago')}`;

  await explain(sql, 'imp unfiltered (expect Index Scan Backward on kcs_vol_delta_4w_idx or its stage twin)',
    `SELECT kcs.search_term_id ${base} ORDER BY (kcs.estimated_monthly_volume_current - CASE WHEN kcs.rank_4w_ago IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_4w_ago END) DESC LIMIT 51`);

  await explain(sql, 'decline unfiltered (expect forward Index Scan on the same index)',
    `SELECT kcs.search_term_id ${base} ORDER BY (kcs.estimated_monthly_volume_current - CASE WHEN kcs.rank_4w_ago IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_4w_ago END) ASC LIMIT 51`);

  await explain(sql, 'imp + selective category path (expect the leaf-path/category index driving, NOT a full sort-index walk)',
    `SELECT kcs.search_term_id ${base} AND kcs.top_clicked_category_path = (SELECT top_clicked_category_path FROM keyword_current_summary WHERE top_clicked_category_path IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC OFFSET 40 LIMIT 1)
     ORDER BY (kcs.estimated_monthly_volume_current - CASE WHEN kcs.rank_4w_ago IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_4w_ago END) DESC LIMIT 51`);

  console.log('\n(1w spot-check)');
  await explain(sql, 'imp unfiltered 1w (expect kcs_vol_delta_1w_idx family)',
    `SELECT kcs.search_term_id FROM keyword_current_summary kcs
     WHERE kcs.estimated_monthly_volume_current IS NOT NULL AND (kcs.prior_week_rank IS NULL OR kcs.estimated_monthly_volume_1w_ago IS NOT NULL)
     ORDER BY (kcs.estimated_monthly_volume_current - CASE WHEN kcs.prior_week_rank IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_1w_ago END) DESC LIMIT 51`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: Verify code-only:** `pnpm typecheck` green. **Do NOT run either script** (DDL + prod reads are owner-gated, Task 7).

- [ ] **Step 6: Commit (migration + apply script + schema comment; the verify script stays untracked):**

```bash
git add db/migrations/0044_kcs_vol_delta_indexes.sql scripts/applyMigration0044.ts db/schema/keywordCurrentSummary.ts
git commit -m "feat(db): migration 0044 — partial expression index twins for volume-delta sorts (not yet applied)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Full verification (subagent: suite + build; controller: visual E2E after 0044 applies)

- [ ] **Step 1 (subagent):** `pnpm typecheck && pnpm test && pnpm build` → all green (test count ≥ 524 + Task 1's new tests). Report exact counts.
- [ ] **Step 2 (controller, main session, AFTER Task 7 Step 2 applies 0044):** dev server → explorer → sort "Biggest improvement (search volume)": columns swap (Est. vol. ago + Δ vol.), deltas colored/signed, newcomers show prior 0 with tooltip; decline sort; switch to rank sort → layout reverts; watchlist Δ-vol sort shows all rows (— for non-computable); a saved view with `imp` loads sorted by volume.

### Task 7: Ship — owner-gated checkpoints (controller + owner)

- [ ] **Step 1:** `npx tsx scripts/checkActiveJobs.ts` → worker quiet; confirm with owner.
- [ ] **Step 2:** Owner green-lights DDL → `APPLY_0044=yes npx tsx scripts/applyMigration0044.ts` (expect 10 × ok, ~30–60s each; plain CREATE INDEX briefly blocks writes to kcs — fine while the worker is quiet; reads unaffected).
- [ ] **Step 3:** `npx tsx scripts/verifyVolDeltaPlan0716.ts` → owner-visible EXPLAIN output shows partial-index scans both directions + no planner trap on the filtered shape. (Plus Task 6 Step 2 visual E2E now.)
- [ ] **Step 4:** Owner authorizes push → push → Vercel deploy → prod spot-check (sort on prod, swap + speed).
- [ ] **Step 5:** Note for the next weekly import: read the refresh delta off `import_phase_timings` and report it against the ~3h baseline.

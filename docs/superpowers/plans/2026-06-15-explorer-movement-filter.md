# Explorer Movement Filter + Volume Column Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SFR threshold-jump and the eight per-horizon volume min/max filters with a single Rank⇄Volume "Movement" filter, trim the results table to just the current Est. monthly volume column, and add a 1-week volume column so Volume mode reaches full window parity with Rank.

**Architecture:** A single source of truth for jump presets (`lib/explorer/jumpPresets.ts`) feeds the parser, the query builder, and the sidebar. `buildExplorerQuery` gains a metric-aware jump branch (rank columns vs. volume columns); the volume min/max WHERE loop, the four lookback volume SELECT columns, and the four volume sort keys are removed. A new `estimated_monthly_volume_1w_ago` kcs column (migration + refresh wiring) is computed from the already-staged 1-week rank.

**Tech Stack:** Next.js 16 App Router, Postgres/Neon + Drizzle, node-postgres (worker refresh), Vitest. Spec: `docs/superpowers/specs/2026-06-15-explorer-movement-filter-design.md`.

**Ordering principle:** additions first (build stays green), UI switch next, dead-plumbing removal last. Run `pnpm typecheck` after every task; run the named Vitest file after every TDD task.

---

## File map

| File | Responsibility / change |
|---|---|
| `db/migrations/0035_kcs_volume_1w.sql` | **new** — 1w volume column + index on both swap tables |
| `db/schema/keywordCurrentSummary.ts` | add `estimatedMonthlyVolume1wAgo` + `estVol1wIdx` |
| `inngest/functions/refreshSummary.ts` | add the 1w volume horizon + INSERT/SELECT slot |
| `lib/explorer/jumpPresets.ts` | **new** — rank + volume preset tables + lookup helpers |
| `lib/explorer/types.ts` | add `jumpMetric`; extend `JumpKey`; drop 8 volume filter fields + 8 volume sort keys + 4 lookback row fields |
| `lib/explorer/parseFilters.ts` | parse `jump_metric`, accept volume presets, infer metric from preset, per-metric custom validation; drop volume params |
| `lib/explorer/buildQuery.ts` | metric-aware jump; drop volume min/max loop, volume sorts, lookback SELECT cols |
| `lib/explorer/runQuery.ts` | drop 4 lookback fields from `RawRow`/SELECT/mapper |
| `lib/explorer/fetchExplorerRowsByIds.ts` | drop 4 lookback fields from `RawRow`/SELECT/mapper |
| `lib/savedViews/validation.ts`, `loadServer.ts` | serialize `jumpMetric`; ignore removed volume params |
| `app/(app)/explorer/FilterSidebar.tsx` | Movement card (toggle + window + presets + custom); remove volume min/max + volume sorts |
| `app/(app)/explorer/ResultsTable.tsx` | remove 4 lookback volume columns |

---

## Phase 1 — 1-week volume data

### Task 1: Migration 0035 + schema

**Files:**
- Create: `db/migrations/0035_kcs_volume_1w.sql`
- Modify: `db/schema/keywordCurrentSummary.ts`

- [ ] **Step 1: Write the migration SQL** (mirrors 0034 — one column + one index on each swap table; `IF NOT EXISTS` for idempotency)

```sql
-- 0035_kcs_volume_1w.sql
-- 1-week-ago estimated monthly volume, for Volume-mode Movement jumps at the
-- 1w window. Added to BOTH swap tables so it survives the stage/live rotation.
ALTER TABLE keyword_current_summary       ADD COLUMN IF NOT EXISTS estimated_monthly_volume_1w_ago bigint;
ALTER TABLE keyword_current_summary_stage ADD COLUMN IF NOT EXISTS estimated_monthly_volume_1w_ago bigint;

CREATE INDEX IF NOT EXISTS kcs_est_vol_1w_idx
  ON keyword_current_summary (current_week_end_date, estimated_monthly_volume_1w_ago);
CREATE INDEX IF NOT EXISTS kcs_stage_est_vol_1w_idx
  ON keyword_current_summary_stage (current_week_end_date, estimated_monthly_volume_1w_ago);
```

- [ ] **Step 2: Add the column + index to the Drizzle schema**

In `db/schema/keywordCurrentSummary.ts`, add the column next to the other lookback volumes (after `estimatedMonthlyVolume52wAgo`):

```ts
    estimatedMonthlyVolume1wAgo: bigint('estimated_monthly_volume_1w_ago', { mode: 'number' }),
```

and add the index inside the indexes object (next to `estVol52wIdx`):

```ts
    estVol1wIdx: index('kcs_est_vol_1w_idx').on(t.currentWeekEndDate, t.estimatedMonthlyVolume1wAgo),
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: passes (additive column/index).

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0035_kcs_volume_1w.sql db/schema/keywordCurrentSummary.ts
git commit -m "feat(explorer): migration 0035 — 1-week volume column on both kcs tables"
```

> **Note:** the migration is **applied to Neon in Task 9** (rollout), with explicit user confirmation, exactly as 0034 was applied. Do not apply it here.

---

### Task 2: Refresh computes 1-week volume

**Files:**
- Modify: `inngest/functions/refreshSummary.ts` (VOLUME_HORIZONS ~130-138; INSERT col list ~216-218; SELECT exprs ~273-277)

The 1-week rank is already staged as `rank_at_1w` and joined as `r1` (used for `prior_week_rank`), so this is one extra horizon over data we already have.

- [ ] **Step 1: Add the 1w horizon** — replace the `VOLUME_HORIZONS` block + its index comment:

```ts
    const VOLUME_HORIZONS = [
      { weeks: 0, rankCol: 'l.actual_rank' },
      { weeks: 1, rankCol: 'r1.actual_rank' },
      { weeks: 4, rankCol: 'r4.actual_rank' },
      { weeks: 13, rankCol: 'r13.actual_rank' },
      { weeks: 26, rankCol: 'r26.actual_rank' },
      { weeks: 52, rankCol: 'r52.actual_rank' },
    ] as const;
    const volume = buildVolumeExpressions(currentWeekEndDate, fits, VOLUME_HORIZONS, 2);
    // volume.exprs[0]=current, [1]=1w, [2]=4w, [3]=13w, [4]=26w, [5]=52w
```

- [ ] **Step 2: Add the column to the INSERT list** — replace the two volume lines (~216-218):

```ts
        estimated_monthly_volume_current, estimated_monthly_volume_1w_ago,
        estimated_monthly_volume_4w_ago, estimated_monthly_volume_13w_ago,
        estimated_monthly_volume_26w_ago, estimated_monthly_volume_52w_ago,
```

- [ ] **Step 3: Add + re-index the SELECT exprs** — replace the five volume expr lines (~273-277):

```ts
        ${volume.exprs[0]} AS estimated_monthly_volume_current,
        ${volume.exprs[1]} AS estimated_monthly_volume_1w_ago,
        ${volume.exprs[2]} AS estimated_monthly_volume_4w_ago,
        ${volume.exprs[3]} AS estimated_monthly_volume_13w_ago,
        ${volume.exprs[4]} AS estimated_monthly_volume_26w_ago,
        ${volume.exprs[5]} AS estimated_monthly_volume_52w_ago,
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: passes. (No refresh unit test exists; the INSERT column count must equal the SELECT column count — verify by eye that both lists now have six volume entries in the same order.)

- [ ] **Step 5: Commit**

```bash
git add inngest/functions/refreshSummary.ts
git commit -m "feat(explorer): compute 1-week estimated volume in the summary refresh"
```

---

## Phase 2 — Metric-aware jump (pure logic, TDD)

### Task 3: Jump preset source of truth + type additions

**Files:**
- Create: `lib/explorer/jumpPresets.ts`
- Modify: `lib/explorer/types.ts`
- Test: `lib/explorer/jumpPresets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/explorer/jumpPresets.test.ts
import { describe, it, expect } from 'vitest';
import { RANK_JUMP_PRESETS, VOLUME_JUMP_PRESETS, jumpPresetsFor, findJumpPreset } from './jumpPresets';

describe('jumpPresets', () => {
  it('exposes the four volume presets with correct thresholds', () => {
    expect(VOLUME_JUMP_PRESETS.map((p) => [p.id, p.from, p.to])).toEqual([
      ['v5k_to_15k', 5000, 15000],
      ['v15k_to_30k', 15000, 30000],
      ['v30k_to_100k', 30000, 100000],
      ['v15k_to_100k', 15000, 100000],
    ]);
  });
  it('keeps the four rank presets', () => {
    expect(RANK_JUMP_PRESETS.map((p) => p.id)).toEqual([
      '500k_to_100k', '100k_to_50k', '100k_to_10k', '50k_to_10k',
    ]);
  });
  it('jumpPresetsFor returns the metric-appropriate list', () => {
    expect(jumpPresetsFor('volume')).toBe(VOLUME_JUMP_PRESETS);
    expect(jumpPresetsFor('rank')).toBe(RANK_JUMP_PRESETS);
  });
  it('findJumpPreset infers metric from id', () => {
    expect(findJumpPreset('v15k_to_30k')?.metric).toBe('volume');
    expect(findJumpPreset('100k_to_50k')?.metric).toBe('rank');
    expect(findJumpPreset('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/explorer/jumpPresets.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `jumpPresets.ts`**

```ts
// lib/explorer/jumpPresets.ts
export type JumpMetric = 'rank' | 'volume';

export interface JumpPreset {
  id: string;
  label: string;
  from: number;
  to: number;
}

export const RANK_JUMP_PRESETS: readonly JumpPreset[] = [
  { id: '500k_to_100k', label: '500k → 100k', from: 500_000, to: 100_000 },
  { id: '100k_to_50k',  label: '100k → 50k',  from: 100_000, to: 50_000 },
  { id: '100k_to_10k',  label: '100k → 10k',  from: 100_000, to: 10_000 },
  { id: '50k_to_10k',   label: '50k → 10k',   from: 50_000,  to: 10_000 },
];

export const VOLUME_JUMP_PRESETS: readonly JumpPreset[] = [
  { id: 'v5k_to_15k',   label: 'Under 5k → over 15k',   from: 5_000,  to: 15_000 },
  { id: 'v15k_to_30k',  label: 'Under 15k → over 30k',  from: 15_000, to: 30_000 },
  { id: 'v30k_to_100k', label: 'Under 30k → over 100k', from: 30_000, to: 100_000 },
  { id: 'v15k_to_100k', label: 'Under 15k → over 100k', from: 15_000, to: 100_000 },
];

export function jumpPresetsFor(metric: JumpMetric): readonly JumpPreset[] {
  return metric === 'volume' ? VOLUME_JUMP_PRESETS : RANK_JUMP_PRESETS;
}

export function findJumpPreset(id: string): { metric: JumpMetric; preset: JumpPreset } | null {
  const r = RANK_JUMP_PRESETS.find((p) => p.id === id);
  if (r) return { metric: 'rank', preset: r };
  const v = VOLUME_JUMP_PRESETS.find((p) => p.id === id);
  if (v) return { metric: 'volume', preset: v };
  return null;
}
```

- [ ] **Step 4: Extend types** in `lib/explorer/types.ts`:

Add the four volume ids to `JumpKey` (keep `custom`):

```ts
export type JumpKey =
  | '500k_to_100k' | '100k_to_50k' | '100k_to_10k' | '50k_to_10k'
  | 'v5k_to_15k' | 'v15k_to_30k' | 'v30k_to_100k' | 'v15k_to_100k'
  | 'custom';
```

Add `jumpMetric` to `ExplorerFilters` (next to `jump`):

```ts
  /** Which metric the Movement jump compares: rank columns or volume columns. */
  jumpMetric: 'rank' | 'volume';
```

> Leave the 8 volume filter fields, 8 volume sort keys, and 4 `ExplorerRow` lookback fields in place for now — they are removed in Task 8 once nothing uses them.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run lib/explorer/jumpPresets.test.ts` → PASS
Run: `pnpm typecheck` → still passes (adding a required `jumpMetric` to the interface will fail typecheck until `EXPLORER_DEFAULTS` sets it — that happens in Task 4 Step 3; if you do Task 3 and 4 back-to-back the window is brief. If typecheck must stay green between tasks, add `jumpMetric: 'rank'` to `EXPLORER_DEFAULTS` now as part of this step.)

- [ ] **Step 6: Commit**

```bash
git add lib/explorer/jumpPresets.ts lib/explorer/jumpPresets.test.ts lib/explorer/types.ts
git commit -m "feat(explorer): jump-preset source of truth + jumpMetric type"
```

---

### Task 4: Parser — jumpMetric, volume presets, per-metric custom validation

**Files:**
- Modify: `lib/explorer/parseFilters.ts`
- Test: `lib/explorer/parseFilters.test.ts` (create if absent)

- [ ] **Step 1: Write the failing tests**

```ts
// add to lib/explorer/parseFilters.test.ts
import { describe, it, expect } from 'vitest';
import { parseExplorerFilters } from './parseFilters';

describe('parseExplorerFilters — Movement jump', () => {
  it('defaults jumpMetric to rank', () => {
    expect(parseExplorerFilters({}).jumpMetric).toBe('rank');
  });
  it('parses jump_metric=volume', () => {
    expect(parseExplorerFilters({ jump_metric: 'volume' }).jumpMetric).toBe('volume');
  });
  it('infers volume metric from a volume preset id', () => {
    const f = parseExplorerFilters({ jump: 'v15k_to_30k' });
    expect(f.jump).toBe('v15k_to_30k');
    expect(f.jumpMetric).toBe('volume');
  });
  it('infers rank metric from a rank preset id', () => {
    const f = parseExplorerFilters({ jump: '100k_to_50k', jump_metric: 'volume' });
    expect(f.jumpMetric).toBe('rank'); // preset wins over the param
  });
  it('rank custom requires from > to', () => {
    const ok = parseExplorerFilters({ jump: 'custom', jump_metric: 'rank', jump_from: '100000', jump_to: '50000' });
    expect(ok.jump).toBe('custom');
    const bad = parseExplorerFilters({ jump: 'custom', jump_metric: 'rank', jump_from: '50000', jump_to: '100000' });
    expect(bad.jump).toBeNull();
  });
  it('volume custom requires from < to', () => {
    const ok = parseExplorerFilters({ jump: 'custom', jump_metric: 'volume', jump_from: '5000', jump_to: '15000' });
    expect(ok.jump).toBe('custom');
    const bad = parseExplorerFilters({ jump: 'custom', jump_metric: 'volume', jump_from: '15000', jump_to: '5000' });
    expect(bad.jump).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/explorer/parseFilters.test.ts`
Expected: FAIL (`jumpMetric` undefined / inference not implemented).

- [ ] **Step 3: Implement.** In `parseFilters.ts`:

Add `jumpMetric: 'rank'` to `EXPLORER_DEFAULTS`.

Import the preset helper at the top:

```ts
import { findJumpPreset, type JumpMetric } from './jumpPresets';
```

Replace the `JUMP_VALUES` constant so it accepts the volume ids too:

```ts
const JUMP_VALUES: JumpKey[] = [
  '500k_to_100k', '100k_to_50k', '100k_to_10k', '50k_to_10k',
  'v5k_to_15k', 'v15k_to_30k', 'v30k_to_100k', 'v15k_to_100k',
  'custom',
];
```

Replace the jump-parsing block (currently ~126-134) with metric-aware logic:

```ts
  let jump = parseEnumNullable(getOne(searchParams.jump), JUMP_VALUES);
  let jumpMetric: JumpMetric = parseEnum(getOne(searchParams.jump_metric), ['rank', 'volume'] as const, 'rank');
  const jumpFrom = parsePositiveInt(getOne(searchParams.jump_from));
  const jumpTo = parsePositiveInt(getOne(searchParams.jump_to));
  // A preset is self-describing: infer the metric from it (so old/shared URLs
  // with just ?jump=v15k_to_30k work). jump_metric only governs 'custom'.
  if (jump && jump !== 'custom') {
    const found = findJumpPreset(jump);
    if (found) jumpMetric = found.metric;
  }
  // Drop a custom jump whose thresholds aren't valid for its metric:
  //   rank  improves as the number falls  → from > to
  //   volume improves as the number rises → from < to
  if (jump === 'custom') {
    const ordered = jumpFrom !== null && jumpTo !== null
      && (jumpMetric === 'rank' ? jumpFrom > jumpTo : jumpFrom < jumpTo);
    if (!ordered) jump = null;
  }
```

Add `jumpMetric` to the returned object (next to `jump`):

```ts
    jump,
    jumpMetric,
    jumpFrom: jump === 'custom' ? jumpFrom : null,
    jumpTo: jump === 'custom' ? jumpTo : null,
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run lib/explorer/parseFilters.test.ts` → PASS
Run: `pnpm typecheck` → PASS

- [ ] **Step 5: Commit**

```bash
git add lib/explorer/parseFilters.ts lib/explorer/parseFilters.test.ts
git commit -m "feat(explorer): parse jumpMetric + per-metric custom validation"
```

---

### Task 5: Query builder — metric-aware jump

**Files:**
- Modify: `lib/explorer/buildQuery.ts`
- Test: `lib/explorer/buildQuery.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `buildQuery.test.ts`)

```ts
  describe('Movement jump — metric-aware', () => {
    it('rank preset emits the rank-column jump clause (unchanged behavior)', () => {
      const { sql, countArgs } = buildExplorerQuery({ ...baseFilters, jump: '500k_to_100k', jumpMetric: 'rank' });
      expect(norm(sql)).toContain('kcs.prior_week_rank >');
      expect(norm(sql)).toContain('kcs.current_rank <');
      expect(countArgs).toContain(500_000);
      expect(countArgs).toContain(100_000);
    });

    it('volume preset emits the volume-column jump clause', () => {
      const { sql, countArgs } = buildExplorerQuery({
        ...baseFilters, window: '13w', jump: 'v15k_to_30k', jumpMetric: 'volume',
      });
      expect(norm(sql)).toContain('kcs.estimated_monthly_volume_13w_ago <');
      expect(norm(sql)).toContain('kcs.estimated_monthly_volume_current >');
      expect(countArgs).toContain(15_000);
      expect(countArgs).toContain(30_000);
    });

    it('volume jump at 1w uses the 1w volume column', () => {
      const { sql } = buildExplorerQuery({
        ...baseFilters, window: '1w', jump: 'v5k_to_15k', jumpMetric: 'volume',
      });
      expect(norm(sql)).toContain('kcs.estimated_monthly_volume_1w_ago <');
    });

    it('volume custom uses jumpFrom/jumpTo', () => {
      const { sql, countArgs } = buildExplorerQuery({
        ...baseFilters, window: '4w', jump: 'custom', jumpMetric: 'volume', jumpFrom: 5000, jumpTo: 15000,
      });
      expect(norm(sql)).toContain('kcs.estimated_monthly_volume_4w_ago <');
      expect(norm(sql)).toContain('kcs.estimated_monthly_volume_current >');
      expect(countArgs).toContain(5000);
      expect(countArgs).toContain(15000);
    });
  });
```

> Note: `baseFilters` must include `jumpMetric: 'rank'` once `ExplorerFilters` requires it — it already spreads `EXPLORER_DEFAULTS`, which sets it in Task 4. No change needed to the existing `baseFilters` line.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/explorer/buildQuery.test.ts`
Expected: FAIL (volume jump emits rank clause / wrong columns).

- [ ] **Step 3: Implement.** In `buildQuery.ts`:

Add the import:

```ts
import { findJumpPreset } from './jumpPresets';
```

Add the window→volume-column map next to `WINDOW_TO_RANK_COLUMN`:

```ts
const WINDOW_TO_VOLUME_COLUMN: Record<WindowKey, string> = {
  '1w': 'estimated_monthly_volume_1w_ago',
  '4w': 'estimated_monthly_volume_4w_ago',
  '13w': 'estimated_monthly_volume_13w_ago',
  '26w': 'estimated_monthly_volume_26w_ago',
  '52w': 'estimated_monthly_volume_52w_ago',
};
```

Delete the `JUMP_THRESHOLDS` constant and the `PresetJumpKey` type (replaced by `jumpPresets`). Replace the existing jump branch (section 1.4) with:

```ts
  // 1.4 — Movement jump. Resolve (from, to) from a preset or custom inputs,
  // then emit the clause for the selected metric. Both directions mean
  // "got better": rank improves as the number falls, volume as it rises.
  if (filters.jump) {
    let from: number | null = null;
    let to: number | null = null;
    if (filters.jump === 'custom') {
      from = filters.jumpFrom;
      to = filters.jumpTo;
    } else {
      const found = findJumpPreset(filters.jump);
      if (found) { from = found.preset.from; to = found.preset.to; }
    }
    if (from !== null && to !== null) {
      if (filters.jumpMetric === 'volume') {
        const volCol = WINDOW_TO_VOLUME_COLUMN[filters.window];
        where.push(`kcs.${volCol} < ${next(from)} AND kcs.estimated_monthly_volume_current > ${next(to)}`);
      } else {
        where.push(`kcs.${priorRankCol} > ${next(from)} AND kcs.current_rank < ${next(to)}`);
      }
    }
  }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run lib/explorer/buildQuery.test.ts` → PASS (existing rank-jump tests still green; new volume tests green)
Run: `pnpm typecheck` → PASS

- [ ] **Step 5: Commit**

```bash
git add lib/explorer/buildQuery.ts lib/explorer/buildQuery.test.ts
git commit -m "feat(explorer): metric-aware Movement jump in the query builder"
```

---

## Phase 3 — UI

### Task 6: FilterSidebar — the Movement card

**Files:**
- Modify: `app/(app)/explorer/FilterSidebar.tsx`

> Read the current file first. It has: a `PendingFilters` type, `filtersToPending` / `pendingToParams` mappers, the existing jump UI (preset `<select>` + custom inputs driven by `window`/`jump`/`jumpFrom`/`jumpTo`), the four volume min/max `FieldGroup` pairs (a `.map` over four horizons), and a `SORTS` array.

- [ ] **Step 1: Remove the volume min/max inputs** — delete the `.map` that renders the four volume `FieldGroup` min/max pairs and the matching `PendingFilters` keys / `filtersToPending` / `pendingToParams` entries for `vol_*w_min|max`.

- [ ] **Step 2: Remove volume sort options** — in the `SORTS` array delete the four volume entries (`vol_4w_*`, `vol_13w_*`, `vol_26w_*`, `vol_52w_*` labels).

- [ ] **Step 3: Build the Movement card.** Import the presets:

```tsx
import { jumpPresetsFor, type JumpMetric } from '@/lib/explorer/jumpPresets';
```

Add `jumpMetric` to `PendingFilters`, to `filtersToPending` (`jumpMetric: filters.jumpMetric`), and to `pendingToParams` (emit `jump_metric` only when `jumpMetric === 'volume'`, to keep default URLs clean). Render a card containing, in order:
- a **metric toggle** (two buttons or a segmented control) bound to `pending.jumpMetric` — labels `Rank` and `Volume`;
- the existing **window `<select>`** (1w/4w/13w/26w/52w), relocated into this card;
- a **preset `<select>`** whose options come from `jumpPresetsFor(pending.jumpMetric)` (map `p.id`→`p.label`), plus an empty "Any" option and a `custom` option;
- when `jump === 'custom'`, two number inputs with **metric-aware labels**:
  - Rank: "Was ranked worse than" (`jump_from`) / "Now ranked better than" (`jump_to`)
  - Volume: "Had fewer than (searches/mo)" (`jump_from`) / "Now has more than (searches/mo)" (`jump_to`)

When the user flips the metric toggle, reset `pending.jump` to empty (a rank preset id is invalid under volume and vice-versa).

- [ ] **Step 4: Typecheck + manual render check**

Run: `pnpm typecheck` → PASS
Run: `pnpm dev`, open `/explorer`: the Movement card shows the toggle/window/preset; switching to Volume shows the four volume presets; the eight volume min/max boxes are gone.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/explorer/FilterSidebar.tsx"
git commit -m "feat(explorer): unified Movement filter card; remove volume min/max inputs"
```

---

### Task 7: ResultsTable — drop the lookback volume columns

**Files:**
- Modify: `app/(app)/explorer/ResultsTable.tsx`

> Read the current file first. It renders, for volume, a current-volume column plus four lookback columns (`vol_4w`/`vol_13w`/`vol_26w`/`vol_52w` `SortableHeader`s + matching `<td>`s using `formatVolume`).

- [ ] **Step 1: Remove the four lookback volume `SortableHeader`s** (keep the current Est. monthly volume header).

- [ ] **Step 2: Remove the four matching `<td>` cells** (keep the current-volume cell).

- [ ] **Step 3: Verify header/cell balance** — count `<th>` vs `<td>` in a row; they must match. Typecheck.

Run: `pnpm typecheck` → PASS

- [ ] **Step 4: Manual check** — `/explorer` shows one volume column (current); no 4w/13w/26w/52w volume columns.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/explorer/ResultsTable.tsx"
git commit -m "feat(explorer): show only current volume column in results table"
```

---

## Phase 4 — Remove dead plumbing + ship

### Task 8: Delete the volume min/max fields, volume sort keys, and lookback row fields

Nothing references these now (UI removed in Tasks 6-7). Remove them across the stack so the contracts are clean. Do all edits, then typecheck once.

**Files:** `lib/explorer/types.ts`, `lib/explorer/parseFilters.ts`, `lib/explorer/buildQuery.ts`, `lib/explorer/runQuery.ts`, `lib/explorer/fetchExplorerRowsByIds.ts`, `lib/savedViews/validation.ts`, `lib/savedViews/loadServer.ts`, and their tests.

- [ ] **Step 1: `types.ts`** — delete the 8 `volume{4,13,26,52}wAgoMin/Max` fields from `ExplorerFilters`; delete the 8 `vol_*` keys from `SortKey`; delete `estimatedMonthlyVolume{4,13,26,52}wAgo` from `ExplorerRow` (keep `estimatedMonthlyVolumeCurrent`).

- [ ] **Step 2: `parseFilters.ts`** — delete the 8 `volume*` locals (~151-158) and their entries in the returned object; delete the 8 `vol_*` entries from `SORT_VALUES`.

- [ ] **Step 3: `buildQuery.ts`** — delete the volume min/max `WHERE` loop (the `volCols` array + its `for`); delete the 8 `vol_*` cases in `buildOrderBy`; delete the four lookback volume columns from the SELECT list (keep `kcs.estimated_monthly_volume_current`).

- [ ] **Step 4: `runQuery.ts` + `fetchExplorerRowsByIds.ts`** — in each, delete the four lookback fields from `RawRow`, from the row mapper, and (runQuery) from any SELECT alias list; keep `estimated_monthly_volume_current` → `estimatedMonthlyVolumeCurrent`.

- [ ] **Step 5: `savedViews/validation.ts` + `loadServer.ts`** — delete serialization/deserialization of the 8 `vol_*_min|max` params; deserialization must simply **ignore** those params if present in an old stored view (no throw). Remove any reference to the deleted `vol_*` sort keys (an unknown sort already falls back to the default).

- [ ] **Step 6: Update tests** — delete the obsolete `buildQuery.test.ts` "volume lookback" cases that assert on `estimated_monthly_volume_4w_ago >=` / volume sort order, and any parseFilters/savedViews tests asserting on removed params. Keep the current-volume SELECT assertion.

- [ ] **Step 7: Typecheck + full unit run**

Run: `pnpm typecheck` → PASS
Run: `pnpm vitest run lib/explorer lib/savedViews` → PASS

- [ ] **Step 8: Commit**

```bash
git add lib/explorer lib/savedViews
git commit -m "refactor(explorer): remove volume min/max filters, volume sorts, and lookback row columns"
```

---

### Task 9: Saved-view jumpMetric round-trip + integration + rollout

**Files:** `lib/savedViews/validation.ts`, `loadServer.ts` (+ tests); then full verification + rollout.

- [ ] **Step 1: Write the failing saved-view test** (in the savedViews test file)

```ts
it('round-trips jumpMetric and ignores removed volume params', () => {
  const serialized = serializeView({ ...EXPLORER_DEFAULTS, jump: 'v15k_to_30k', jumpMetric: 'volume' });
  const back = deserializeView(serialized);
  expect(back.jumpMetric).toBe('volume');
  expect(back.jump).toBe('v15k_to_30k');
  // legacy stored params must not throw
  expect(() => deserializeView({ ...serialized, vol_4w_min: '1000' } as any)).not.toThrow();
});
```

> Match the actual serialize/deserialize function names in `lib/savedViews/validation.ts` when wiring this test.

- [ ] **Step 2: Run to verify it fails**, then add `jumpMetric` (and `jump_metric` param) to the saved-view serialize/deserialize whitelist. Re-run → PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/savedViews
git commit -m "feat(explorer): persist jumpMetric in saved views"
```

- [ ] **Step 4: Full verification**

Run: `pnpm typecheck` → PASS
Run: `pnpm test` → all green except the known pre-existing `inngest/functions/importFile.test.ts` failure (unrelated).

- [ ] **Step 5: Rollout (requires user action — pause and hand off):**
  1. **Apply migration 0035 to Neon** (with the user's explicit confirmation), the same way 0034 was applied. Verify the column + both indexes exist on `keyword_current_summary` and `keyword_current_summary_stage`.
  2. **Populate 1w volume:** run a manual refresh (`pnpm tsx scripts/refreshSummaryOnce.ts`) so `estimated_monthly_volume_1w_ago` is filled, or wait for the next weekly import. Until populated, a 1w Volume jump returns no rows.
  3. **Deploy:** push `main` (Vercel rebuilds the explorer UI/query; the worker picks up the refresh change). The migration must be applied before the deploy serves a 1w Volume jump.

- [ ] **Step 6: Manual E2E checklist**
  - Rank Movement jump (preset + custom) returns the same results as before.
  - Volume Movement jump at 1w / 4w / 13w returns rising-volume keywords; presets and custom both work.
  - Results table shows exactly one volume column (current).
  - An old saved view that used a volume min/max filter loads without error (the removed filter is simply absent).

---

## Self-review (author checklist — completed)

- **Spec coverage:** Part 1 table cleanup → Tasks 6,7,8. Movement filter (toggle/window/presets/custom/semantics) → Tasks 3,4,5,6. 1w volume → Tasks 1,2. Data-model changes → Tasks 3,8. Saved views/URL back-compat → Tasks 4,8,9. No-migration-beyond-1w → Task 1 only. All spec sections map to a task.
- **Placeholder scan:** none — every code step shows concrete code or exact identifiers to remove.
- **Type consistency:** `jumpMetric: 'rank' | 'volume'` and the `JumpPreset`/`findJumpPreset`/`jumpPresetsFor` names are used identically across Tasks 3–6; preset ids (`v5k_to_15k`, …) match the spec's §5.3 table and the volume-column names (`estimated_monthly_volume_{1w,4w,13w,26w,52w}_ago`) match Tasks 1–2.

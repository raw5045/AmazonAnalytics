# Keepa Service Implementation Plan (arc 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An always-on Keepa enrichment service on its own Railway service that keeps the top-1M keywords' ASINs (about 1.0M) refreshed weekly in 100-ASIN batches at the plan's token cap, with durable per-batch progress, a one-row-per-ASIN catalog the app reads directly, and a shadow-week transfer off the old import-time job.

**Architecture:** `services/keepa/` is a small Node loop (claim → one Keepa request → parse/validate → one transaction) that talks only to Keepa and Neon through its own `pg.Pool`; it never imports the app's env schema, Inngest or Resend. Three additive tables (`asin_products`, `asin_snapshots`, `keepa_service_status`, migration 0050) hold facts, per-fetch history and the heartbeat. The main worker gains an enqueue-week hook in the import and a 15-minute watcher cron (alarms, explorer-sync triggers); the app's readers switch to the catalog behind `KEEPA_READ_SOURCE`; the old enrichment path retires last.

**Tech Stack:** TypeScript on Node (tsx), `pg` (raw SQL), Next.js 16 App Router (admin card), Inngest cron (watcher), Resend (alarm emails), vitest. Spec: `docs/superpowers/specs/2026-10-05-keepa-service-design.md` (24e5ab0).

---

## Conventions (every task)

- Commit locally on `main`, one commit per task, trailer exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push: pushes are the owner's call (Task 14), always preceded by `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts`, and always a bare `git push origin main` as its own command.
- `git add` named files only, never `-A` or `.`: the tree holds many untracked throwaway scripts, and `scripts/applyMigration0050.ts` (Task 3) must stay untracked.
- DDL only through the untracked apply script gated by `APPLY_0050=yes`, run by the owner on their explicit go. Never `pnpm db:generate` / `db:migrate` (the drizzle journal is frozen).
- `.env.local`'s `DATABASE_URL` reaches PRODUCTION. Read-only queries are fine; integration tests only on the owner's go; never print member email addresses.
- Logs carry coded fields only: an error's `name`, a Postgres `code`, an HTTP `status`. Never log a database error's `.message` and never the Keepa key.
- Before touching `app/admin/keepa-enrichment/page.tsx` read `node_modules/next/dist/docs/` (genuine vendored Next.js 16 docs; `AGENTS.md` is owner-authored).
- Edits with the Edit tool only, exact-match and EOL-preserving (the tree mixes CRLF/LF). Lint touched files only: `pnpm exec eslint <files>`; whole-project `pnpm lint` fails on untracked scripts. `pnpm typecheck` = `tsc --noEmit`. `pnpm test` = vitest.
- The service's imports stay inside `services/keepa/**` and `lib/keepa/**` (Railway watch paths). `lib/keepa/*` may import only `pg` types and each other.
- Memory of the problem domain: Keepa "Price Type" indices are shared by the `csv` arrays and every `stats` array: 0 Amazon price, 1 new price, 3 sales rank, 11 new offer count, 16 rating (0–50), 17 review count, 34 new FBA offers, 35 new FBM offers. Keepa time = minutes since 2011-01-01 UTC. −1 means "not available".

## File map

| File | Responsibility |
|---|---|
| `lib/keepa/lanes.ts` (+test) | Pure scheduling constants and rules: tiers, next-due, error backoff, token wait |
| `lib/keepa/enqueueWeek.ts` (+test) | The enqueue-week upsert + retire statements and runner (import hook, seed, script) |
| `db/migrations/0050_keepa_service.sql`, `db/schema/asinProducts.ts`, `asinSnapshots.ts`, `keepaServiceStatus.ts` | DDL and drizzle definitions of the three new tables |
| `scripts/applyMigration0050.ts` (UNTRACKED) | Owner-gated apply + seed + assertions |
| `lib/keepa/productFacts.ts` | `ProductFacts` type and `emptyFacts` |
| `lib/keepa/parseProduct.ts` (+test), `lib/keepa/__fixtures__/batch-stats.json` | Parser from one Keepa product object (+stats) to `ProductFacts`; batch mapping with delisted detection |
| `lib/keepa/batchClient.ts` (+test) | Multi-ASIN request, token status, typed Keepa errors |
| `services/keepa/store.ts`, `pgStore.ts`, `db.ts`, `log.ts` (+test) | Store interface, its Postgres implementation (claims, batch transaction, status row), pool, log-safe fields |
| `services/keepa/loop.ts` (+test) | One iteration and the forever loop, fully injectable |
| `services/keepa/index.ts`, `README.md` | Boot, health endpoint, env; Railway dashboard settings |
| `tests/integration/keepaService.test.ts` | Claim/write/release against the real tables with synthetic ASINs (owner's go) |
| `lib/keepa/adminOverview.ts`, `app/admin/keepa-enrichment/ServiceStatusCard.tsx` (+test), `page.tsx` (+test) | Status card |
| `inngest/functions/importFile.ts`, `scripts/fireEnqueueWeek.ts` | Enqueue hook in the import; manual re-run |
| `lib/keepa/watcherRules.ts` (+test), `lib/notifications/buildKeepaServiceAlarmEmail.ts` (+test), `sendKeepaServiceAlarmEmail.ts` (+test), `inngest/functions/keepaServiceWatcher.ts`, `inngest/functions/index.ts` | Watcher decisions, alarm emails, cron |
| `lib/keepa/readSource.ts` (+test), `lib/explorer/fetchKeywordDetail.ts`, `inngest/functions/refreshSummary.ts`, `worker/kcsKeepaSyncJobs.ts`, `lib/categoryBuilder/loadTree.ts` | Flagged reader switch |
| Retire: `worker/keepaJobs.ts`, `inngest/functions/enrichKeepaForWeek.ts`, `lib/keepa/client.ts`, `lib/keepa/parse.ts` (+test, 3 old fixtures), `lib/notifications/*EnrichmentEmail*`, `app/api/admin/keepa-enrichment/fire-full/route.ts`, `app/admin/keepa-enrichment/KeepaEnrichmentButton.tsx`, `scripts/keepaSmokeTest.ts`, `scripts/fireEnrichWeek.ts`, `scripts/fireKeepaEnrichment.ts` + edits in `worker/index.ts`, `importFile.ts`, `inngest/functions/index.ts`, the admin page | Phase 3 |

---

### Task 1: Scheduling rules — `lib/keepa/lanes.ts`

**Files:**
- Create: `lib/keepa/lanes.ts`
- Test: `lib/keepa/lanes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/keepa/lanes.test.ts
import { describe, it, expect } from 'vitest';
import {
  tierForRank,
  nextDueAfterSuccess,
  nextDueAfterDelisted,
  nextDueAfterError,
  msUntilTokens,
  TIER1_MAX_RANK,
  TOKENS_PER_ASIN,
  BATCH_SIZE,
} from './lanes';

const NOW = new Date('2026-10-06T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('tierForRank', () => {
  it('puts rank 1,000,000 in tier 1 and 1,000,001 in tier 2', () => {
    expect(tierForRank(1)).toBe(1);
    expect(tierForRank(TIER1_MAX_RANK)).toBe(1);
    expect(tierForRank(TIER1_MAX_RANK + 1)).toBe(2);
  });
});

describe('next-due rules (spec §5.2)', () => {
  it('tier 1 refreshes weekly, tier 2 monthly', () => {
    expect(nextDueAfterSuccess(1, NOW)).toEqual(days(7));
    expect(nextDueAfterSuccess(2, NOW)).toEqual(days(30));
  });
  it('a delisted ASIN is rechecked after 30 days', () => {
    expect(nextDueAfterDelisted(NOW)).toEqual(days(30));
  });
  it('errors back off 1, 2, 4 days and cap at 7', () => {
    expect(nextDueAfterError(1, NOW)).toEqual(days(1));
    expect(nextDueAfterError(2, NOW)).toEqual(days(2));
    expect(nextDueAfterError(3, NOW)).toEqual(days(4));
    expect(nextDueAfterError(4, NOW)).toEqual(days(7));
    expect(nextDueAfterError(9, NOW)).toEqual(days(7));
    expect(nextDueAfterError(0, NOW)).toEqual(days(1));
  });
});

describe('msUntilTokens', () => {
  it('is zero with headroom or an unknown balance', () => {
    expect(msUntilTokens(15_000, 250, 200)).toBe(0);
    expect(msUntilTokens(200, 250, 200)).toBe(0);
    expect(msUntilTokens(null, 250, 200)).toBe(0);
  });
  it('waits for the shortfall at the refill rate (250/min: 100 tokens short = 24 s)', () => {
    expect(msUntilTokens(100, 250, 200)).toBe(24_000);
    expect(msUntilTokens(0, 250, 200)).toBe(48_000);
  });
  it('assumes 250/min when the rate is unknown', () => {
    expect(msUntilTokens(0, null, 200)).toBe(48_000);
  });
  it('a full batch costs 200 tokens', () => {
    expect(BATCH_SIZE * TOKENS_PER_ASIN).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run lib/keepa/lanes.test.ts`
Expected: FAIL — `Cannot find module './lanes'`.

- [ ] **Step 3: Implement**

```ts
// lib/keepa/lanes.ts
/**
 * Pure scheduling rules for the Keepa service (spec 2026-10-05 §5.1–§5.2).
 *
 * Tier 1 = ASINs behind the top TIER1_MAX_RANK keywords, refreshed weekly.
 * Tier 2 = the rest, refreshed monthly, only when the tail lane is on.
 * No I/O here; the service (services/keepa) and the enqueue hook import these.
 */
export const TIER1_MAX_RANK = 1_000_000;
export const TIER1_REFRESH_DAYS = 7;
export const TIER2_REFRESH_DAYS = 30;
export const DELISTED_RETRY_DAYS = 30;
export const ERROR_BACKOFF_BASE_DAYS = 1;
export const ERROR_BACKOFF_CAP_DAYS = 7;
/** A claim older than this belongs to a dead process and is released. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** Keepa's per-request maximum. */
export const BATCH_SIZE = 100;
/** 1 base token + 1 for the rating/review history (`rating=1`). */
export const TOKENS_PER_ASIN = 2;
/** Assumed when Keepa has not told us the rate yet (the plan verified on 2026-10-05). */
export const DEFAULT_REFILL_RATE_PER_MIN = 250;

export type Tier = 1 | 2;
export type Lane = 'new' | 'due' | 'tail';

const DAY_MS = 86_400_000;

export function tierForRank(bestRank: number): Tier {
  return bestRank <= TIER1_MAX_RANK ? 1 : 2;
}

export function nextDueAfterSuccess(tier: Tier, now: Date): Date {
  const days = tier === 1 ? TIER1_REFRESH_DAYS : TIER2_REFRESH_DAYS;
  return new Date(now.getTime() + days * DAY_MS);
}

export function nextDueAfterDelisted(now: Date): Date {
  return new Date(now.getTime() + DELISTED_RETRY_DAYS * DAY_MS);
}

/** `consecutiveErrors` is the count AFTER this failure (1 on the first failure). */
export function nextDueAfterError(consecutiveErrors: number, now: Date): Date {
  const n = Math.max(1, consecutiveErrors);
  const days = Math.min(ERROR_BACKOFF_CAP_DAYS, ERROR_BACKOFF_BASE_DAYS * 2 ** (n - 1));
  return new Date(now.getTime() + days * DAY_MS);
}

/**
 * Milliseconds until `needed` tokens are available. Zero with headroom, or when the
 * balance is unknown (the first request after boot reveals it).
 */
export function msUntilTokens(tokensLeft: number | null, refillRatePerMin: number | null, needed: number): number {
  if (tokensLeft === null || tokensLeft >= needed) return 0;
  const rate = refillRatePerMin && refillRatePerMin > 0 ? refillRatePerMin : DEFAULT_REFILL_RATE_PER_MIN;
  return Math.ceil(((needed - tokensLeft) / rate) * 60_000);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run lib/keepa/lanes.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec eslint lib/keepa/lanes.ts lib/keepa/lanes.test.ts
git add lib/keepa/lanes.ts lib/keepa/lanes.test.ts
git commit -m "feat(keepa): scheduling rules for the Keepa service — tiers, next-due, error backoff, token wait

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Enqueue-week statements — `lib/keepa/enqueueWeek.ts`

**Files:**
- Create: `lib/keepa/enqueueWeek.ts`
- Test: `lib/keepa/enqueueWeek.test.ts`
- Read first: `lib/keepa/categoryExclusions.ts` (the exclusion list and its `NOT IN` placeholder pattern), `worker/keepaJobs.ts` lines 430–470 (the existing top-3 lateral-join scope query this mirrors).

- [ ] **Step 1: Write the failing test**

```ts
// lib/keepa/enqueueWeek.test.ts
import { describe, it, expect } from 'vitest';
import { enqueueWeekStatements, enqueueWeek, kwmPartitionFor } from './enqueueWeek';
import { EXCLUDED_CATEGORIES_ARRAY } from './categoryExclusions';

describe('kwmPartitionFor', () => {
  it('maps the week to its year partition', () => {
    expect(kwmPartitionFor('2026-10-03')).toBe('keyword_weekly_metrics_2026');
  });
  it('rejects anything that is not an ISO date (the name is interpolated into SQL)', () => {
    expect(() => kwmPartitionFor("2026-10-03'; DROP TABLE x")).toThrow();
    expect(() => kwmPartitionFor('')).toThrow();
  });
});

describe('enqueueWeekStatements', () => {
  const s = enqueueWeekStatements('2026-10-03');

  it("upserts the week's top-3 ASINs with rank, scope week and tier, skipping excluded categories", () => {
    expect(s.upsert.text).toContain('FROM keyword_weekly_metrics_2026 kwm');
    expect(s.upsert.text).toContain('top_clicked_product_3_asin');
    expect(s.upsert.text).toContain('ON CONFLICT (asin) DO UPDATE');
    expect(s.upsert.values.slice(0, 3)).toEqual(['2026-10-03', 1_000_000, 7]);
    expect(s.upsert.values.slice(3)).toEqual(EXCLUDED_CATEGORIES_ARRAY);
    expect(s.upsert.text).toContain(`$${3 + EXCLUDED_CATEGORIES_ARRAY.length}`);
  });

  it('pulls a tier-2 → tier-1 move forward to a weekly due date without resetting anything else', () => {
    expect(s.upsert.text).toContain(
      'LEAST(asin_products.next_due_at, asin_products.last_fetched_at + make_interval(days => $3::int))',
    );
    expect(s.upsert.text).toContain('ELSE asin_products.next_due_at END');
  });

  it('retires vanished ASINs by flag, never by DELETE', () => {
    expect(s.retire.text).toContain('SET in_scope = false');
    expect(s.retire.text).not.toMatch(/DELETE/i);
    expect(s.retire.values).toEqual(['2026-10-03']);
  });
});

describe('enqueueWeek', () => {
  it('runs the upsert then the retire and reports both counts', async () => {
    const calls: string[] = [];
    const client = {
      query: async (text: string) => {
        calls.push(text);
        return { rowCount: text.includes('INSERT INTO asin_products') ? 5 : 2 };
      },
    };
    await expect(enqueueWeek(client, '2026-10-03')).resolves.toEqual({ upserted: 5, retired: 2 });
    expect(calls[0]).toContain('INSERT INTO asin_products');
    expect(calls[1]).toContain('SET in_scope = false');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run lib/keepa/enqueueWeek.test.ts`
Expected: FAIL — `Cannot find module './enqueueWeek'`.

- [ ] **Step 3: Implement**

```ts
// lib/keepa/enqueueWeek.ts
/**
 * Enqueue a week's top-3 ASINs for the Keepa service (spec 2026-10-05 §6.1).
 *
 * One upsert over the week's kwm partition: every top-3 ASIN of the week (same category
 * exclusions as the old enrichment) gets its best keyword rank, the scope week, its tier
 * (1 = rank ≤ TIER1_MAX_RANK, weekly; 2 = the rest) and in_scope = true. Brand-new ASINs start
 * never-fetched and due now. An ASIN moving from tier 2 to tier 1 that was fetched before is
 * pulled forward to a weekly due date. Then every row not seen this week is flagged out of
 * scope — kept, never deleted.
 *
 * Callers: the import's completion step (inngest/functions/importFile.ts), the 0050 seed
 * script, and scripts/fireEnqueueWeek.ts.
 */
import { EXCLUDED_CATEGORIES_ARRAY } from './categoryExclusions';
import { TIER1_MAX_RANK, TIER1_REFRESH_DAYS } from './lanes';

export interface SqlStatement {
  text: string;
  values: unknown[];
}
export interface EnqueueWeekStatements {
  upsert: SqlStatement;
  retire: SqlStatement;
}
/** The slice of pg's Pool/PoolClient the runner needs — keeps the unit test free of a database. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

export function kwmPartitionFor(weekEndDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEndDate)) throw new Error('weekEndDate must be YYYY-MM-DD');
  return `keyword_weekly_metrics_${weekEndDate.slice(0, 4)}`;
}

export function enqueueWeekStatements(weekEndDate: string): EnqueueWeekStatements {
  const partition = kwmPartitionFor(weekEndDate);
  const excl = EXCLUDED_CATEGORIES_ARRAY;
  const placeholders = excl.map((_, i) => `$${i + 4}`).join(',');
  return {
    upsert: {
      text: `
    WITH week_asins AS (
      SELECT t.asin, MIN(kwm.actual_rank)::int AS best_rank
      FROM ${partition} kwm
      CROSS JOIN LATERAL (VALUES
        (kwm.top_clicked_product_1_asin),
        (kwm.top_clicked_product_2_asin),
        (kwm.top_clicked_product_3_asin)
      ) AS t(asin)
      WHERE kwm.week_end_date = $1::date
        AND t.asin IS NOT NULL
        AND (kwm.top_clicked_category_1 IS NULL OR kwm.top_clicked_category_1 NOT IN (${placeholders}))
      GROUP BY t.asin
    )
    INSERT INTO asin_products (asin, best_rank, scope_week, tier, in_scope, next_due_at)
    SELECT asin, best_rank, $1::date, CASE WHEN best_rank <= $2::int THEN 1 ELSE 2 END, true, now()
    FROM week_asins
    ON CONFLICT (asin) DO UPDATE SET
      best_rank = EXCLUDED.best_rank,
      scope_week = EXCLUDED.scope_week,
      in_scope = true,
      next_due_at = CASE
        WHEN EXCLUDED.tier = 1 AND asin_products.tier = 2 AND asin_products.last_fetched_at IS NOT NULL
          THEN LEAST(asin_products.next_due_at, asin_products.last_fetched_at + make_interval(days => $3::int))
        ELSE asin_products.next_due_at END,
      tier = EXCLUDED.tier,
      updated_at = now()`,
      values: [weekEndDate, TIER1_MAX_RANK, TIER1_REFRESH_DAYS, ...excl],
    },
    retire: {
      text: `UPDATE asin_products SET in_scope = false, updated_at = now()
    WHERE in_scope AND (scope_week IS NULL OR scope_week <> $1::date)`,
      values: [weekEndDate],
    },
  };
}

export async function enqueueWeek(
  client: Queryable,
  weekEndDate: string,
): Promise<{ upserted: number; retired: number }> {
  const s = enqueueWeekStatements(weekEndDate);
  const up = await client.query(s.upsert.text, s.upsert.values);
  const ret = await client.query(s.retire.text, s.retire.values);
  return { upserted: up.rowCount ?? 0, retired: ret.rowCount ?? 0 };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run lib/keepa/enqueueWeek.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec eslint lib/keepa/enqueueWeek.ts lib/keepa/enqueueWeek.test.ts
git add lib/keepa/enqueueWeek.ts lib/keepa/enqueueWeek.test.ts
git commit -m "feat(keepa): enqueue-week statements — top-3 ASIN upsert with rank/tier/scope, tier-2→1 pull-forward, flag-only retire

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Migration 0050, drizzle schema, owner-gated apply + seed script

**Files:**
- Create: `db/migrations/0050_keepa_service.sql`
- Create: `db/schema/asinProducts.ts`, `db/schema/asinSnapshots.ts`, `db/schema/keepaServiceStatus.ts`
- Modify: `db/schema/index.ts` (append three `export *` lines after `export * from './askAi';`)
- Create (UNTRACKED, never `git add`): `scripts/applyMigration0050.ts`
- Read first: `db/migrations/0049_ask_writes.sql` (header style, `--> statement-breakpoint`), `db/schema/asinWeeklyData.ts` (the `asinEnrichmentStatusEnum` this reuses).

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0050 (hand-numbered, applied by the untracked scripts/applyMigration0050.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-05 §4.
-- Three ADDITIVE tables for the always-on Keepa service. asin_weekly_data is untouched.
-- Safe to apply before any code that reads these tables is deployed.
CREATE TABLE IF NOT EXISTS asin_products (
  asin text PRIMARY KEY,
  title text,
  brand text,
  image_url text,
  category_path text,
  category_root text,
  category_leaf text,
  listed_since date,
  tracking_since date,
  current_price_cents integer,
  price_source text CHECK (price_source IN ('amazon', 'new')),
  sales_rank integer,
  review_count integer,
  average_rating_x10 integer,
  last_rating_update date,
  monthly_sold integer,
  keepa_updated_at date,
  new_offer_count integer,
  fba_offer_count integer,
  fbm_offer_count integer,
  amazon_availability smallint,
  avg30_price_cents integer,
  avg90_price_cents integer,
  avg180_price_cents integer,
  avg365_price_cents integer,
  avg30_sales_rank integer,
  avg90_sales_rank integer,
  enrichment_status asin_enrichment_status,
  error_code text,
  last_fetched_at timestamptz,
  fetch_count integer NOT NULL DEFAULT 0,
  consecutive_errors integer NOT NULL DEFAULT 0,
  in_scope boolean NOT NULL DEFAULT true,
  best_rank integer,
  scope_week date,
  tier smallint NOT NULL DEFAULT 2 CHECK (tier IN (1, 2)),
  next_due_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
COMMENT ON TABLE asin_products IS
  'One row per ASIN: current Keepa facts + the Keepa service queue state. enrichment_status NULL = never fetched. Spec 2026-10-05 §4.1.';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asin_products_never_fetched_idx
  ON asin_products (tier, best_rank)
  WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asin_products_due_idx
  ON asin_products (tier, next_due_at)
  WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asin_products_claimed_idx
  ON asin_products (claimed_at)
  WHERE claimed_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asin_products_category_path_idx
  ON asin_products (category_path)
  WHERE category_path IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS asin_snapshots (
  asin text NOT NULL,
  fetched_at timestamptz NOT NULL,
  current_price_cents integer,
  sales_rank integer,
  review_count integer,
  average_rating_x10 integer,
  monthly_sold integer,
  new_offer_count integer,
  fba_offer_count integer,
  fbm_offer_count integer,
  enrichment_status asin_enrichment_status NOT NULL,
  PRIMARY KEY (asin, fetched_at)
);
--> statement-breakpoint
COMMENT ON TABLE asin_snapshots IS
  'One narrow row per Keepa fetch (point-in-time price, rank, reviews, monthly sold, offer counts). Spec 2026-10-05 §4.2.';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS keepa_service_status (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  boot_id text,
  booted_at timestamptz,
  heartbeat_at timestamptz,
  last_batch_at timestamptz,
  last_batch_lane text,
  tokens_left integer,
  refill_rate integer,
  tail_enabled boolean NOT NULL DEFAULT false,
  last_error_code text,
  last_error_at timestamptz,
  lane_new_drained_at timestamptz,
  sync_fired_at timestamptz,
  nightly_sync_date date,
  down_alarm_sent_at timestamptz,
  stall_alarm_sent_at timestamptz
);
--> statement-breakpoint
COMMENT ON TABLE keepa_service_status IS
  'Single row: Keepa service heartbeat + the main-worker watcher bookkeeping. Spec 2026-10-05 §4.3.';
```

- [ ] **Step 2: Write the drizzle schema files**

```ts
// db/schema/asinProducts.ts
import { pgTable, text, date, integer, smallint, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { asinEnrichmentStatusEnum } from './asinWeeklyData';

/**
 * One row per ASIN: current Keepa facts + the Keepa service's queue state.
 * Written by services/keepa (raw SQL); read by the admin card, the watcher and —
 * behind KEEPA_READ_SOURCE=products — the app's readers. Canonical DDL and
 * partial-index predicates: db/migrations/0050_keepa_service.sql (spec 2026-10-05 §4.1).
 */
export const asinProducts = pgTable(
  'asin_products',
  {
    asin: text('asin').primaryKey(),
    title: text('title'),
    brand: text('brand'),
    imageUrl: text('image_url'),
    categoryPath: text('category_path'),
    categoryRoot: text('category_root'),
    categoryLeaf: text('category_leaf'),
    listedSince: date('listed_since'),
    trackingSince: date('tracking_since'),
    currentPriceCents: integer('current_price_cents'),
    /** 'amazon' | 'new' — which Keepa series the current price and its averages come from. */
    priceSource: text('price_source'),
    salesRank: integer('sales_rank'),
    reviewCount: integer('review_count'),
    averageRatingX10: integer('average_rating_x10'),
    lastRatingUpdate: date('last_rating_update'),
    /** Amazon's "bought in past month" floor (100000 = 100K+); null without the badge. */
    monthlySold: integer('monthly_sold'),
    /** Keepa's lastUpdate: the "as of" date for monthly sold and the offer counts. */
    keepaUpdatedAt: date('keepa_updated_at'),
    newOfferCount: integer('new_offer_count'),
    fbaOfferCount: integer('fba_offer_count'),
    fbmOfferCount: integer('fbm_offer_count'),
    /** Keepa code: -1 no Amazon offer, 0 in stock, 1 pre-order, 2 unknown, 3 back-order, 4 delayed. */
    amazonAvailability: smallint('amazon_availability'),
    avg30PriceCents: integer('avg30_price_cents'),
    avg90PriceCents: integer('avg90_price_cents'),
    avg180PriceCents: integer('avg180_price_cents'),
    avg365PriceCents: integer('avg365_price_cents'),
    avg30SalesRank: integer('avg30_sales_rank'),
    avg90SalesRank: integer('avg90_sales_rank'),
    /** null = never fetched. */
    enrichmentStatus: asinEnrichmentStatusEnum('enrichment_status'),
    errorCode: text('error_code'),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    fetchCount: integer('fetch_count').notNull().default(0),
    consecutiveErrors: integer('consecutive_errors').notNull().default(0),
    inScope: boolean('in_scope').notNull().default(true),
    bestRank: integer('best_rank'),
    scopeWeek: date('scope_week'),
    tier: smallint('tier').notNull().default(2),
    nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The four indexes are PARTIAL in the migration (drizzle's index().where() emits
    // inconsistently); declared plain here for type-checking only.
    neverFetchedIdx: index('asin_products_never_fetched_idx').on(t.tier, t.bestRank),
    dueIdx: index('asin_products_due_idx').on(t.tier, t.nextDueAt),
    claimedIdx: index('asin_products_claimed_idx').on(t.claimedAt),
    categoryPathIdx: index('asin_products_category_path_idx').on(t.categoryPath),
  }),
);

export type AsinProductRow = typeof asinProducts.$inferSelect;
```

```ts
// db/schema/asinSnapshots.ts
import { pgTable, text, integer, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { asinEnrichmentStatusEnum } from './asinWeeklyData';

/** One narrow row per Keepa fetch (spec 2026-10-05 §4.2). Written by services/keepa. */
export const asinSnapshots = pgTable(
  'asin_snapshots',
  {
    asin: text('asin').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    currentPriceCents: integer('current_price_cents'),
    salesRank: integer('sales_rank'),
    reviewCount: integer('review_count'),
    averageRatingX10: integer('average_rating_x10'),
    monthlySold: integer('monthly_sold'),
    newOfferCount: integer('new_offer_count'),
    fbaOfferCount: integer('fba_offer_count'),
    fbmOfferCount: integer('fbm_offer_count'),
    enrichmentStatus: asinEnrichmentStatusEnum('enrichment_status').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.asin, t.fetchedAt] }) }),
);

export type AsinSnapshotRow = typeof asinSnapshots.$inferSelect;
```

```ts
// db/schema/keepaServiceStatus.ts
import { pgTable, boolean, text, integer, date, timestamp } from 'drizzle-orm/pg-core';

/** Single row: Keepa service heartbeat + the watcher's bookkeeping (spec 2026-10-05 §4.3). */
export const keepaServiceStatus = pgTable('keepa_service_status', {
  singleton: boolean('singleton').primaryKey().default(true),
  bootId: text('boot_id'),
  bootedAt: timestamp('booted_at', { withTimezone: true }),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  lastBatchAt: timestamp('last_batch_at', { withTimezone: true }),
  lastBatchLane: text('last_batch_lane'),
  tokensLeft: integer('tokens_left'),
  refillRate: integer('refill_rate'),
  tailEnabled: boolean('tail_enabled').notNull().default(false),
  lastErrorCode: text('last_error_code'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  laneNewDrainedAt: timestamp('lane_new_drained_at', { withTimezone: true }),
  syncFiredAt: timestamp('sync_fired_at', { withTimezone: true }),
  nightlySyncDate: date('nightly_sync_date'),
  downAlarmSentAt: timestamp('down_alarm_sent_at', { withTimezone: true }),
  stallAlarmSentAt: timestamp('stall_alarm_sent_at', { withTimezone: true }),
});

export type KeepaServiceStatusRow = typeof keepaServiceStatus.$inferSelect;
```

Append to `db/schema/index.ts` after the `export * from './askAi';` line:

```ts
export * from './asinProducts';
export * from './asinSnapshots';
export * from './keepaServiceStatus';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Write the UNTRACKED apply + seed script**

```ts
// scripts/applyMigration0050.ts (UNTRACKED — run only after the owner confirms in chat)
/**
 * Apply migration 0050 (Keepa service: asin_products, asin_snapshots, keepa_service_status)
 * to DATABASE_URL, then seed the catalog from asin_weekly_data (spec 2026-10-05 §4.4):
 *   1. facts for every ASIN we already hold (its latest genuine fetch), tier 2 / out of scope
 *      until step 2 fixes both; last_fetched_at = enriched_at so the weekly cadence starts
 *      from true ages; legacy 'error' rows are skipped (they start never-fetched);
 *   2. scope for the current kcs week (the enqueue-week upsert: rank, tier, in_scope);
 *   3. snapshots from asin_weekly_data's distinct (asin, enriched_at) fetches;
 *   4. the status row.
 * Gated by APPLY_0050=yes. Idempotent: CREATE IF NOT EXISTS + ON CONFLICT DO NOTHING.
 *
 * Run: APPLY_0050=yes node --env-file=.env.local --import tsx scripts/applyMigration0050.ts
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { enqueueWeek } from '@/lib/keepa/enqueueWeek';

async function main() {
  if (process.env.APPLY_0050 !== 'yes') {
    console.error('Refusing to run: set APPLY_0050=yes to proceed.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set (run with --env-file=.env.local)');
    process.exit(1);
  }
  const raw = readFileSync('db/migrations/0050_keepa_service.sql', 'utf8');
  const statements = raw
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.replace(/^--.*$/gm, '').trim().length > 0);

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 1_800_000, lock_timeout: 10_000, max: 1 });
  const c = await pool.connect();
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  try {
    log(`Applying 0050_keepa_service.sql (${statements.length} statements)...`);
    await c.query('BEGIN');
    try {
      for (const st of statements) {
        await c.query(st);
        log(`ok: ${st.replace(/^--.*$/gm, '').trim().slice(0, 72).replace(/\s+/g, ' ')}…`);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }

    const { rows: tables } = await c.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
         AND table_name IN ('asin_products', 'asin_snapshots', 'keepa_service_status')`,
    );
    if (tables.length !== 3) {
      console.error(`assertion FAILED — expected 3 tables, found ${tables.length}`);
      process.exit(1);
    }

    log('seed 1/4: facts from asin_weekly_data (latest genuine fetch per ASIN, legacy error rows skipped)');
    const facts = await c.query(`
      INSERT INTO asin_products (
        asin, title, brand, image_url, category_path, category_root, category_leaf,
        current_price_cents, price_source, sales_rank, review_count, average_rating_x10, last_rating_update,
        avg30_price_cents, avg90_price_cents, avg180_price_cents, avg365_price_cents,
        enrichment_status, last_fetched_at, fetch_count, in_scope, tier, next_due_at)
      SELECT DISTINCT ON (a.asin)
        a.asin, a.title, a.brand, a.image_url, a.category_path, a.category_root, a.category_leaf,
        a.current_price_cents, CASE WHEN a.current_price_cents IS NOT NULL THEN 'amazon' END,
        a.sales_rank, a.review_count, a.average_rating_x10, a.last_rating_update,
        a.avg30_price_cents, a.avg90_price_cents, a.avg180_price_cents, a.avg365_price_cents,
        a.enrichment_status, a.enriched_at, 1, false, 2, a.enriched_at + interval '7 days'
      FROM asin_weekly_data a
      WHERE a.enrichment_status <> 'error'
      ORDER BY a.asin, a.enriched_at DESC, a.week_end_date DESC
      ON CONFLICT (asin) DO NOTHING`);
    log(`seed 1/4 done: ${facts.rowCount} ASINs seeded`);

    const { rows: meta } = await c.query<{ week: string }>(
      `SELECT current_week_end_date::text AS week FROM keyword_current_summary_meta WHERE singleton = true`,
    );
    const week = meta[0]?.week;
    if (!week) throw new Error('no kcs meta week');
    log(`seed 2/4: scope for week ${week} (enqueue-week upsert)`);
    const scope = await enqueueWeek(c, week);
    log(`seed 2/4 done: inserted=${scope.inserted} updated=${scope.updated} retired=${scope.retired} vacuumed=${scope.vacuumed}`);

    log('seed 3/4: snapshots from distinct genuine fetches');
    const snaps = await c.query(`
      INSERT INTO asin_snapshots (asin, fetched_at, current_price_cents, sales_rank, review_count, average_rating_x10, enrichment_status)
      SELECT DISTINCT ON (a.asin, a.enriched_at)
        a.asin, a.enriched_at, a.current_price_cents, a.sales_rank, a.review_count, a.average_rating_x10, a.enrichment_status
      FROM asin_weekly_data a
      WHERE a.enrichment_status IN ('active', 'no_price')
      ORDER BY a.asin, a.enriched_at, a.week_end_date DESC
      ON CONFLICT DO NOTHING`);
    log(`seed 3/4 done: ${snaps.rowCount} snapshot rows`);

    log('seed 4/4: status row');
    await c.query(`INSERT INTO keepa_service_status (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`);

    const { rows: counts } = await c.query<Record<string, string>>(`
      SELECT
        (SELECT count(*) FROM asin_products)::text AS rows_total,
        (SELECT count(*) FROM asin_products WHERE in_scope AND tier = 1)::text AS tier1_in_scope,
        (SELECT count(*) FROM asin_products WHERE in_scope AND tier = 1 AND last_fetched_at IS NULL)::text AS tier1_never_fetched,
        (SELECT count(*) FROM asin_products WHERE in_scope AND tier = 2)::text AS tier2_in_scope,
        (SELECT count(*) FROM asin_products WHERE NOT in_scope)::text AS out_of_scope,
        (SELECT min(next_due_at)::text FROM asin_products WHERE in_scope AND tier = 1 AND last_fetched_at IS NOT NULL) AS earliest_tier1_due,
        (SELECT count(*) FROM asin_snapshots)::text AS snapshots`);
    console.table(counts);
    log('0050 applied + seeded. Expected (2026-10-05 diag): tier1_in_scope ≈ 1,003,344; tier1_never_fetched ≈ 715,083; rows_total ≈ 2.31M + out-of-scope legacy ASINs.');
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => {
  console.error('apply failed:', e instanceof Error ? e.name : 'unknown', (e as { code?: string })?.code ?? '');
  process.exit(1);
});
```

- [ ] **Step 5: Do NOT run the script, do NOT `git add` it.** It runs in Task 14 step 1 on the owner's go. Confirm it is untracked: `git status --short scripts/applyMigration0050.ts` shows `??`.

- [ ] **Step 6: Lint and commit the tracked files**

```bash
pnpm exec eslint db/schema/asinProducts.ts db/schema/asinSnapshots.ts db/schema/keepaServiceStatus.ts db/schema/index.ts
git add db/migrations/0050_keepa_service.sql db/schema/asinProducts.ts db/schema/asinSnapshots.ts db/schema/keepaServiceStatus.ts db/schema/index.ts
git commit -m "feat(db): migration 0050 — asin_products catalog, asin_snapshots, keepa_service_status (additive; applied by the owner-gated untracked script)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `ProductFacts`, the parser, and the captured fixture

**Files:**
- Create: `lib/keepa/productFacts.ts`
- Create: `lib/keepa/parseProduct.ts`
- Create: `lib/keepa/__fixtures__/batch-stats.json` (captured in Step 1)
- Create (UNTRACKED throwaway): `scripts/_captureKeepaBatchFixture.ts`
- Test: `lib/keepa/parseProduct.test.ts`
- Read first: `lib/keepa/parse.ts` (the old single-product parser whose `keepaMinutesToDate` and `primaryImageUrl` this copies; it stays until Task 13), spec §5.1 step 5 and §5.2.

- [ ] **Step 1: Capture the fixture with the service's exact request shape** (costs 4 Keepa tokens; the plan is idle, no gate needed)

```ts
// scripts/_captureKeepaBatchFixture.ts (UNTRACKED throwaway — delete after the capture)
/**
 * Captures lib/keepa/__fixtures__/batch-stats.json with the Keepa service's exact request
 * (rating=1, stats=90, history=0) for two known ASINs, and prints the field checks the
 * parser relies on. Costs 2 tokens per ASIN. The reply never contains the key.
 * Run: node --env-file=.env.local --import tsx scripts/_captureKeepaBatchFixture.ts
 */
import { writeFileSync } from 'node:fs';

const ASINS = ['B07BGLT25K', 'B0GX1XP72Z']; // Scott toilet paper (active), Needoh (no price in the 2026-05 spot check)

async function main() {
  const key = process.env.KEEPA_API_KEY;
  if (!key) { console.error('KEEPA_API_KEY missing'); process.exit(1); }
  const qs = new URLSearchParams({ key, domain: '1', asin: ASINS.join(','), rating: '1', stats: '90', history: '0' });
  const res = await fetch(`https://api.keepa.com/product?${qs.toString()}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) { console.error('http', res.status); process.exit(1); }
  const data = (await res.json()) as Record<string, unknown>;
  writeFileSync('lib/keepa/__fixtures__/batch-stats.json', JSON.stringify(data, null, 2) + '\n');
  const products = (data.products as Array<Record<string, unknown>>) ?? [];
  console.log('envelope:', { tokensLeft: data.tokensLeft, tokensConsumed: data.tokensConsumed, refillRate: data.refillRate, products: products.length });
  for (const p of products) {
    const stats = p.stats as Record<string, unknown[]> | undefined;
    const cur = stats?.current ?? [];
    console.log(p.asin, {
      statsPresent: !!stats, currentLen: cur.length, amazon: cur[0], newPrice: cur[1], rank: cur[3], countNew: cur[11],
      rating: cur[16], reviews: cur[17], fba: cur[34], fbm: cur[35], avg90rank: stats?.avg90?.[3],
      monthlySold: p.monthlySold, listedSince: p.listedSince, trackingSince: p.trackingSince, lastUpdate: p.lastUpdate,
      availability: p.availabilityAmazon, csvPresent: Array.isArray(p.csv), keys: Object.keys(p).length,
    });
  }
}
main().catch((e) => { console.error('capture failed:', e instanceof Error ? e.name : 'unknown'); process.exit(1); });
```

Run: `node --env-file=.env.local --import tsx scripts/_captureKeepaBatchFixture.ts`
Expected: `envelope: { ..., products: 2 }` and, for B07BGLT25K, `statsPresent: true`, `currentLen` ≥ 36, `csvPresent: false`, numeric `rank`, `reviews`, `fba`, `fbm`.

**Decision step (spec §5.1 step 5):** if `fba`/`fbm` print as `undefined` (stats.current shorter than 36), re-run the capture with `history: '0'` replaced by `days: '7'` in the script, and in Task 5 set `HISTORY_PARAMS` to `{ days: '7' }`. The parser below already falls back to the last csv value, so nothing else changes. Record which it was in the Task 5 commit message.

Then delete the throwaway script: `rm scripts/_captureKeepaBatchFixture.ts`. Confirm the fixture holds no key: `grep -c "key" lib/keepa/__fixtures__/batch-stats.json` prints 0 (the word only appears in URL parameters, never in a reply).

- [ ] **Step 2: Write the failing tests**

```ts
// lib/keepa/parseProduct.test.ts
/**
 * Parser tests against lib/keepa/__fixtures__/batch-stats.json — captured on 2026-10 with the
 * service's exact request (rating=1, stats=90, history=0). Live values drift, so the fixture
 * assertions are structural (status, non-null, ranges); stable facts (category path,
 * listed-since) are asserted exactly.
 */
import { describe, it, expect } from 'vitest';
import { parseProductFacts, parseKeepaBatch, keepaMinutesToDate, primaryImageUrl, PRICE_TYPE } from './parseProduct';
import { emptyFacts } from './productFacts';
import fixture from './__fixtures__/batch-stats.json';

const products = (fixture as { products: unknown[] }).products;
const TOILET_PAPER = 'B07BGLT25K';
const rawFor = (asin: string) => products.find((p) => (p as { asin: string }).asin === asin);

describe('parseProductFacts on the captured batch', () => {
  it('reads the Scott toilet paper product from the product object and the stats arrays', () => {
    const f = parseProductFacts(rawFor(TOILET_PAPER), TOILET_PAPER);
    expect(f.status).toBe('active');
    expect(f.errorCode).toBeNull();
    expect(f.title).toContain('Scott');
    expect(f.categoryRoot).toBe('Health & Household');
    expect(f.categoryLeaf).toBe('Toilet Paper');
    expect(f.categoryPath).toBe('Health & Household › Household Supplies › Tissues, Toilet Paper & Sprays › Toilet Paper');
    expect(f.listedSince).toBe('2018-03-19');
    expect(f.trackingSince).toBe('2018-04-23');
    expect(f.currentPriceCents).toBeGreaterThan(0);
    expect(['amazon', 'new']).toContain(f.priceSource);
    expect(f.salesRank).toBeGreaterThan(0);
    expect(f.reviewCount).toBeGreaterThan(100_000);
    expect(f.averageRatingX10).toBeGreaterThanOrEqual(35);
    expect(f.averageRatingX10).toBeLessThanOrEqual(50);
    expect(f.avg30PriceCents).toBeGreaterThan(0);
    expect(f.avg90SalesRank).toBeGreaterThan(0);
    expect(f.newOfferCount).toBeGreaterThanOrEqual(0);
    expect(f.fbaOfferCount).toBeGreaterThanOrEqual(0);
    expect(f.fbmOfferCount).toBeGreaterThanOrEqual(0);
    expect(f.keepaUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.imageUrl).toMatch(/^https:\/\/m\.media-amazon\.com\/images\/I\//);
    expect([-1, 0, 1, 2, 3, 4, null]).toContain(f.amazonAvailability);
  });

  it('parses the second product to a real status without throwing', () => {
    const asin = (products[1] as { asin: string }).asin;
    const f = parseProductFacts(products[1], asin);
    expect(['active', 'no_price']).toContain(f.status);
    expect(f.title).not.toBeNull();
  });
});

describe('parseProductFacts validation (spec §5.1 step 5)', () => {
  const base = (over: Record<string, unknown>) => ({ asin: 'B000000001', ...over });

  it('a product without a price in either series is no_price, facts still kept', () => {
    const f = parseProductFacts(base({ title: 'T', stats: { current: [-1, -1, -1, 123] } }), 'B000000001');
    expect(f.status).toBe('no_price');
    expect(f.currentPriceCents).toBeNull();
    expect(f.priceSource).toBeNull();
    expect(f.avg30PriceCents).toBeNull();
    expect(f.salesRank).toBe(123);
    expect(f.title).toBe('T');
  });

  it('falls back to the third-party new price and takes the averages from that series', () => {
    const avg30: number[] = []; avg30[PRICE_TYPE.AMAZON] = 999; avg30[PRICE_TYPE.NEW] = 1850;
    const f = parseProductFacts(base({ stats: { current: [-1, 1899], avg30 } }), 'B000000001');
    expect(f.status).toBe('active');
    expect(f.priceSource).toBe('new');
    expect(f.currentPriceCents).toBe(1899);
    expect(f.avg30PriceCents).toBe(1850);
  });

  it('nulls impossible values: negative counts, ratings off the 0–50 scale, non-positive prices and ranks', () => {
    const current = [0, -5]; current[PRICE_TYPE.SALES] = 0; current[PRICE_TYPE.COUNT_REVIEWS] = -1;
    current[PRICE_TYPE.RATING] = 51; current[PRICE_TYPE.COUNT_NEW] = -2;
    const f = parseProductFacts(base({ stats: { current }, monthlySold: 0, availabilityAmazon: 9 }), 'B000000001');
    expect(f.status).toBe('no_price');
    expect(f.salesRank).toBeNull();
    expect(f.reviewCount).toBeNull();
    expect(f.averageRatingX10).toBeNull();
    expect(f.newOfferCount).toBeNull();
    expect(f.monthlySold).toBeNull();
    expect(f.amazonAvailability).toBeNull();
  });

  it('reads the last csv value when the reply carried history instead of stats', () => {
    const csv: unknown[] = []; csv[PRICE_TYPE.AMAZON] = [100, 1299, 200, 1399]; csv[PRICE_TYPE.COUNT_NEW_FBA] = [100, 3];
    const f = parseProductFacts(base({ csv }), 'B000000001');
    expect(f.currentPriceCents).toBe(1399);
    expect(f.fbaOfferCount).toBe(3);
  });

  it('a non-object or a mismatched asin is an error for that ASIN only', () => {
    expect(parseProductFacts(null, 'B000000001')).toEqual(emptyFacts('B000000001', 'error', 'bad_object'));
    expect(parseProductFacts(base({ asin: 'B000000002' }), 'B000000001').errorCode).toBe('asin_mismatch');
  });
});

describe('parseKeepaBatch', () => {
  it('returns one entry per requested ASIN and marks a missing product delisted', () => {
    const out = parseKeepaBatch([TOILET_PAPER, 'B0MISSING00'], products);
    expect(out.size).toBe(2);
    expect(out.get(TOILET_PAPER)?.status).toBe('active');
    expect(out.get('B0MISSING00')).toEqual(emptyFacts('B0MISSING00', 'delisted'));
  });
  it('tolerates a non-array products field', () => {
    expect(parseKeepaBatch(['B000000001'], undefined).get('B000000001')?.status).toBe('delisted');
  });
});

describe('helpers', () => {
  it('keepaMinutesToDate: epoch and non-positive values', () => {
    expect(keepaMinutesToDate(1440)).toBe('2011-01-02');
    expect(keepaMinutesToDate(0)).toBeNull();
    expect(keepaMinutesToDate(-1)).toBeNull();
    expect(keepaMinutesToDate('x')).toBeNull();
  });
  it('primaryImageUrl: medium image of the first entry', () => {
    expect(primaryImageUrl([{ m: 'abc.jpg' }])).toBe('https://m.media-amazon.com/images/I/abc.jpg');
    expect(primaryImageUrl([])).toBeNull();
    expect(primaryImageUrl(null)).toBeNull();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run lib/keepa/parseProduct.test.ts`
Expected: FAIL — `Cannot find module './parseProduct'`.

- [ ] **Step 4: Implement the type and the parser**

```ts
// lib/keepa/productFacts.ts
/**
 * What one Keepa fetch yields for one ASIN, in the catalog's vocabulary (spec 2026-10-05 §4.1).
 * Produced by lib/keepa/parseProduct.ts, written by services/keepa/pgStore.ts.
 */
export type FactsStatus = 'active' | 'no_price' | 'delisted' | 'error';
export type PriceSource = 'amazon' | 'new';

export interface ProductFacts {
  asin: string;
  /** 'error' here means a bad product object (never a transport failure — those never reach the parser). */
  status: FactsStatus;
  errorCode: string | null;
  title: string | null;
  brand: string | null;
  imageUrl: string | null;
  categoryPath: string | null;
  categoryRoot: string | null;
  categoryLeaf: string | null;
  /** ISO dates (YYYY-MM-DD). */
  listedSince: string | null;
  trackingSince: string | null;
  currentPriceCents: number | null;
  priceSource: PriceSource | null;
  salesRank: number | null;
  reviewCount: number | null;
  /** 0–50 scale. */
  averageRatingX10: number | null;
  lastRatingUpdate: string | null;
  /** Amazon's "bought in past month" floor; null without the badge. */
  monthlySold: number | null;
  /** Keepa's lastUpdate as an ISO date: the "as of" for monthly sold and offer counts. */
  keepaUpdatedAt: string | null;
  newOfferCount: number | null;
  fbaOfferCount: number | null;
  fbmOfferCount: number | null;
  /** Keepa code -1..4, see db/schema/asinProducts.ts. */
  amazonAvailability: number | null;
  avg30PriceCents: number | null;
  avg90PriceCents: number | null;
  avg180PriceCents: number | null;
  avg365PriceCents: number | null;
  avg30SalesRank: number | null;
  avg90SalesRank: number | null;
}

export function emptyFacts(asin: string, status: 'delisted' | 'error', errorCode: string | null = null): ProductFacts {
  return {
    asin,
    status,
    errorCode,
    title: null,
    brand: null,
    imageUrl: null,
    categoryPath: null,
    categoryRoot: null,
    categoryLeaf: null,
    listedSince: null,
    trackingSince: null,
    currentPriceCents: null,
    priceSource: null,
    salesRank: null,
    reviewCount: null,
    averageRatingX10: null,
    lastRatingUpdate: null,
    monthlySold: null,
    keepaUpdatedAt: null,
    newOfferCount: null,
    fbaOfferCount: null,
    fbmOfferCount: null,
    amazonAvailability: null,
    avg30PriceCents: null,
    avg90PriceCents: null,
    avg180PriceCents: null,
    avg365PriceCents: null,
    avg30SalesRank: null,
    avg90SalesRank: null,
  };
}
```

```ts
// lib/keepa/parseProduct.ts
/**
 * Pure parser: one Keepa product object (requested with rating=1, stats=90 and no history)
 * → ProductFacts (spec 2026-10-05 §5.1 step 5). No I/O.
 *
 * Every number comes from the `stats` object (`current`, `avg30`, `avg90`, `avg180`, `avg365`),
 * indexed by Keepa's Price Type; when a reply carries csv history instead (the `days=7`
 * fallback), the last csv value stands in for `current`. Keepa's −1 and anything below a
 * field's floor becomes null. A missing product is the caller's "delisted" (parseKeepaBatch).
 */
import { emptyFacts, type PriceSource, type ProductFacts } from './productFacts';

/** Keepa "Price Type" indices, shared by the csv arrays and every stats array. */
export const PRICE_TYPE = {
  AMAZON: 0,
  NEW: 1,
  SALES: 3,
  COUNT_NEW: 11,
  RATING: 16,
  COUNT_REVIEWS: 17,
  COUNT_NEW_FBA: 34,
  COUNT_NEW_FBM: 35,
} as const;

const AMAZON_IMAGE_CDN = 'https://m.media-amazon.com/images/I/';
/** Keepa epoch 2011-01-01T00:00Z expressed in unix minutes. */
const KEEPA_EPOCH_UNIX_MINUTES = 21_564_000;

/** Keepa Time minutes → ISO date; Keepa's 0 / −1 ("unknown") → null. */
export function keepaMinutesToDate(km: unknown): string | null {
  if (typeof km !== 'number' || !Number.isFinite(km) || km <= 0) return null;
  return new Date((km + KEEPA_EPOCH_UNIX_MINUTES) * 60_000).toISOString().slice(0, 10);
}

/** Medium-resolution primary image (~500 px), as the old parser did. */
export function primaryImageUrl(images: unknown): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  const first = images[0] as { m?: unknown } | null;
  if (!first || typeof first !== 'object') return null;
  return typeof first.m === 'string' && first.m.length > 0 ? `${AMAZON_IMAGE_CDN}${first.m}` : null;
}

type Floor = 'positive' | 'nonNegative' | 'rating';

function clean(v: unknown, floor: Floor): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (floor === 'positive') return n > 0 ? n : null;
  if (floor === 'rating') return n >= 0 && n <= 50 ? n : null;
  return n >= 0 ? n : null;
}

function stat(stats: unknown, key: string, index: number, floor: Floor): number | null {
  const arr = (stats as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(arr) ? clean(arr[index], floor) : null;
}

function csvLast(csv: unknown, index: number, floor: Floor): number | null {
  if (!Array.isArray(csv)) return null;
  const series = csv[index];
  if (!Array.isArray(series) || series.length < 2) return null;
  return clean(series[series.length - 1], floor);
}

function current(p: Record<string, unknown>, index: number, floor: Floor): number | null {
  return stat(p.stats, 'current', index, floor) ?? csvLast(p.csv, index, floor);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function parseProductFacts(raw: unknown, expectedAsin: string): ProductFacts {
  if (!raw || typeof raw !== 'object') return emptyFacts(expectedAsin, 'error', 'bad_object');
  const p = raw as Record<string, unknown>;
  if (p.asin !== expectedAsin) return emptyFacts(expectedAsin, 'error', 'asin_mismatch');

  const amazon = current(p, PRICE_TYPE.AMAZON, 'positive');
  const newPrice = current(p, PRICE_TYPE.NEW, 'positive');
  const priceSource: PriceSource | null = amazon !== null ? 'amazon' : newPrice !== null ? 'new' : null;
  const priceIndex = priceSource === 'amazon' ? PRICE_TYPE.AMAZON : PRICE_TYPE.NEW;
  const priceAvg = (key: string) => (priceSource ? stat(p.stats, key, priceIndex, 'positive') : null);

  const tree = Array.isArray(p.categoryTree)
    ? (p.categoryTree as Array<{ name?: unknown } | null>).map((n) => str(n?.name)).filter((n): n is string => n !== null)
    : [];
  const availability =
    typeof p.availabilityAmazon === 'number' && Number.isInteger(p.availabilityAmazon) && p.availabilityAmazon >= -1 && p.availabilityAmazon <= 4
      ? p.availabilityAmazon
      : null;

  return {
    asin: expectedAsin,
    status: priceSource ? 'active' : 'no_price',
    errorCode: null,
    title: str(p.title),
    brand: str(p.brand),
    imageUrl: primaryImageUrl(p.images),
    categoryPath: tree.length > 0 ? tree.join(' › ') : null,
    categoryRoot: tree[0] ?? null,
    categoryLeaf: tree.length > 0 ? tree[tree.length - 1] : null,
    listedSince: keepaMinutesToDate(p.listedSince),
    trackingSince: keepaMinutesToDate(p.trackingSince),
    currentPriceCents: priceSource === 'amazon' ? amazon : newPrice,
    priceSource,
    salesRank: current(p, PRICE_TYPE.SALES, 'positive'),
    reviewCount: current(p, PRICE_TYPE.COUNT_REVIEWS, 'nonNegative'),
    averageRatingX10: current(p, PRICE_TYPE.RATING, 'rating'),
    lastRatingUpdate: keepaMinutesToDate(p.lastRatingUpdate),
    monthlySold: clean(p.monthlySold, 'positive'),
    keepaUpdatedAt: keepaMinutesToDate(p.lastUpdate),
    newOfferCount: current(p, PRICE_TYPE.COUNT_NEW, 'nonNegative'),
    fbaOfferCount: current(p, PRICE_TYPE.COUNT_NEW_FBA, 'nonNegative'),
    fbmOfferCount: current(p, PRICE_TYPE.COUNT_NEW_FBM, 'nonNegative'),
    amazonAvailability: availability,
    avg30PriceCents: priceAvg('avg30'),
    avg90PriceCents: priceAvg('avg90'),
    avg180PriceCents: priceAvg('avg180'),
    avg365PriceCents: priceAvg('avg365'),
    avg30SalesRank: stat(p.stats, 'avg30', PRICE_TYPE.SALES, 'positive'),
    avg90SalesRank: stat(p.stats, 'avg90', PRICE_TYPE.SALES, 'positive'),
  };
}

/** One entry per requested ASIN; a requested ASIN with no product in the reply is delisted. */
export function parseKeepaBatch(requested: readonly string[], products: unknown): Map<string, ProductFacts> {
  const byAsin = new Map<string, unknown>();
  if (Array.isArray(products)) {
    for (const raw of products) {
      const a = (raw as { asin?: unknown } | null)?.asin;
      if (typeof a === 'string') byAsin.set(a, raw);
    }
  }
  const out = new Map<string, ProductFacts>();
  for (const asin of requested) {
    const raw = byAsin.get(asin);
    out.set(asin, raw === undefined ? emptyFacts(asin, 'delisted') : parseProductFacts(raw, asin));
  }
  return out;
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run lib/keepa/parseProduct.test.ts`
Expected: PASS (11 tests). If the fixture's second product fails the structural test, note which field and adjust only the assertion, never the parser, unless the parser is wrong.

- [ ] **Step 6: Lint and commit**

```bash
pnpm exec eslint lib/keepa/productFacts.ts lib/keepa/parseProduct.ts lib/keepa/parseProduct.test.ts
git add lib/keepa/productFacts.ts lib/keepa/parseProduct.ts lib/keepa/parseProduct.test.ts lib/keepa/__fixtures__/batch-stats.json
git commit -m "feat(keepa): ProductFacts + stats-based batch parser (price-source fallback, validation floors, delisted-by-absence) with a fixture captured in the service's request shape

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Batch client — `lib/keepa/batchClient.ts`

**Files:**
- Create: `lib/keepa/batchClient.ts`
- Test: `lib/keepa/batchClient.test.ts`
- Read first: `lib/keepa/client.ts` (old single-ASIN client; its 30 s timeout rationale), Task 4's capture decision (`HISTORY_PARAMS`).

- [ ] **Step 1: Write the failing test**

```ts
// lib/keepa/batchClient.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  fetchKeepaBatch,
  fetchTokenStatus,
  buildProductUrl,
  KeepaHttpError,
  KeepaTokenError,
  HISTORY_PARAMS,
  STATS_DAYS,
} from './batchClient';

const KEY = 'secret-key-value';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe('buildProductUrl', () => {
  it('asks for all ASINs in one request with rating and stats, and the history switch from the capture decision', () => {
    const url = new URL(buildProductUrl(['B000000001', 'B000000002'], KEY));
    expect(url.origin + url.pathname).toBe('https://api.keepa.com/product');
    expect(url.searchParams.get('domain')).toBe('1');
    expect(url.searchParams.get('asin')).toBe('B000000001,B000000002');
    expect(url.searchParams.get('rating')).toBe('1');
    expect(url.searchParams.get('stats')).toBe(STATS_DAYS);
    for (const [k, v] of Object.entries(HISTORY_PARAMS)) expect(url.searchParams.get(k)).toBe(v);
    expect(url.searchParams.get('key')).toBe(KEY);
  });
});

describe('fetchKeepaBatch', () => {
  it('returns the products and the token envelope', async () => {
    const f = fakeFetch(200, { products: [{ asin: 'B000000001' }], tokensLeft: 14_800, refillIn: 12_000, refillRate: 250, tokensConsumed: 2 });
    const r = await fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: f });
    expect(r.products).toHaveLength(1);
    expect(r).toMatchObject({ tokensLeft: 14_800, refillIn: 12_000, refillRate: 250, tokensConsumed: 2 });
  });
  it('tolerates a reply without products', async () => {
    const r = await fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(200, { tokensLeft: 1 }) });
    expect(r.products).toEqual([]);
    expect(r.refillRate).toBeNull();
  });
  it('turns 429 into KeepaTokenError carrying refillIn (ms), defaulting to a minute', async () => {
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(429, { refillIn: 31_000 }) })).rejects.toMatchObject({ name: 'KeepaTokenError', refillInMs: 31_000 });
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(429, {}) })).rejects.toMatchObject({ refillInMs: 60_000 });
  });
  it('turns other failures into KeepaHttpError with the status and no key in the message', async () => {
    const err = await fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(503, {}) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeepaHttpError);
    expect((err as KeepaHttpError).status).toBe(503);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(new KeepaTokenError(5).message).not.toContain(KEY);
  });
  it('refuses an empty or oversized batch before any request', async () => {
    const f = fakeFetch(200, {});
    await expect(fetchKeepaBatch([], { apiKey: KEY, fetchImpl: f })).rejects.toThrow();
    await expect(fetchKeepaBatch(new Array(101).fill('B000000001'), { apiKey: KEY, fetchImpl: f })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('fetchTokenStatus', () => {
  it('reads the free token endpoint', async () => {
    const f = fakeFetch(200, { tokensLeft: 15_000, refillRate: 250, refillIn: 12_729 });
    await expect(fetchTokenStatus({ apiKey: KEY, fetchImpl: f })).resolves.toEqual({ tokensLeft: 15_000, refillRate: 250, refillIn: 12_729 });
    const url = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0][0];
    expect(url.startsWith('https://api.keepa.com/token?')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run lib/keepa/batchClient.test.ts`
Expected: FAIL — `Cannot find module './batchClient'`.

- [ ] **Step 3: Implement**

```ts
// lib/keepa/batchClient.ts
/**
 * Keepa multi-ASIN product request + the free token-status call (spec 2026-10-05 §5.1 step 4).
 *
 * No retries and no pacing here: services/keepa/loop.ts owns both. Errors are typed so the
 * loop can tell "tokens exhausted" (sleep refillIn) from "Keepa rejected the request" (4xx)
 * from "Keepa is down" (5xx / network). Error messages never carry the key.
 */
import { BATCH_SIZE } from './lanes';

export const KEEPA_PRODUCT_URL = 'https://api.keepa.com/product';
export const KEEPA_TOKEN_URL = 'https://api.keepa.com/token';
/** Keepa computes weighted averages over this window; avg30/90/180/365 come regardless. */
export const STATS_DAYS = '90';
/**
 * Task 4's capture decision: `history=0` drops every history array (small replies) when
 * stats.current carries the offer-count indices 34/35; otherwise `days=7` keeps a week of csv
 * and the parser reads the last csv value instead.
 */
export const HISTORY_PARAMS: Readonly<Record<string, string>> = { history: '0' };

export interface KeepaBatchReply {
  products: unknown[];
  tokensLeft: number | null;
  refillIn: number | null;
  refillRate: number | null;
  tokensConsumed: number | null;
}

export interface KeepaClientDeps {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class KeepaHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`keepa_http_${status}`);
    this.name = 'KeepaHttpError';
    this.status = status;
  }
}

export class KeepaTokenError extends Error {
  readonly refillInMs: number;
  constructor(refillInMs: number) {
    super('keepa_tokens_exhausted');
    this.name = 'KeepaTokenError';
    this.refillInMs = refillInMs;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function buildProductUrl(asins: readonly string[], apiKey: string): string {
  const qs = new URLSearchParams({ key: apiKey, domain: '1', asin: asins.join(','), rating: '1', stats: STATS_DAYS, ...HISTORY_PARAMS });
  return `${KEEPA_PRODUCT_URL}?${qs.toString()}`;
}

export async function fetchKeepaBatch(asins: readonly string[], deps: KeepaClientDeps): Promise<KeepaBatchReply> {
  if (asins.length === 0 || asins.length > BATCH_SIZE) throw new Error(`batch size ${asins.length} out of range 1..${BATCH_SIZE}`);
  const f = deps.fetchImpl ?? fetch;
  const res = await f(buildProductUrl(asins, deps.apiKey), { signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000) });
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { refillIn?: unknown };
    throw new KeepaTokenError(num(body.refillIn) ?? 60_000);
  }
  if (!res.ok) throw new KeepaHttpError(res.status);
  const body = (await res.json()) as Record<string, unknown>;
  return {
    products: Array.isArray(body.products) ? body.products : [],
    tokensLeft: num(body.tokensLeft),
    refillIn: num(body.refillIn),
    refillRate: num(body.refillRate),
    tokensConsumed: num(body.tokensConsumed),
  };
}

/** Free: no tokens consumed. */
export async function fetchTokenStatus(deps: KeepaClientDeps): Promise<{ tokensLeft: number | null; refillRate: number | null; refillIn: number | null }> {
  const f = deps.fetchImpl ?? fetch;
  const qs = new URLSearchParams({ key: deps.apiKey });
  const res = await f(`${KEEPA_TOKEN_URL}?${qs.toString()}`, { signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000) });
  if (!res.ok) throw new KeepaHttpError(res.status);
  const body = (await res.json()) as Record<string, unknown>;
  return { tokensLeft: num(body.tokensLeft), refillRate: num(body.refillRate), refillIn: num(body.refillIn) };
}
```

If Task 4 decided on `days=7`, set `HISTORY_PARAMS` to `{ days: '7' }` here and say so in the commit message.

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run lib/keepa/batchClient.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec eslint lib/keepa/batchClient.ts lib/keepa/batchClient.test.ts
git add lib/keepa/batchClient.ts lib/keepa/batchClient.test.ts
git commit -m "feat(keepa): multi-ASIN batch client with typed token/HTTP errors and the free token-status call

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Service store — interface, Postgres implementation, pool, log-safe fields

**Files:**
- Create: `services/keepa/store.ts`, `services/keepa/pgStore.ts`, `services/keepa/db.ts`, `services/keepa/log.ts`
- Test: `services/keepa/log.test.ts`, `services/keepa/pgStore.test.ts` (SQL shape with a fake client; the real-database check is Task 8's integration test)
- Read first: spec §5.1 step 2 (lane order), §5.2 (outcome table), §4.3 (status columns); `worker/keepaJobs.ts` `insertRow` (the old upsert and its never-downgrade guard).

- [ ] **Step 1: Write the failing tests**

```ts
// services/keepa/log.test.ts
import { describe, it, expect, vi } from 'vitest';
import { errFields, logLine } from './log';

describe('errFields', () => {
  it('keeps the name, a Postgres code and an HTTP status — never the message', () => {
    const pgErr = Object.assign(new Error('password authentication failed for user "x"'), { code: '28P01' });
    expect(errFields(pgErr)).toEqual({ error: 'Error', code: '28P01' });
    const http = Object.assign(new Error('keepa_http_503'), { name: 'KeepaHttpError', status: 503 });
    expect(errFields(http)).toEqual({ error: 'KeepaHttpError', status: 503 });
    expect(JSON.stringify(errFields(pgErr))).not.toContain('password');
    expect(errFields('boom')).toEqual({ error: 'string' });
  });
});

describe('logLine', () => {
  it('writes one JSON line under the service tag', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logLine({ event: 'batch', lane: 'new', requested: 100 });
    expect(spy).toHaveBeenCalledWith('[keepa-svc]', '{"event":"batch","lane":"new","requested":100}');
    spy.mockRestore();
  });
});
```

```ts
// services/keepa/pgStore.test.ts
/**
 * SQL-shape tests with a recording fake client. Order of statements, parameters and the
 * never-downgrade rule are asserted here; Task 8's integration test runs the real thing.
 */
import { describe, it, expect } from 'vitest';
import { PgKeepaStore } from './pgStore';
import type { ClaimedRow } from './store';
import { emptyFacts, type ProductFacts } from '@/lib/keepa/productFacts';

interface Call { text: string; values: unknown[] | undefined }

function fakePool(responder: (text: string, values: unknown[] | undefined) => { rows?: unknown[]; rowCount?: number } = () => ({})) {
  const calls: Call[] = [];
  const query = async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    const r = responder(text, values);
    return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
  };
  const client = { query, release: () => {} };
  return { pool: { query, connect: async () => client } as never, calls };
}

const NOW = new Date('2026-10-06T12:00:00Z');
const row = (asin: string, over: Partial<ClaimedRow> = {}): ClaimedRow => ({ asin, tier: 1, lane: 'new', lastFetchedAt: null, consecutiveErrors: 0, ...over });
const active = (asin: string): ProductFacts => ({ ...emptyFacts(asin, 'delisted'), status: 'active', title: 'T', currentPriceCents: 1299, priceSource: 'amazon', salesRank: 10, reviewCount: 5 });

describe('claimBatch', () => {
  it('fills the batch lane by lane inside one transaction: tier-1 new, tier-1 due, then tier 2 only with the tail on', async () => {
    const { pool, calls } = fakePool((text, values) => (text.includes('RETURNING') ? { rows: [{ asin: `A${values?.[0]}${text.includes('IS NULL AND tier') ? 'N' : 'D'}`, tier: values?.[0], last_fetched_at: null, consecutive_errors: 0 }] } : {}));
    const store = new PgKeepaStore(pool);
    const rows = await store.claimBatch({ limit: 100, tailEnabled: false, bootId: 'boot-1' });
    expect(calls[0].text).toBe('BEGIN');
    expect(calls.at(-1)?.text).toBe('COMMIT');
    const claims = calls.filter((c) => c.text.includes('RETURNING'));
    expect(claims).toHaveLength(2);
    expect(claims[0].text).toContain('last_fetched_at IS NULL AND tier = $1');
    expect(claims[0].text).toContain('ORDER BY best_rank NULLS LAST, asin');
    expect(claims[0].text).toContain('FOR UPDATE SKIP LOCKED');
    expect(claims[0].values).toEqual([1, 100, 'boot-1']);
    expect(claims[1].text).toContain('last_fetched_at IS NOT NULL AND tier = $1');
    expect(claims[1].text).toContain('ORDER BY next_due_at, asin');
    expect(claims[1].values).toEqual([1, 99, 'boot-1']);
    expect(rows.map((r) => r.lane)).toEqual(['new', 'due']);

    const { pool: pool2, calls: c2 } = fakePool((text) => (text.includes('RETURNING') ? { rows: [] } : {}));
    await new PgKeepaStore(pool2).claimBatch({ limit: 100, tailEnabled: true, bootId: 'b' });
    expect(c2.filter((c) => c.text.includes('RETURNING')).map((c) => c.values?.[0])).toEqual([1, 1, 2, 2]);
  });

  it('stops claiming once the batch is full', async () => {
    const { pool, calls } = fakePool((text, values) => (text.includes('RETURNING') ? { rows: new Array(values?.[1] as number).fill(0).map((_, i) => ({ asin: `A${i}`, tier: 1, last_fetched_at: null, consecutive_errors: 0 })) } : {}));
    const rows = await new PgKeepaStore(pool).claimBatch({ limit: 5, tailEnabled: true, bootId: 'b' });
    expect(rows).toHaveLength(5);
    expect(calls.filter((c) => c.text.includes('RETURNING'))).toHaveLength(1);
  });

  it('rolls back when a claim statement fails', async () => {
    const { pool, calls } = fakePool((text) => { if (text.includes('RETURNING')) throw Object.assign(new Error('x'), { code: '57014' }); return {}; });
    await expect(new PgKeepaStore(pool).claimBatch({ limit: 5, tailEnabled: false, bootId: 'b' })).rejects.toMatchObject({ code: '57014' });
    expect(calls.map((c) => c.text)).toEqual(['BEGIN', expect.stringContaining('RETURNING'), 'ROLLBACK']);
  });
});

describe('writeBatch outcomes (spec §5.2)', () => {
  it('an active fetch replaces the facts, resets errors, sets the weekly due date and writes a snapshot', async () => {
    const { pool, calls } = fakePool();
    const r = row('B1');
    await new PgKeepaStore(pool).writeBatch({ rows: [r], facts: new Map([['B1', active('B1')]]), lane: 'new', tokens: { tokensLeft: 14_800, refillRate: 250 }, now: NOW });
    const upd = calls.find((c) => c.text.includes('UPDATE asin_products SET') && c.text.includes('title = $2'))!;
    expect(upd.values?.[0]).toBe('B1');
    expect(upd.values?.[27]).toBe('active');
    expect(upd.values?.[28]).toEqual(NOW);
    expect(upd.values?.[29]).toEqual(new Date('2026-10-13T12:00:00Z'));
    expect(upd.text).toContain('fetch_count = fetch_count + 1, consecutive_errors = 0');
    expect(upd.text).toContain('claimed_at = NULL, claimed_by = NULL');
    const snap = calls.find((c) => c.text.includes('INSERT INTO asin_snapshots'))!;
    expect(snap.values).toEqual(['B1', NOW, 1299, 10, 5, null, null, null, null, null, 'active']);
    const status = calls.find((c) => c.text.includes('UPDATE keepa_service_status'))!;
    expect(status.values).toEqual([NOW, 'new', 14_800, 250]);
    expect(calls[0].text).toBe('BEGIN');
    expect(calls.at(-1)?.text).toBe('COMMIT');
  });

  it('tier 2 gets a 30-day due date', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).writeBatch({ rows: [row('B1', { tier: 2, lane: 'tail' })], facts: new Map([['B1', active('B1')]]), lane: 'tail', tokens: { tokensLeft: null, refillRate: null }, now: NOW });
    const upd = calls.find((c) => c.text.includes('title = $2'))!;
    expect(upd.values?.[29]).toEqual(new Date('2026-11-05T12:00:00Z'));
  });

  it('a delisted product keeps its facts, flips the status, and is rechecked in 30 days', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).writeBatch({ rows: [row('B1')], facts: new Map([['B1', emptyFacts('B1', 'delisted')]]), lane: 'due', tokens: { tokensLeft: 1, refillRate: 250 }, now: NOW });
    const upd = calls.find((c) => c.text.includes("enrichment_status = 'delisted'"))!;
    expect(upd.text).not.toContain('title =');
    expect(upd.values).toEqual(['B1', NOW, new Date('2026-11-05T12:00:00Z')]);
    expect(calls.find((c) => c.text.includes('INSERT INTO asin_snapshots'))?.values?.[10]).toBe('delisted');
  });

  it('a bad object never downgrades a fetched row: status unchanged, facts kept, backoff from the error count, last_fetched_at untouched', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).writeBatch({ rows: [row('B1', { consecutiveErrors: 2, lastFetchedAt: new Date('2026-09-01T00:00:00Z') })], facts: new Map([['B1', emptyFacts('B1', 'error', 'bad_object')]]), lane: 'due', tokens: { tokensLeft: 1, refillRate: 250 }, now: NOW });
    const upd = calls.find((c) => c.text.includes('consecutive_errors = consecutive_errors + 1'))!;
    expect(upd.text).toContain("CASE WHEN last_fetched_at IS NULL THEN 'error'::asin_enrichment_status ELSE enrichment_status END");
    expect(upd.text).not.toContain('last_fetched_at = ');
    expect(upd.values).toEqual(['B1', 'bad_object', new Date('2026-10-10T12:00:00Z')]);
  });

  it('a row missing from the parse map is written as an error too', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).writeBatch({ rows: [row('B1')], facts: new Map(), lane: 'new', tokens: { tokensLeft: 1, refillRate: 250 }, now: NOW });
    expect(calls.find((c) => c.text.includes('consecutive_errors = consecutive_errors + 1'))?.values?.[1]).toBe('missing_from_parse');
  });
});

describe('markBatchErrored, releaseStaleClaims, status writes', () => {
  it('markBatchErrored applies the error outcome to every row and records the code on the status row', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).markBatchErrored({ rows: [row('B1'), row('B2')], errorCode: 'keepa_http_503', now: NOW });
    expect(calls.filter((c) => c.text.includes('consecutive_errors = consecutive_errors + 1'))).toHaveLength(2);
    expect(calls.find((c) => c.text.includes('last_error_code = $1'))?.values).toEqual(['keepa_http_503']);
  });
  it('releaseStaleClaims clears claims older than the threshold and reports the count', async () => {
    const { pool, calls } = fakePool(() => ({ rowCount: 7 }));
    await expect(new PgKeepaStore(pool).releaseStaleClaims(600_000).then((n) => n)).resolves.toBe(7);
    expect(calls[0].text).toContain('SET claimed_at = NULL, claimed_by = NULL WHERE claimed_at IS NOT NULL AND claimed_at <');
    expect(calls[0].values).toEqual([600]);
  });
  it('recordBoot upserts the singleton with the tail switch; heartbeat keeps known token values', async () => {
    const { pool, calls } = fakePool();
    const store = new PgKeepaStore(pool);
    await store.recordBoot('boot-1', true);
    expect(calls[0].text).toContain('ON CONFLICT (singleton) DO UPDATE');
    expect(calls[0].values).toEqual(['boot-1', true]);
    await store.heartbeat({ tokensLeft: null, refillRate: 250 });
    expect(calls[1].text).toContain('tokens_left = COALESCE($1, tokens_left)');
    expect(calls[1].values).toEqual([null, 250]);
    await store.markNewLaneDrained();
    expect(calls[2].text).toContain('lane_new_drained_at = now()');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run services/keepa`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the four modules**

```ts
// services/keepa/log.ts
/**
 * Log-safe logging for the Keepa service: one JSON line per event, coded fields only.
 * An error contributes its class name, a Postgres `code` and an HTTP `status` — never its
 * message (a pg message can carry the connection string's user; a fetch error can carry a URL).
 */
export interface ErrFields {
  error: string;
  code?: string;
  status?: number;
}

export function errFields(e: unknown): ErrFields {
  const o = (e ?? null) as { name?: unknown; code?: unknown; status?: unknown } | null;
  return {
    error: e instanceof Error ? e.name : typeof e,
    ...(typeof o?.code === 'string' ? { code: o.code } : {}),
    ...(typeof o?.status === 'number' ? { status: o.status } : {}),
  };
}

export function logLine(fields: Record<string, unknown>): void {
  console.log('[keepa-svc]', JSON.stringify(fields));
}
```

```ts
// services/keepa/db.ts
import { Pool } from 'pg';
import { errFields, logLine } from './log';

/** The service's own pool (spec §3.1): never the app's db/client, which loads the full env schema. */
export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 3,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 300_000,
  });
  pool.on('error', (e) => logLine({ event: 'pool_error', ...errFields(e) }));
  return pool;
}
```

```ts
// services/keepa/store.ts
import type { Lane, Tier } from '@/lib/keepa/lanes';
import type { ProductFacts } from '@/lib/keepa/productFacts';

export interface ClaimedRow {
  asin: string;
  tier: Tier;
  lane: Lane;
  lastFetchedAt: Date | null;
  consecutiveErrors: number;
}

export interface TokenInfo {
  tokensLeft: number | null;
  refillRate: number | null;
}

/** Everything the loop needs from Postgres, so the loop can be tested with an in-memory fake. */
export interface KeepaStore {
  recordBoot(bootId: string, tailEnabled: boolean): Promise<void>;
  releaseStaleClaims(olderThanMs: number): Promise<number>;
  claimBatch(args: { limit: number; tailEnabled: boolean; bootId: string }): Promise<ClaimedRow[]>;
  writeBatch(args: { rows: ClaimedRow[]; facts: Map<string, ProductFacts>; lane: Lane; tokens: TokenInfo; now: Date }): Promise<void>;
  markBatchErrored(args: { rows: ClaimedRow[]; errorCode: string; now: Date }): Promise<void>;
  heartbeat(tokens: TokenInfo): Promise<void>;
  recordError(code: string): Promise<void>;
  markNewLaneDrained(): Promise<void>;
}
```

```ts
// services/keepa/pgStore.ts
/**
 * Postgres implementation of KeepaStore (spec 2026-10-05 §5.1 steps 2 and 6, §5.2).
 *
 * Claims: lane by lane, each an index-ordered `SELECT … FOR UPDATE SKIP LOCKED LIMIT n` turned
 * into an UPDATE, all in one transaction. Writes: one transaction per batch — a per-row UPDATE
 * (success / delisted / error shape), one snapshot INSERT per row, the status row last.
 */
import type { Pool, PoolClient } from 'pg';
import { nextDueAfterDelisted, nextDueAfterError, nextDueAfterSuccess, type Lane, type Tier } from '@/lib/keepa/lanes';
import { emptyFacts, type ProductFacts } from '@/lib/keepa/productFacts';
import type { ClaimedRow, KeepaStore, TokenInfo } from './store';

interface ClaimRowRaw {
  asin: string;
  tier: number;
  last_fetched_at: Date | null;
  consecutive_errors: number;
}

const CLAIM_NEW = `
  WITH picked AS (
    SELECT asin FROM asin_products
    WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NULL AND tier = $1 AND next_due_at <= now()
    ORDER BY best_rank NULLS LAST, asin
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  UPDATE asin_products p SET claimed_at = now(), claimed_by = $3
  FROM picked WHERE p.asin = picked.asin
  RETURNING p.asin, p.tier, p.last_fetched_at, p.consecutive_errors`;

const CLAIM_DUE = `
  WITH picked AS (
    SELECT asin FROM asin_products
    WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NOT NULL AND tier = $1 AND next_due_at <= now()
    ORDER BY next_due_at, asin
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  UPDATE asin_products p SET claimed_at = now(), claimed_by = $3
  FROM picked WHERE p.asin = picked.asin
  RETURNING p.asin, p.tier, p.last_fetched_at, p.consecutive_errors`;

const SUCCESS_UPDATE = `
  UPDATE asin_products SET
    title = $2, brand = $3, image_url = $4, category_path = $5, category_root = $6, category_leaf = $7,
    listed_since = $8, tracking_since = $9,
    current_price_cents = $10, price_source = $11, sales_rank = $12, review_count = $13, average_rating_x10 = $14, last_rating_update = $15,
    monthly_sold = $16, keepa_updated_at = $17, new_offer_count = $18, fba_offer_count = $19, fbm_offer_count = $20, amazon_availability = $21,
    avg30_price_cents = $22, avg90_price_cents = $23, avg180_price_cents = $24, avg365_price_cents = $25, avg30_sales_rank = $26, avg90_sales_rank = $27,
    enrichment_status = $28::asin_enrichment_status, error_code = NULL,
    last_fetched_at = $29, fetch_count = fetch_count + 1, consecutive_errors = 0,
    next_due_at = $30, claimed_at = NULL, claimed_by = NULL, updated_at = now()
  WHERE asin = $1`;

const DELISTED_UPDATE = `
  UPDATE asin_products SET
    enrichment_status = 'delisted', error_code = NULL,
    last_fetched_at = $2, fetch_count = fetch_count + 1, consecutive_errors = 0,
    next_due_at = $3, claimed_at = NULL, claimed_by = NULL, updated_at = now()
  WHERE asin = $1`;

/** Never downgrades a fetched row: facts and status stay unless the ASIN was never fetched. */
const ERROR_UPDATE = `
  UPDATE asin_products SET
    enrichment_status = CASE WHEN last_fetched_at IS NULL THEN 'error'::asin_enrichment_status ELSE enrichment_status END,
    error_code = $2, consecutive_errors = consecutive_errors + 1,
    next_due_at = $3, claimed_at = NULL, claimed_by = NULL, updated_at = now()
  WHERE asin = $1`;

const SNAPSHOT_INSERT = `
  INSERT INTO asin_snapshots (asin, fetched_at, current_price_cents, sales_rank, review_count, average_rating_x10,
    monthly_sold, new_offer_count, fba_offer_count, fbm_offer_count, enrichment_status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::asin_enrichment_status)
  ON CONFLICT DO NOTHING`;

type Queryable = Pick<PoolClient, 'query'>;

async function writeRow(c: Queryable, row: ClaimedRow, f: ProductFacts, now: Date): Promise<void> {
  if (f.status === 'active' || f.status === 'no_price') {
    await c.query(SUCCESS_UPDATE, [
      row.asin, f.title, f.brand, f.imageUrl, f.categoryPath, f.categoryRoot, f.categoryLeaf,
      f.listedSince, f.trackingSince,
      f.currentPriceCents, f.priceSource, f.salesRank, f.reviewCount, f.averageRatingX10, f.lastRatingUpdate,
      f.monthlySold, f.keepaUpdatedAt, f.newOfferCount, f.fbaOfferCount, f.fbmOfferCount, f.amazonAvailability,
      f.avg30PriceCents, f.avg90PriceCents, f.avg180PriceCents, f.avg365PriceCents, f.avg30SalesRank, f.avg90SalesRank,
      f.status, now, nextDueAfterSuccess(row.tier, now),
    ]);
  } else if (f.status === 'delisted') {
    await c.query(DELISTED_UPDATE, [row.asin, now, nextDueAfterDelisted(now)]);
  } else {
    await c.query(ERROR_UPDATE, [row.asin, f.errorCode ?? 'error', nextDueAfterError(row.consecutiveErrors + 1, now)]);
  }
  await c.query(SNAPSHOT_INSERT, [
    row.asin, now, f.currentPriceCents, f.salesRank, f.reviewCount, f.averageRatingX10,
    f.monthlySold, f.newOfferCount, f.fbaOfferCount, f.fbmOfferCount, f.status,
  ]);
}

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    try {
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  } finally {
    c.release();
  }
}

export class PgKeepaStore implements KeepaStore {
  constructor(private readonly pool: Pool) {}

  async recordBoot(bootId: string, tailEnabled: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO keepa_service_status (singleton, boot_id, booted_at, heartbeat_at, tail_enabled)
       VALUES (true, $1, now(), now(), $2)
       ON CONFLICT (singleton) DO UPDATE SET boot_id = EXCLUDED.boot_id, booted_at = EXCLUDED.booted_at,
         heartbeat_at = now(), tail_enabled = EXCLUDED.tail_enabled`,
      [bootId, tailEnabled],
    );
  }

  async releaseStaleClaims(olderThanMs: number): Promise<number> {
    const r = await this.pool.query(
      `UPDATE asin_products SET claimed_at = NULL, claimed_by = NULL WHERE claimed_at IS NOT NULL AND claimed_at < now() - make_interval(secs => $1::float8)`,
      [olderThanMs / 1000],
    );
    return r.rowCount ?? 0;
  }

  async claimBatch(args: { limit: number; tailEnabled: boolean; bootId: string }): Promise<ClaimedRow[]> {
    const plan: Array<{ sql: string; tier: Tier; lane: Lane }> = [
      { sql: CLAIM_NEW, tier: 1, lane: 'new' },
      { sql: CLAIM_DUE, tier: 1, lane: 'due' },
      ...(args.tailEnabled
        ? [{ sql: CLAIM_NEW, tier: 2 as Tier, lane: 'tail' as Lane }, { sql: CLAIM_DUE, tier: 2 as Tier, lane: 'tail' as Lane }]
        : []),
    ];
    return inTransaction(this.pool, async (c) => {
      const out: ClaimedRow[] = [];
      for (const step of plan) {
        const remaining = args.limit - out.length;
        if (remaining <= 0) break;
        const r = await c.query<ClaimRowRaw>(step.sql, [step.tier, remaining, args.bootId]);
        for (const row of r.rows) {
          out.push({ asin: row.asin, tier: step.tier, lane: step.lane, lastFetchedAt: row.last_fetched_at, consecutiveErrors: row.consecutive_errors });
        }
      }
      return out;
    });
  }

  async writeBatch(args: { rows: ClaimedRow[]; facts: Map<string, ProductFacts>; lane: Lane; tokens: TokenInfo; now: Date }): Promise<void> {
    await inTransaction(this.pool, async (c) => {
      for (const row of args.rows) {
        await writeRow(c, row, args.facts.get(row.asin) ?? emptyFacts(row.asin, 'error', 'missing_from_parse'), args.now);
      }
      await c.query(
        `UPDATE keepa_service_status SET heartbeat_at = now(), last_batch_at = $1, last_batch_lane = $2,
           tokens_left = COALESCE($3, tokens_left), refill_rate = COALESCE($4, refill_rate) WHERE singleton`,
        [args.now, args.lane, args.tokens.tokensLeft, args.tokens.refillRate],
      );
    });
  }

  async markBatchErrored(args: { rows: ClaimedRow[]; errorCode: string; now: Date }): Promise<void> {
    await inTransaction(this.pool, async (c) => {
      for (const row of args.rows) await writeRow(c, row, emptyFacts(row.asin, 'error', args.errorCode), args.now);
      await c.query(`UPDATE keepa_service_status SET heartbeat_at = now(), last_error_code = $1, last_error_at = now() WHERE singleton`, [args.errorCode]);
    });
  }

  async heartbeat(tokens: TokenInfo): Promise<void> {
    await this.pool.query(
      `UPDATE keepa_service_status SET heartbeat_at = now(), tokens_left = COALESCE($1, tokens_left), refill_rate = COALESCE($2, refill_rate) WHERE singleton`,
      [tokens.tokensLeft, tokens.refillRate],
    );
  }

  async recordError(code: string): Promise<void> {
    await this.pool.query(`UPDATE keepa_service_status SET heartbeat_at = now(), last_error_code = $1, last_error_at = now() WHERE singleton`, [code]);
  }

  async markNewLaneDrained(): Promise<void> {
    await this.pool.query(`UPDATE keepa_service_status SET lane_new_drained_at = now() WHERE singleton`);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run services/keepa`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
pnpm exec eslint services/keepa
git add services/keepa/store.ts services/keepa/pgStore.ts services/keepa/db.ts services/keepa/log.ts services/keepa/log.test.ts services/keepa/pgStore.test.ts
git commit -m "feat(keepa-service): store interface + Postgres claims/write/status with lane-ordered SKIP LOCKED claims and the never-downgrade rule

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The loop — `services/keepa/loop.ts`

**Files:**
- Create: `services/keepa/loop.ts`
- Test: `services/keepa/loop.test.ts`
- Read first: spec §5.1 (steps 2–7), §5.3; Task 6's `KeepaStore`; Task 5's errors.

- [ ] **Step 1: Write the failing tests**

```ts
// services/keepa/loop.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runIteration, initialState, type LoopDeps, IDLE_SLEEP_MS, DB_RETRY_SLEEP_MS, KEEPA_RETRY_SLEEP_MS, BAD_REQUEST_SLEEP_MS, MAX_DB_FAILURES } from './loop';
import type { ClaimedRow, KeepaStore } from './store';
import { KeepaHttpError, KeepaTokenError, type KeepaBatchReply } from '@/lib/keepa/batchClient';

const NOW = new Date('2026-10-06T12:00:00Z');
const row = (asin: string, lane: ClaimedRow['lane'] = 'new'): ClaimedRow => ({ asin, tier: 1, lane, lastFetchedAt: null, consecutiveErrors: 0 });
const reply = (asins: string[], tokensLeft = 14_000): KeepaBatchReply => ({ products: asins.map((asin) => ({ asin, title: 'T', stats: { current: [1299] } })), tokensLeft, refillIn: 1000, refillRate: 250, tokensConsumed: asins.length * 2 });

function makeStore(claims: ClaimedRow[][]): KeepaStore & { calls: string[]; written: Array<{ status: string; asin: string }> } {
  const queue = [...claims];
  const calls: string[] = [];
  const written: Array<{ status: string; asin: string }> = [];
  return {
    calls,
    written,
    recordBoot: async () => { calls.push('recordBoot'); },
    releaseStaleClaims: async () => { calls.push('release'); return 0; },
    claimBatch: async () => { calls.push('claim'); return queue.shift() ?? []; },
    writeBatch: async ({ facts }) => { calls.push('write'); for (const f of facts.values()) written.push({ status: f.status, asin: f.asin }); },
    markBatchErrored: async ({ errorCode }) => { calls.push(`errored:${errorCode}`); },
    heartbeat: async () => { calls.push('heartbeat'); },
    recordError: async (code) => { calls.push(`recordError:${code}`); },
    markNewLaneDrained: async () => { calls.push('drained'); },
  };
}

function makeDeps(store: KeepaStore, fetchBatch: LoopDeps['keepa']['fetchBatch']): LoopDeps & { sleeps: number[]; logs: Record<string, unknown>[]; exit: ReturnType<typeof vi.fn> } {
  const sleeps: number[] = [];
  const logs: Record<string, unknown>[] = [];
  const exit = vi.fn();
  return {
    store,
    keepa: { fetchBatch, tokenStatus: async () => ({ tokensLeft: 15_000, refillRate: 250 }) },
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => NOW,
    log: (f) => { logs.push(f); },
    exit,
    bootId: 'boot-1',
    tailEnabled: false,
    sleeps,
    logs,
  };
}

describe('runIteration', () => {
  it('idles for a minute with a heartbeat when nothing is due', async () => {
    const store = makeStore([[]]);
    const deps = makeDeps(store, async () => reply([]));
    await expect(runIteration(deps, initialState())).resolves.toBe('idle');
    expect(store.calls).toEqual(['release', 'claim', 'heartbeat']);
    expect(deps.sleeps).toEqual([IDLE_SLEEP_MS]);
  });

  it('claims, fetches once, parses and writes a batch, then reports it', async () => {
    const store = makeStore([[row('B1'), row('B2', 'due')]]);
    const fetchBatch = vi.fn(async (asins: string[]) => reply(asins));
    const deps = makeDeps(store, fetchBatch);
    const state = initialState();
    await expect(runIteration(deps, state)).resolves.toBe('batch');
    expect(fetchBatch).toHaveBeenCalledWith(['B1', 'B2']);
    expect(store.written.map((w) => w.status)).toEqual(['active', 'active']);
    expect(state.tokensLeft).toBe(14_000);
    expect(deps.logs.at(-1)).toMatchObject({ event: 'batch', lane: 'new', requested: 2, active: 2, tokensLeft: 14_000 });
    expect(deps.sleeps).toEqual([]);
  });

  it('waits for tokens before fetching when the balance is short', async () => {
    const store = makeStore([[row('B1')]]);
    const deps = makeDeps(store, async (asins) => reply(asins));
    const state = { ...initialState(), tokensLeft: 1, refillRate: 250 };
    await runIteration(deps, state);
    expect(deps.sleeps).toEqual([240]);
  });

  it('a product missing from the reply is written as delisted', async () => {
    const store = makeStore([[row('B1'), row('B2')]]);
    const deps = makeDeps(store, async () => reply(['B1']));
    await runIteration(deps, initialState());
    expect(store.written).toEqual([{ status: 'active', asin: 'B1' }, { status: 'delisted', asin: 'B2' }]);
  });

  it('sleeps for Keepa\'s refill time on token exhaustion and retries the same batch', async () => {
    const store = makeStore([[row('B1')]]);
    const fetchBatch = vi.fn().mockRejectedValueOnce(new KeepaTokenError(31_000)).mockImplementation(async (asins: string[]) => reply(asins));
    const deps = makeDeps(store, fetchBatch);
    await expect(runIteration(deps, initialState())).resolves.toBe('batch');
    expect(deps.sleeps).toEqual([31_000]);
    expect(fetchBatch).toHaveBeenCalledTimes(2);
  });

  it('retries a Keepa outage three times then marks the batch errored and moves on', async () => {
    const store = makeStore([[row('B1')]]);
    const fetchBatch = vi.fn().mockRejectedValue(new KeepaHttpError(503));
    const deps = makeDeps(store, fetchBatch);
    await expect(runIteration(deps, initialState())).resolves.toBe('keepa_error');
    expect(fetchBatch).toHaveBeenCalledTimes(3);
    expect(deps.sleeps).toEqual([KEEPA_RETRY_SLEEP_MS, KEEPA_RETRY_SLEEP_MS]);
    expect(store.calls).toContain('errored:keepa_http_503');
  });

  it('a rejected request (4xx) is recorded, waited out ten minutes, and retried without counting as an attempt', async () => {
    const store = makeStore([[row('B1')]]);
    const fetchBatch = vi.fn().mockRejectedValueOnce(new KeepaHttpError(401)).mockImplementation(async (asins: string[]) => reply(asins));
    const deps = makeDeps(store, fetchBatch);
    await expect(runIteration(deps, initialState())).resolves.toBe('batch');
    expect(store.calls).toContain('recordError:keepa_http_401');
    expect(deps.sleeps).toEqual([BAD_REQUEST_SLEEP_MS]);
  });

  it('a database failure sleeps 30 s, counts, and exits the process at ten in a row', async () => {
    const store = makeStore([]);
    store.claimBatch = async () => { throw Object.assign(new Error('conn'), { code: '57P01' }); };
    const deps = makeDeps(store, async () => reply([]));
    const state = initialState();
    for (let i = 1; i < MAX_DB_FAILURES; i++) {
      await expect(runIteration(deps, state)).resolves.toBe('db_error');
      expect(deps.exit).not.toHaveBeenCalled();
    }
    await runIteration(deps, state);
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps.sleeps.every((s) => s === DB_RETRY_SLEEP_MS)).toBe(true);
    expect(JSON.stringify(deps.logs)).not.toContain('conn');
  });

  it('stamps the new lane drained exactly when a claim finds it empty right after a batch that drew from it', async () => {
    const store = makeStore([[row('B1', 'new')], [row('B2', 'due')], [row('B3', 'due')]]);
    const deps = makeDeps(store, async (asins) => reply(asins));
    const state = initialState();
    await runIteration(deps, state);
    await runIteration(deps, state);
    await runIteration(deps, state);
    expect(store.calls.filter((c) => c === 'drained')).toHaveLength(1);
    expect(store.calls.indexOf('drained')).toBeGreaterThan(store.calls.indexOf('write'));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run services/keepa/loop.test.ts`
Expected: FAIL — `Cannot find module './loop'`.

- [ ] **Step 3: Implement**

```ts
// services/keepa/loop.ts
/**
 * The Keepa service loop (spec 2026-10-05 §5.1, §5.3). One iteration = release stale claims,
 * claim up to a batch, wait for tokens, one Keepa request (with the retry policy), parse,
 * one write transaction. Fully injectable: the store, the Keepa calls, the clock, sleep and
 * exit are dependencies, so the policy is unit-tested without Postgres or Keepa.
 */
import { BATCH_SIZE, STALE_CLAIM_MS, TOKENS_PER_ASIN, msUntilTokens, type Lane } from '@/lib/keepa/lanes';
import { KeepaHttpError, KeepaTokenError, type KeepaBatchReply } from '@/lib/keepa/batchClient';
import { parseKeepaBatch } from '@/lib/keepa/parseProduct';
import type { ClaimedRow, KeepaStore } from './store';
import { errFields } from './log';

export const IDLE_SLEEP_MS = 60_000;
export const DB_RETRY_SLEEP_MS = 30_000;
export const KEEPA_RETRY_SLEEP_MS = 30_000;
export const KEEPA_RETRY_ATTEMPTS = 3;
export const BAD_REQUEST_SLEEP_MS = 10 * 60_000;
export const MAX_DB_FAILURES = 10;

export interface KeepaApi {
  fetchBatch(asins: string[]): Promise<KeepaBatchReply>;
  tokenStatus(): Promise<{ tokensLeft: number | null; refillRate: number | null }>;
}

export interface LoopDeps {
  store: KeepaStore;
  keepa: KeepaApi;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(fields: Record<string, unknown>): void;
  exit(code: number): void;
  bootId: string;
  tailEnabled: boolean;
  batchSize?: number;
  onBatch?(at: Date): void;
}

export interface LoopState {
  tokensLeft: number | null;
  refillRate: number | null;
  lastClaimHadNew: boolean;
  dbFailures: number;
}

export type IterationResult = 'batch' | 'idle' | 'keepa_error' | 'db_error';

export function initialState(): LoopState {
  return { tokensLeft: null, refillRate: null, lastClaimHadNew: false, dbFailures: 0 };
}

async function dbFailure(deps: LoopDeps, state: LoopState, stage: string, e: unknown): Promise<'db_error'> {
  state.dbFailures += 1;
  deps.log({ event: 'db_error', stage, failures: state.dbFailures, ...errFields(e) });
  if (state.dbFailures >= MAX_DB_FAILURES) {
    deps.log({ event: 'exit_db_failures', failures: state.dbFailures });
    deps.exit(1);
  }
  await deps.sleep(DB_RETRY_SLEEP_MS);
  return 'db_error';
}

export async function runIteration(deps: LoopDeps, state: LoopState): Promise<IterationResult> {
  let rows: ClaimedRow[];
  try {
    await deps.store.releaseStaleClaims(STALE_CLAIM_MS);
    rows = await deps.store.claimBatch({ limit: deps.batchSize ?? BATCH_SIZE, tailEnabled: deps.tailEnabled, bootId: deps.bootId });
  } catch (e) {
    return dbFailure(deps, state, 'claim', e);
  }

  // The never-fetched lane just drained: the signal the watcher turns into an explorer sync.
  const hasNew = rows.some((r) => r.lane === 'new');
  if (state.lastClaimHadNew && !hasNew) {
    try {
      await deps.store.markNewLaneDrained();
    } catch (e) {
      deps.log({ event: 'drained_stamp_failed', ...errFields(e) });
    }
  }
  state.lastClaimHadNew = hasNew;

  if (rows.length === 0) {
    try {
      await deps.store.heartbeat({ tokensLeft: state.tokensLeft, refillRate: state.refillRate });
    } catch (e) {
      return dbFailure(deps, state, 'heartbeat', e);
    }
    state.dbFailures = 0;
    await deps.sleep(IDLE_SLEEP_MS);
    return 'idle';
  }

  const wait = msUntilTokens(state.tokensLeft, state.refillRate, rows.length * TOKENS_PER_ASIN);
  if (wait > 0) await deps.sleep(wait);

  const asins = rows.map((r) => r.asin);
  const lane: Lane = rows[0].lane;
  let reply: KeepaBatchReply | null = null;
  let attempts = 0;
  let lastCode = 'keepa_unreachable';
  while (reply === null && attempts < KEEPA_RETRY_ATTEMPTS) {
    try {
      reply = await deps.keepa.fetchBatch(asins);
    } catch (e) {
      if (e instanceof KeepaTokenError) {
        // Not an attempt: Keepa told us exactly how long to wait.
        state.tokensLeft = 0;
        await deps.sleep(e.refillInMs);
        continue;
      }
      if (e instanceof KeepaHttpError && e.status >= 400 && e.status < 500) {
        // Rejected request (bad key, bad parameters): nothing to retry quickly. Record it so the
        // watcher alarms, wait ten minutes, try again — indefinitely, the rows stay claimed.
        try {
          await deps.store.recordError(`keepa_http_${e.status}`);
        } catch (dbErr) {
          deps.log({ event: 'record_error_failed', ...errFields(dbErr) });
        }
        deps.log({ event: 'keepa_rejected', status: e.status });
        await deps.sleep(BAD_REQUEST_SLEEP_MS);
        continue;
      }
      attempts += 1;
      lastCode = e instanceof KeepaHttpError ? `keepa_http_${e.status}` : e instanceof Error ? e.name : 'keepa_error';
      deps.log({ event: 'keepa_retry', attempt: attempts, ...errFields(e) });
      if (attempts < KEEPA_RETRY_ATTEMPTS) await deps.sleep(KEEPA_RETRY_SLEEP_MS);
    }
  }

  if (reply === null) {
    try {
      await deps.store.markBatchErrored({ rows, errorCode: lastCode, now: deps.now() });
    } catch (e) {
      return dbFailure(deps, state, 'mark_errored', e);
    }
    state.dbFailures = 0;
    deps.log({ event: 'batch_errored', lane, requested: rows.length, code: lastCode });
    return 'keepa_error';
  }

  state.tokensLeft = reply.tokensLeft;
  state.refillRate = reply.refillRate ?? state.refillRate;
  const facts = parseKeepaBatch(asins, reply.products);
  const now = deps.now();
  try {
    await deps.store.writeBatch({ rows, facts, lane, tokens: { tokensLeft: reply.tokensLeft, refillRate: reply.refillRate }, now });
  } catch (e) {
    return dbFailure(deps, state, 'write', e);
  }
  state.dbFailures = 0;
  deps.onBatch?.(now);
  const counts = { active: 0, no_price: 0, delisted: 0, error: 0 };
  for (const f of facts.values()) counts[f.status] += 1;
  deps.log({ event: 'batch', lane, requested: rows.length, ...counts, tokensLeft: reply.tokensLeft });
  return 'batch';
}

/** Never returns on its own; `deps.exit` ends the process after MAX_DB_FAILURES in a row. */
export async function runForever(deps: LoopDeps): Promise<void> {
  const state = initialState();
  try {
    const t = await deps.keepa.tokenStatus();
    state.tokensLeft = t.tokensLeft;
    state.refillRate = t.refillRate;
    deps.log({ event: 'token_status', ...t });
  } catch (e) {
    deps.log({ event: 'token_status_failed', ...errFields(e) });
  }
  for (;;) {
    await runIteration(deps, state);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run services/keepa/loop.test.ts`
Expected: PASS (9 tests). The token-wait test expects 240 ms: 1 token left, 2 needed, 1 short at 250/min = 240 ms.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec eslint services/keepa/loop.ts services/keepa/loop.test.ts
git add services/keepa/loop.ts services/keepa/loop.test.ts
git commit -m "feat(keepa-service): the loop — lane claims, token pacing, Keepa retry policy, never-exit-over-Keepa, exit after ten database failures, drained-lane stamp

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Boot, health endpoint, README, integration test

**Files:**
- Create: `services/keepa/index.ts`, `services/keepa/README.md`
- Create: `tests/integration/keepaService.test.ts` (runs only on the owner's go, after 0050 is applied)
- Read first: `worker/index.ts` (the health JSON shape it mirrors), `tests/integration/customCategories.test.ts` (gating pattern), spec §5.1 step 1, §9.

- [ ] **Step 1: Write the entry point**

```ts
// services/keepa/index.ts
/**
 * Keepa service entry point (spec 2026-10-05 §3.1, §5.1 step 1). Runs on its own Railway
 * service: `pnpm tsx services/keepa/index.ts`. Talks to Keepa and Neon only.
 *
 * Env: DATABASE_URL, KEEPA_API_KEY (required); KEEPA_TAIL_LANE=1 enables tier 2; PORT (Railway).
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fetchKeepaBatch, fetchTokenStatus } from '@/lib/keepa/batchClient';
import { createPool } from './db';
import { PgKeepaStore } from './pgStore';
import { runForever } from './loop';
import { errFields, logLine } from './log';

const BOOT_ID = randomUUID();
const BOOTED_AT = new Date();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const apiKey = process.env.KEEPA_API_KEY;
  const dbUrl = process.env.DATABASE_URL;
  if (!apiKey || !dbUrl) {
    console.error('[keepa-svc] KEEPA_API_KEY and DATABASE_URL are required');
    process.exit(1);
  }
  const tailEnabled = process.env.KEEPA_TAIL_LANE === '1';
  const port = parseInt(process.env.PORT || '8080', 10);
  const live = { lastBatchAt: null as Date | null };

  createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      service: 'keepa-service',
      bootId: BOOT_ID,
      bootedAt: BOOTED_AT.toISOString(),
      uptimeSec: Math.round(process.uptime()),
      lastBatchAt: live.lastBatchAt?.toISOString() ?? null,
      tailEnabled,
    }));
  }).listen(port, () => logLine({ event: 'listening', port, bootId: BOOT_ID, tailEnabled }));

  const store = new PgKeepaStore(createPool(dbUrl));
  await store.recordBoot(BOOT_ID, tailEnabled);
  await runForever({
    store,
    keepa: {
      fetchBatch: (asins) => fetchKeepaBatch(asins, { apiKey }),
      tokenStatus: () => fetchTokenStatus({ apiKey }),
    },
    sleep,
    now: () => new Date(),
    log: logLine,
    exit: (code) => process.exit(code),
    bootId: BOOT_ID,
    tailEnabled,
    onBatch: (at) => {
      live.lastBatchAt = at;
    },
  });
}

main().catch((e) => {
  // A boot-time failure (database unreachable, status row missing) exits non-zero so Railway
  // restarts the service with a fresh pool.
  logLine({ event: 'boot_failed', ...errFields(e) });
  process.exit(1);
});
```

- [ ] **Step 2: Write the README**

```markdown
# Keepa service

Always-on enrichment loop (spec `docs/superpowers/specs/2026-10-05-keepa-service-design.md`). Runs as its own Railway service from this repo; talks only to Keepa and Neon.

## Railway settings (dashboard — Config as Code is deprecated for new services)

| Setting | Value |
|---|---|
| Custom Build Command | `echo "no build - tsx runs the source"` |
| Custom Start Command | `pnpm tsx services/keepa/index.ts` |
| Healthcheck Path | `/` |
| Restart Policy | On Failure, max retries 10 |
| Watch Paths | `/services/keepa/**`, `/lib/keepa/**`, `/package.json`, `/pnpm-lock.yaml` |
| App Sleeping | off |

Variables: `DATABASE_URL` (the worker's value), `KEEPA_API_KEY`; `KEEPA_TAIL_LANE=1` turns on the tier-2 lane. Set by the owner in the dashboard; never in the repo.

## What it does

Every iteration: release claims older than ten minutes → claim up to 100 due ASINs lane by lane (tier-1 never-fetched by rank, tier-1 due oldest first, tier 2 only with the tail on) → wait for tokens → one Keepa request (`rating=1&stats=90`, no history) → parse/validate → one transaction (catalog upsert, snapshots, claims cleared, status row). Nothing due: heartbeat and a 60-second nap.

Status lives in `keepa_service_status`; the admin page `/admin/keepa-enrichment` shows it; the main worker's watcher cron emails on a stale heartbeat or a stall and fires the explorer aggregate sync.

Logs: one JSON line per batch under `[keepa-svc]`, coded errors only.
```

- [ ] **Step 3: Write the integration test (owner's go only)**

```ts
// tests/integration/keepaService.test.ts
/**
 * Keepa service store against the real tables (migration 0050 applied). Synthetic ASINs
 * prefixed TESTKS are inserted and removed by this file; no real row is touched.
 *
 * Run (owner's go): RUN_INTEGRATION=1 pnpm test:integration tests/integration/keepaService.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgKeepaStore } from '@/services/keepa/pgStore';
import { emptyFacts, type ProductFacts } from '@/lib/keepa/productFacts';

const RUN = !!process.env.RUN_INTEGRATION;
const PREFIX = 'TESTKS';
const A = { newTop: `${PREFIX}0001`, newDeep: `${PREFIX}0002`, due: `${PREFIX}0003`, notDue: `${PREFIX}0004`, tier2: `${PREFIX}0005` };

describe.skipIf(!RUN)('Keepa service store (integration)', () => {
  let pool: Pool;
  let store: PgKeepaStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    store = new PgKeepaStore(pool);
    await pool.query(`DELETE FROM asin_snapshots WHERE asin LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM asin_products WHERE asin LIKE $1`, [`${PREFIX}%`]);
    await pool.query(
      `INSERT INTO asin_products (asin, best_rank, tier, in_scope, last_fetched_at, next_due_at, enrichment_status, title) VALUES
       ($1, 500, 1, true, NULL, now(), NULL, NULL),
       ($2, 900000, 1, true, NULL, now(), NULL, NULL),
       ($3, 1000, 1, true, now() - interval '8 days', now() - interval '1 day', 'active', 'old title'),
       ($4, 1000, 1, true, now() - interval '1 day', now() + interval '6 days', 'active', 'fresh'),
       ($5, 1500000, 2, true, NULL, now(), NULL, NULL)`,
      [A.newTop, A.newDeep, A.due, A.notDue, A.tier2],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM asin_snapshots WHERE asin LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM asin_products WHERE asin LIKE $1`, [`${PREFIX}%`]);
    await pool.end();
  });

  it('claims never-fetched tier 1 by rank, then due tier 1, skips not-due and tier 2 with the tail off', async () => {
    // Other rows in the real table may be claimable too, so assert on our rows only.
    const rows = await store.claimBatch({ limit: 100, tailEnabled: false, bootId: 'test-boot' });
    const ours = rows.filter((r) => r.asin.startsWith(PREFIX));
    const asins = ours.map((r) => r.asin);
    expect(asins).not.toContain(A.notDue);
    expect(asins).not.toContain(A.tier2);
    const { rows: claimed } = await pool.query<{ asin: string; claimed_by: string }>(`SELECT asin, claimed_by FROM asin_products WHERE asin LIKE $1 AND claimed_at IS NOT NULL`, [`${PREFIX}%`]);
    for (const c of claimed) expect(c.claimed_by).toBe('test-boot');
    // Release everything this test claimed (our rows and any real rows), as a crashed service would after ten minutes.
    await pool.query(`UPDATE asin_products SET claimed_at = NULL, claimed_by = NULL WHERE claimed_by = 'test-boot'`);
    if (asins.includes(A.newTop) && asins.includes(A.newDeep)) expect(asins.indexOf(A.newTop)).toBeLessThan(asins.indexOf(A.newDeep));
  });

  it('writeBatch applies the three outcomes and inserts snapshots', async () => {
    const now = new Date();
    const active: ProductFacts = { ...emptyFacts(A.newTop, 'delisted'), status: 'active', title: 'New title', currentPriceCents: 1999, priceSource: 'amazon', salesRank: 42, reviewCount: 7, monthlySold: 100 };
    const rows = [
      { asin: A.newTop, tier: 1 as const, lane: 'new' as const, lastFetchedAt: null, consecutiveErrors: 0 },
      { asin: A.due, tier: 1 as const, lane: 'due' as const, lastFetchedAt: new Date(), consecutiveErrors: 0 },
      { asin: A.newDeep, tier: 1 as const, lane: 'new' as const, lastFetchedAt: null, consecutiveErrors: 0 },
    ];
    const facts = new Map<string, ProductFacts>([[A.newTop, active], [A.due, emptyFacts(A.due, 'delisted')], [A.newDeep, emptyFacts(A.newDeep, 'error', 'bad_object')]]);
    await store.writeBatch({ rows, facts, lane: 'new', tokens: { tokensLeft: 123, refillRate: 250 }, now });

    const { rows: r } = await pool.query(`SELECT asin, enrichment_status::text AS s, title, monthly_sold, fetch_count, consecutive_errors, error_code, next_due_at, last_fetched_at FROM asin_products WHERE asin = ANY($1) ORDER BY asin`, [[A.newTop, A.due, A.newDeep]]);
    const by = Object.fromEntries(r.map((x) => [x.asin, x]));
    expect(by[A.newTop]).toMatchObject({ s: 'active', title: 'New title', monthly_sold: 100, fetch_count: 1, consecutive_errors: 0 });
    expect(by[A.due]).toMatchObject({ s: 'delisted', title: 'old title', fetch_count: 1 });
    expect(by[A.newDeep]).toMatchObject({ s: 'error', error_code: 'bad_object', consecutive_errors: 1, fetch_count: 0, last_fetched_at: null });
    expect(new Date(by[A.newTop].next_due_at).getTime() - now.getTime()).toBeCloseTo(7 * 86_400_000, -4);

    const { rows: snaps } = await pool.query(`SELECT asin, enrichment_status::text AS s, review_count FROM asin_snapshots WHERE asin = ANY($1) ORDER BY asin`, [[A.newTop, A.due, A.newDeep]]);
    expect(snaps.map((s) => s.s).sort()).toEqual(['active', 'delisted', 'error']);
    expect(snaps.find((s) => s.asin === A.newTop)?.review_count).toBe(7);
    const { rows: st } = await pool.query(`SELECT tokens_left, last_batch_lane FROM keepa_service_status WHERE singleton`);
    expect(st[0]).toMatchObject({ tokens_left: 123, last_batch_lane: 'new' });
  });

  it('releaseStaleClaims only touches claims older than the threshold', async () => {
    await pool.query(`UPDATE asin_products SET claimed_at = now() - interval '11 minutes', claimed_by = 'dead-boot' WHERE asin = $1`, [A.notDue]);
    await pool.query(`UPDATE asin_products SET claimed_at = now(), claimed_by = 'live-boot' WHERE asin = $1`, [A.tier2]);
    await store.releaseStaleClaims(10 * 60_000);
    const { rows } = await pool.query<{ asin: string; claimed_by: string | null }>(`SELECT asin, claimed_by FROM asin_products WHERE asin IN ($1, $2)`, [A.notDue, A.tier2]);
    expect(rows.find((r) => r.asin === A.notDue)?.claimed_by).toBeNull();
    expect(rows.find((r) => r.asin === A.tier2)?.claimed_by).toBe('live-boot');
    await pool.query(`UPDATE asin_products SET claimed_at = NULL, claimed_by = NULL WHERE asin = $1`, [A.tier2]);
  });
});
```

- [ ] **Step 4: Typecheck, unit tests, lint**

Run: `pnpm typecheck && pnpm vitest run services/keepa lib/keepa && pnpm exec eslint services/keepa tests/integration/keepaService.test.ts`
Expected: clean; the integration file is skipped without `RUN_INTEGRATION`.

- [ ] **Step 5: Commit**

```bash
git add services/keepa/index.ts services/keepa/README.md tests/integration/keepaService.test.ts
git commit -m "feat(keepa-service): entry point with health endpoint and boot sequence, README with the Railway dashboard settings, store integration test (owner-gated)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Admin status card

**Files:**
- Create: `lib/keepa/adminOverview.ts`
- Create: `app/admin/keepa-enrichment/ServiceStatusCard.tsx`
- Test: `app/admin/keepa-enrichment/ServiceStatusCard.test.tsx`
- Modify: `app/admin/keepa-enrichment/page.tsx` (add the card under the intro paragraphs), `app/admin/keepa-enrichment/page.test.tsx` (mock the overview loader)
- Read first: `node_modules/next/dist/docs/` on server components and `force-dynamic` (the page is already a dynamic server component; the card is a plain server component with props), spec §8.

- [ ] **Step 1: Write the failing card test**

```tsx
// app/admin/keepa-enrichment/ServiceStatusCard.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ServiceStatusCard, ageLabel } from './ServiceStatusCard';
import type { KeepaServiceOverview } from '@/lib/keepa/adminOverview';

const NOW = new Date('2026-10-06T12:00:00Z');
const overview: KeepaServiceOverview = {
  status: {
    bootId: 'abcdef12-0000', bootedAt: new Date('2026-10-06T08:00:00Z'), heartbeatAt: new Date('2026-10-06T11:57:30Z'),
    lastBatchAt: new Date('2026-10-06T11:57:00Z'), lastBatchLane: 'new', tokensLeft: 180, refillRate: 250, tailEnabled: false,
    lastErrorCode: null, lastErrorAt: null, laneNewDrainedAt: null, syncFiredAt: null,
  },
  counts: {
    tier1InScope: 1_003_344, tier1NeverFetched: 715_083, tier1Due: 12, tier2InScope: 1_307_312, tier2NeverFetched: 1_239_033, tier2Due: 0,
    fetchedLast24h: 160_000, fetchedLast7d: 900_000, oldestTier1FetchedAt: new Date('2026-10-03T09:39:00Z'), claimed: 100,
  },
};

describe('ServiceStatusCard', () => {
  it('shows heartbeat age, lane counts, oldest tier-1 age, tokens and unused capacity', () => {
    render(<ServiceStatusCard overview={overview} now={NOW} />);
    expect(screen.getByRole('heading', { name: 'Keepa service' })).toBeInTheDocument();
    expect(screen.getByText('2 min ago')).toBeInTheDocument(); // heartbeat
    expect(screen.getByText('715,083')).toBeInTheDocument(); // tier-1 never fetched
    expect(screen.getByText('3 days')).toBeInTheDocument(); // oldest tier-1 fetch age
    expect(screen.getByText('180 / 250 per min')).toBeInTheDocument();
    expect(screen.getByText('360,000 of 1,260,000 (29%)')).toBeInTheDocument(); // unused capacity, 7 days
    expect(screen.getByText('off')).toBeInTheDocument(); // tail lane
  });

  it('says the service has never reported when the status row is empty', () => {
    render(<ServiceStatusCard overview={{ status: null, counts: overview.counts }} now={NOW} />);
    expect(screen.getAllByText('never').length).toBeGreaterThanOrEqual(3);
  });
});

describe('ageLabel', () => {
  it('renders minutes, hours and days, and "never" for null', () => {
    expect(ageLabel(null, NOW)).toBe('never');
    expect(ageLabel(new Date('2026-10-06T11:59:40Z'), NOW)).toBe('just now');
    expect(ageLabel(new Date('2026-10-06T11:58:30Z'), NOW)).toBe('1 min ago');
    expect(ageLabel(new Date('2026-10-06T11:57:30Z'), NOW)).toBe('2 min ago');
    expect(ageLabel(new Date('2026-10-06T09:00:00Z'), NOW)).toBe('3 h ago');
    expect(ageLabel(new Date('2026-10-03T09:39:00Z'), NOW)).toBe('3 days');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run app/admin/keepa-enrichment/ServiceStatusCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the loader and the card**

```ts
// lib/keepa/adminOverview.ts
/**
 * Data for the admin status card (spec 2026-10-05 §8): the service's status row plus one
 * aggregate pass over asin_products. Admin-only; a few seconds on 2.3M rows is acceptable.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

export const DAILY_CAPACITY_ASINS = 180_000;
export const WEEKLY_CAPACITY_ASINS = 7 * DAILY_CAPACITY_ASINS;

export interface KeepaServiceStatusView {
  bootId: string | null;
  bootedAt: Date | null;
  heartbeatAt: Date | null;
  lastBatchAt: Date | null;
  lastBatchLane: string | null;
  tokensLeft: number | null;
  refillRate: number | null;
  tailEnabled: boolean;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  laneNewDrainedAt: Date | null;
  syncFiredAt: Date | null;
}

export interface KeepaQueueCounts {
  tier1InScope: number;
  tier1NeverFetched: number;
  tier1Due: number;
  tier2InScope: number;
  tier2NeverFetched: number;
  tier2Due: number;
  fetchedLast24h: number;
  fetchedLast7d: number;
  oldestTier1FetchedAt: Date | null;
  claimed: number;
}

export interface KeepaServiceOverview {
  status: KeepaServiceStatusView | null;
  counts: KeepaQueueCounts;
}

function ts(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string') return new Date(v);
  return null;
}

export async function loadKeepaServiceOverview(): Promise<KeepaServiceOverview> {
  const statusRes = await db.execute<Record<string, unknown>>(sql`
    SELECT boot_id, booted_at, heartbeat_at, last_batch_at, last_batch_lane, tokens_left, refill_rate, tail_enabled,
           last_error_code, last_error_at, lane_new_drained_at, sync_fired_at
    FROM keepa_service_status WHERE singleton`);
  const s = statusRes.rows[0];
  const status: KeepaServiceStatusView | null = s
    ? {
        bootId: (s.boot_id as string | null) ?? null,
        bootedAt: ts(s.booted_at),
        heartbeatAt: ts(s.heartbeat_at),
        lastBatchAt: ts(s.last_batch_at),
        lastBatchLane: (s.last_batch_lane as string | null) ?? null,
        tokensLeft: (s.tokens_left as number | null) ?? null,
        refillRate: (s.refill_rate as number | null) ?? null,
        tailEnabled: Boolean(s.tail_enabled),
        lastErrorCode: (s.last_error_code as string | null) ?? null,
        lastErrorAt: ts(s.last_error_at),
        laneNewDrainedAt: ts(s.lane_new_drained_at),
        syncFiredAt: ts(s.sync_fired_at),
      }
    : null;

  const countsRes = await db.execute<Record<string, unknown>>(sql`
    SELECT
      COUNT(*) FILTER (WHERE in_scope AND tier = 1)::int AS tier1_in_scope,
      COUNT(*) FILTER (WHERE in_scope AND tier = 1 AND last_fetched_at IS NULL)::int AS tier1_never_fetched,
      COUNT(*) FILTER (WHERE in_scope AND tier = 1 AND last_fetched_at IS NOT NULL AND next_due_at <= now())::int AS tier1_due,
      COUNT(*) FILTER (WHERE in_scope AND tier = 2)::int AS tier2_in_scope,
      COUNT(*) FILTER (WHERE in_scope AND tier = 2 AND last_fetched_at IS NULL)::int AS tier2_never_fetched,
      COUNT(*) FILTER (WHERE in_scope AND tier = 2 AND last_fetched_at IS NOT NULL AND next_due_at <= now())::int AS tier2_due,
      COUNT(*) FILTER (WHERE last_fetched_at > now() - interval '24 hours')::int AS fetched_last_24h,
      COUNT(*) FILTER (WHERE last_fetched_at > now() - interval '7 days')::int AS fetched_last_7d,
      MIN(last_fetched_at) FILTER (WHERE in_scope AND tier = 1) AS oldest_tier1_fetched_at,
      COUNT(*) FILTER (WHERE claimed_at IS NOT NULL)::int AS claimed
    FROM asin_products`);
  const c = countsRes.rows[0] ?? {};
  const n = (k: string) => Number(c[k] ?? 0);
  return {
    status,
    counts: {
      tier1InScope: n('tier1_in_scope'),
      tier1NeverFetched: n('tier1_never_fetched'),
      tier1Due: n('tier1_due'),
      tier2InScope: n('tier2_in_scope'),
      tier2NeverFetched: n('tier2_never_fetched'),
      tier2Due: n('tier2_due'),
      fetchedLast24h: n('fetched_last_24h'),
      fetchedLast7d: n('fetched_last_7d'),
      oldestTier1FetchedAt: ts(c.oldest_tier1_fetched_at),
      claimed: n('claimed'),
    },
  };
}
```

```tsx
// app/admin/keepa-enrichment/ServiceStatusCard.tsx
import type { KeepaServiceOverview } from '@/lib/keepa/adminOverview';
import { WEEKLY_CAPACITY_ASINS } from '@/lib/keepa/adminOverview';

/** "just now" / "N min ago" / "N h ago" / "N days" / "never". Days are shown without "ago" (an age, not an event). */
export function ageLabel(at: Date | null, now: Date): string {
  if (!at) return 'never';
  const ms = now.getTime() - at.getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} days`;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function ServiceStatusCard({ overview, now }: { overview: KeepaServiceOverview; now: Date }) {
  const { status, counts } = overview;
  const unused = Math.max(0, WEEKLY_CAPACITY_ASINS - counts.fetchedLast7d);
  const unusedPct = Math.round((unused / WEEKLY_CAPACITY_ASINS) * 100);
  const rows: Array<[string, string]> = [
    ['Heartbeat', ageLabel(status?.heartbeatAt ?? null, now)],
    ['Booted', ageLabel(status?.bootedAt ?? null, now)],
    ['Last batch', `${ageLabel(status?.lastBatchAt ?? null, now)}${status?.lastBatchLane ? ` (${status.lastBatchLane} lane)` : ''}`],
    ['Tail lane', status?.tailEnabled ? 'on' : 'off'],
    ['Tier 1 in scope', fmt(counts.tier1InScope)],
    ['Tier 1 never fetched', fmt(counts.tier1NeverFetched)],
    ['Tier 1 due for refresh', fmt(counts.tier1Due)],
    ['Oldest tier-1 fetch', ageLabel(counts.oldestTier1FetchedAt, now)],
    ['Tier 2 in scope / never fetched', `${fmt(counts.tier2InScope)} / ${fmt(counts.tier2NeverFetched)}`],
    ['Fetched last 24 h', fmt(counts.fetchedLast24h)],
    ['Unused capacity, 7 days', `${fmt(unused)} of ${fmt(WEEKLY_CAPACITY_ASINS)} (${unusedPct}%)`],
    ['Tokens', status?.tokensLeft !== null && status?.tokensLeft !== undefined ? `${fmt(status.tokensLeft)} / ${fmt(status.refillRate ?? 0)} per min` : 'unknown'],
    ['Claimed right now', fmt(counts.claimed)],
    ['Last error', status?.lastErrorCode ? `${status.lastErrorCode} (${ageLabel(status.lastErrorAt, now)})` : 'none'],
    ['Explorer sync last fired', ageLabel(status?.syncFiredAt ?? null, now)],
  ];
  return (
    <section aria-labelledby="keepa-service-heading" className="mt-6 rounded border border-slate-200 bg-slate-50 p-4">
      <h2 id="keepa-service-heading" className="text-sm font-semibold text-slate-900">Keepa service</h2>
      <p className="mt-1 text-xs text-slate-600">
        Always-on enrichment on its own Railway service. Target: oldest tier-1 fetch no older than 8 days.
      </p>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1">
            <dt className="text-slate-600">{k}</dt>
            <dd className="text-right font-medium tabular-nums text-slate-900">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
```

- [ ] **Step 4: Run the card test**

Run: `pnpm vitest run app/admin/keepa-enrichment/ServiceStatusCard.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the page and update its test**

In `app/admin/keepa-enrichment/page.tsx`: add the imports

```ts
import { loadKeepaServiceOverview } from '@/lib/keepa/adminOverview';
import { ServiceStatusCard } from './ServiceStatusCard';
```

after the `recentRuns` query add `const overview = await loadKeepaServiceOverview();`, and render `<ServiceStatusCard overview={overview} now={new Date()} />` right after the second intro `<p>` (before the amber "Manual full refresh" box).

In `page.test.tsx`, add after the `@/db/client` mock:

```ts
const overviewMock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/keepa/adminOverview', () => ({ loadKeepaServiceOverview: overviewMock.load, WEEKLY_CAPACITY_ASINS: 1_260_000 }));
```

in `beforeEach`: `overviewMock.load.mockResolvedValue({ status: null, counts: { tier1InScope: 0, tier1NeverFetched: 0, tier1Due: 0, tier2InScope: 0, tier2NeverFetched: 0, tier2Due: 0, fetchedLast24h: 0, fetchedLast7d: 0, oldestTier1FetchedAt: null, claimed: 0 } });`

in the redirect test add `expect(overviewMock.load).not.toHaveBeenCalled();` after each `expect(dbm.select).not.toHaveBeenCalled();`, and in the admin test add `expect(screen.getByRole('heading', { name: 'Keepa service' })).toBeInTheDocument();`.

Run: `pnpm vitest run app/admin/keepa-enrichment`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck
pnpm exec eslint lib/keepa/adminOverview.ts app/admin/keepa-enrichment
git add lib/keepa/adminOverview.ts app/admin/keepa-enrichment/ServiceStatusCard.tsx app/admin/keepa-enrichment/ServiceStatusCard.test.tsx app/admin/keepa-enrichment/page.tsx app/admin/keepa-enrichment/page.test.tsx
git commit -m "feat(admin): Keepa service status card — heartbeat, lanes, oldest tier-1 age, tokens, unused weekly capacity, last error

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Enqueue-week hook in the import + manual script

**Files:**
- Modify: `inngest/functions/importFile.ts` (after the `mark_imported` phase, before "Phase 5: refresh keyword_current_summary")
- Create: `scripts/fireEnqueueWeek.ts` (tracked, like `scripts/fireEnrichWeek.ts`)
- Read first: `inngest/functions/importFile.ts` lines 960–1062 (phases, `timePhase`, `isReplay`, `weekEndDate` from line 626), `lib/ask/logSafe.ts` (`errFields`).

The hook lands now, in phase 1, beside the old enrichment event (which Task 13 removes): during the shadow week both paths see each new week, so the hand-off is exercised before the old path goes.

- [ ] **Step 1: Add the hook**

Add to the imports at the top of `importFile.ts`:

```ts
import { enqueueWeek, EnqueueWeekError } from '@/lib/keepa/enqueueWeek';
import { errFields } from '@/lib/ask/logSafe';
```

Insert immediately after the `await timePhase(file.id, 'mark_imported', …)` block and before the `// Phase 5` comment:

```ts
    // ------------------------------------------------------------------
    // Keepa service hand-off (spec 2026-10-05 §6.1): enqueue this week's
    // top-3 ASINs for the always-on Keepa service BEFORE the long summary
    // refresh so its never-fetched lane starts at once. Fail-soft: a failure
    // here never fails the import — the service keeps working on the previous
    // scope and scripts/fireEnqueueWeek.ts re-runs the hook by hand. Replay
    // runs skip it: a historical week must not reshape the live scope.
    // ------------------------------------------------------------------
    if (!isReplay) {
      await timePhase(file.id, 'keepa_enqueue', async () => {
        const enqueuePool = new Pool({ connectionString: env.DATABASE_URL, max: 1, statement_timeout: 1_800_000 });
        try {
          const client = await enqueuePool.connect();
          try {
            const r = await enqueueWeek(client, weekEndDate);
            console.log(`[keepa-enqueue] week ${weekEndDate}: inserted=${r.inserted} updated=${r.updated} retired=${r.retired} vacuumed=${r.vacuumed}`);
          } finally {
            client.release();
          }
        } catch (e) {
          if (e instanceof EnqueueWeekError && e.code === 'enqueue_week_older_than_scope') {
            // A late re-import of an older week: the catalog keeps the newer scope. Expected, not a failure.
            console.log(`[keepa-enqueue] skipped: ${e.code} (week ${weekEndDate})`);
          } else {
            const { error, code } = errFields(e);
            console.error('[keepa-enqueue] failed (import continues)', JSON.stringify({ week: weekEndDate, error, code }));
          }
        } finally {
          await enqueuePool.end();
        }
      });
    }
```

Check `timePhase`'s signature at line 142: it takes `(fileId, phase: string, fn)` and records the phase name in `import_phase_timings` / `import_phase` (a free-text column, `db/schema/uploads.ts` line 116), so the new phase name needs no schema change. If `timePhase` constrains the phase to a union type, add `'keepa_enqueue'` to that union in the same edit.

- [ ] **Step 2: Write the script**

```ts
// scripts/fireEnqueueWeek.ts
/**
 * Re-run the Keepa service's enqueue-week hook by hand (spec 2026-10-05 §6.1) — e.g. after the
 * import's own hook logged a failure. Idempotent upsert.
 *
 * Run: FIRE_ENQUEUE_WEEK=2026-10-03 node --env-file=.env.local --import tsx scripts/fireEnqueueWeek.ts
 * Add FIRE_ENQUEUE_FORCE=1 to enqueue a week older than the catalog's scope week (never needed for a normal import).
 */
import { Pool } from 'pg';
import { enqueueWeek } from '@/lib/keepa/enqueueWeek';

const week = process.env.FIRE_ENQUEUE_WEEK;
if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
  console.error('Refusing to run: set FIRE_ENQUEUE_WEEK=YYYY-MM-DD (the kwm week_end_date to enqueue).');
  process.exit(1);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, statement_timeout: 1_800_000 });
  const client = await pool.connect();
  try {
    const r = await enqueueWeek(client, week, { force: process.env.FIRE_ENQUEUE_FORCE === '1' });
    console.log(`enqueued week ${week}: inserted=${r.inserted} updated=${r.updated} retired=${r.retired} vacuumed=${r.vacuumed}`);
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('failed:', e instanceof Error ? e.name : 'unknown', (e as { code?: string })?.code ?? '');
  process.exit(1);
});
```

- [ ] **Step 3: Typecheck, lint, run the import-related unit tests**

Run: `pnpm typecheck && pnpm exec eslint inngest/functions/importFile.ts scripts/fireEnqueueWeek.ts && pnpm vitest run inngest`
Expected: clean; existing import tests still pass (the hook is inside the non-replay path and fail-soft).

- [ ] **Step 4: Commit**

```bash
git add inngest/functions/importFile.ts scripts/fireEnqueueWeek.ts
git commit -m "feat(import): hand each new week's top-3 ASINs to the Keepa service before the summary refresh (fail-soft), plus a manual re-run script

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Watcher — rules, alarm emails, cron

**Files:**
- Create: `lib/keepa/watcherRules.ts`, test `lib/keepa/watcherRules.test.ts`
- Create: `lib/keepa/readSource.ts`, test `lib/keepa/readSource.test.ts` (the watcher needs the flag; Task 12 reuses it)
- Create: `lib/notifications/buildKeepaServiceAlarmEmail.ts` (+test), `lib/notifications/sendKeepaServiceAlarmEmail.ts` (+test)
- Create: `inngest/functions/keepaServiceWatcher.ts`
- Modify: `inngest/functions/index.ts` (import + register)
- Read first: `inngest/functions/warmExplorerLanding.ts` (cron shape), `lib/notifications/sendEnrichmentEmail.ts` + its test (sender pattern and log-safety tests), spec §6.2.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/keepa/readSource.test.ts
import { describe, it, expect } from 'vitest';
import { keepaReadSource } from './readSource';

describe('keepaReadSource', () => {
  it('defaults to the per-week table and switches only on the exact value', () => {
    expect(keepaReadSource({})).toBe('weekly');
    expect(keepaReadSource({ KEEPA_READ_SOURCE: 'products' })).toBe('products');
    expect(keepaReadSource({ KEEPA_READ_SOURCE: 'Products' })).toBe('weekly');
    expect(keepaReadSource({ KEEPA_READ_SOURCE: '' })).toBe('weekly');
  });
});
```

```ts
// lib/keepa/watcherRules.test.ts
import { describe, it, expect } from 'vitest';
import { decideWatcherActions, easternClock, type WatcherInput } from './watcherRules';

const NOW = new Date('2026-10-06T12:00:00Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const base: WatcherInput = {
  now: NOW,
  heartbeatAt: min(1),
  lastBatchAt: min(2),
  dueWorkExists: true,
  laneNewDrainedAt: null,
  syncFiredAt: null,
  nightlySyncDate: null,
  downAlarmSentAt: null,
  stallAlarmSentAt: null,
  readSource: 'products',
  et: { hour: 8, minute: 0, dateKey: '2026-10-06' },
};

describe('decideWatcherActions', () => {
  it('does nothing while the service is healthy', () => {
    expect(decideWatcherActions(base)).toEqual([]);
  });

  it('alarms once when the heartbeat is older than ten minutes, then recovers once', () => {
    const down = decideWatcherActions({ ...base, heartbeatAt: min(11) });
    expect(down).toEqual([{ kind: 'email', variant: 'down' }, { kind: 'stamp', field: 'down_alarm_sent_at', value: NOW }]);
    expect(decideWatcherActions({ ...base, heartbeatAt: min(30), downAlarmSentAt: min(19) })).toEqual([]);
    expect(decideWatcherActions({ ...base, downAlarmSentAt: min(19) })).toEqual([
      { kind: 'email', variant: 'recovered' },
      { kind: 'stamp', field: 'down_alarm_sent_at', value: null },
    ]);
  });

  it('a missing heartbeat counts as down', () => {
    expect(decideWatcherActions({ ...base, heartbeatAt: null })[0]).toEqual({ kind: 'email', variant: 'down' });
  });

  it('alarms on a stall: alive, work due, no batch for two hours — never while down, never without due work', () => {
    expect(decideWatcherActions({ ...base, lastBatchAt: min(121) })).toEqual([{ kind: 'email', variant: 'stalled' }, { kind: 'stamp', field: 'stall_alarm_sent_at', value: NOW }]);
    expect(decideWatcherActions({ ...base, lastBatchAt: min(121), dueWorkExists: false })).toEqual([]);
    expect(decideWatcherActions({ ...base, lastBatchAt: min(121), heartbeatAt: min(11) }).map((a) => a.kind === 'email' && a.variant)).toEqual(['down', false]);
    expect(decideWatcherActions({ ...base, stallAlarmSentAt: min(60) })).toEqual([
      { kind: 'email', variant: 'recovered' },
      { kind: 'stamp', field: 'stall_alarm_sent_at', value: null },
    ]);
  });

  it('fires the explorer sync once per drained new lane, only when the app reads the catalog', () => {
    const drained = { ...base, laneNewDrainedAt: min(3) };
    expect(decideWatcherActions(drained)).toEqual([{ kind: 'sync', reason: 'new_lane_drained' }, { kind: 'stamp', field: 'sync_fired_at', value: NOW }]);
    expect(decideWatcherActions({ ...drained, syncFiredAt: min(2) })).toEqual([]);
    expect(decideWatcherActions({ ...drained, readSource: 'weekly' })).toEqual([]);
  });

  it('fires the nightly sync in the 03:30–03:44 ET window once per date when something was fetched today', () => {
    const night = { ...base, et: { hour: 3, minute: 31, dateKey: '2026-10-06' } };
    expect(decideWatcherActions(night)).toEqual([
      { kind: 'sync', reason: 'nightly' },
      { kind: 'stamp', field: 'nightly_sync_date', value: '2026-10-06' },
      { kind: 'stamp', field: 'sync_fired_at', value: NOW },
    ]);
    expect(decideWatcherActions({ ...night, nightlySyncDate: '2026-10-06' })).toEqual([]);
    expect(decideWatcherActions({ ...night, et: { ...night.et, minute: 45 } })).toEqual([]);
    expect(decideWatcherActions({ ...night, lastBatchAt: min(25 * 60) })).toEqual([]);
  });
});

describe('easternClock', () => {
  it('converts UTC to America/New_York fields', () => {
    expect(easternClock(new Date('2026-10-06T07:31:00Z'))).toEqual({ hour: 3, minute: 31, dateKey: '2026-10-06' });
    expect(easternClock(new Date('2026-10-06T03:10:00Z'))).toEqual({ hour: 23, minute: 10, dateKey: '2026-10-05' });
  });
});
```

```ts
// lib/notifications/buildKeepaServiceAlarmEmail.test.ts
import { describe, it, expect } from 'vitest';
import { buildKeepaServiceAlarmEmail } from './buildKeepaServiceAlarmEmail';

const NOW = new Date('2026-10-06T12:00:00Z');
const input = { heartbeatAt: new Date('2026-10-06T11:40:00Z'), lastBatchAt: new Date('2026-10-06T09:00:00Z'), appUrl: 'https://keywordquarry.com', now: NOW };

describe('buildKeepaServiceAlarmEmail', () => {
  it('down: names the subject, the heartbeat age and the admin link', () => {
    const e = buildKeepaServiceAlarmEmail({ variant: 'down', ...input });
    expect(e.subject).toBe('Keepa service down');
    expect(e.text).toContain('20 min ago');
    expect(e.text).toContain('https://keywordquarry.com/admin/keepa-enrichment');
    expect(e.html).toContain('Railway');
  });
  it('stalled: says the service is alive but idle with work due', () => {
    const e = buildKeepaServiceAlarmEmail({ variant: 'stalled', ...input });
    expect(e.subject).toBe('Keepa service stalled');
    expect(e.text).toContain('3 h ago');
  });
  it('recovered', () => {
    expect(buildKeepaServiceAlarmEmail({ variant: 'recovered', ...input }).subject).toBe('Keepa service recovered');
  });
});
```

```ts
// lib/notifications/sendKeepaServiceAlarmEmail.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consoleLines, spyOnConsole } from '@/tests/unit/consoleLines';

const { mockSend, mockWhere } = vi.hoisted(() => ({ mockSend: vi.fn(), mockWhere: vi.fn() }));
vi.mock('resend', () => ({ Resend: class { emails = { send: mockSend }; constructor(public apiKey: string) {} } }));
vi.mock('@/db/client', () => ({ db: { select: () => ({ from: () => ({ where: mockWhere }) }) } }));

import { sendKeepaServiceAlarmEmail } from './sendKeepaServiceAlarmEmail';

const ADMIN = 'admin@example.com';
const input = { variant: 'down' as const, heartbeatAt: null, lastBatchAt: null };

describe('sendKeepaServiceAlarmEmail', () => {
  let spies: ReturnType<typeof spyOnConsole>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    mockWhere.mockResolvedValue([{ email: ADMIN }]);
    spies = spyOnConsole();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('skips the lookup and the send when the API key is missing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    await sendKeepaServiceAlarmEmail(input);
    expect(mockWhere).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends to the admins and logs a count, never an address', async () => {
    mockSend.mockResolvedValueOnce({ data: { id: 'email_1' }, error: null });
    await sendKeepaServiceAlarmEmail(input);
    const arg = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.to).toEqual([ADMIN]);
    expect(arg.subject).toBe('Keepa service down');
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes('1 admin(s)'))).toBe(true);
    expect(lines.some((l) => l.includes(ADMIN))).toBe(false);
  });

  it('resolves on a Resend error and logs only the coded name and status', async () => {
    mockSend.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', statusCode: 403, message: `only ${ADMIN}` } });
    await expect(sendKeepaServiceAlarmEmail(input)).resolves.toBeUndefined();
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes('validation_error') && l.includes('403'))).toBe(true);
    expect(lines.some((l) => l.includes(ADMIN))).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run lib/keepa/readSource.test.ts lib/keepa/watcherRules.test.ts lib/notifications/buildKeepaServiceAlarmEmail.test.ts lib/notifications/sendKeepaServiceAlarmEmail.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// lib/keepa/readSource.ts
/**
 * Which table the app reads Keepa facts from (spec 2026-10-05 §7). `weekly` = asin_weekly_data
 * at the keyword's current week (the pre-arc-6 model); `products` = the asin_products catalog
 * written by the Keepa service. Set KEEPA_READ_SOURCE=products on Vercel and the Railway worker
 * to flip; an env change, not a deploy. Read at call time so a flip needs no restart on the worker.
 */
export type KeepaReadSource = 'weekly' | 'products';

export function keepaReadSource(env: Record<string, string | undefined> = process.env): KeepaReadSource {
  return env.KEEPA_READ_SOURCE === 'products' ? 'products' : 'weekly';
}
```

```ts
// lib/keepa/watcherRules.ts
/**
 * Pure decisions for the Keepa service watcher (spec 2026-10-05 §6.2). The cron function
 * (inngest/functions/keepaServiceWatcher.ts) reads the status row, calls this, then performs
 * the actions in order. No I/O here.
 */
import type { KeepaReadSource } from './readSource';

export const DOWN_AFTER_MS = 10 * 60_000;
export const STALL_AFTER_MS = 2 * 60 * 60_000;
export const RECENT_BATCH_MS = 24 * 60 * 60_000;
export const NIGHTLY_WINDOW = { hour: 3, fromMinute: 30, toMinute: 44 } as const;

export interface EasternClock {
  hour: number;
  minute: number;
  /** YYYY-MM-DD in America/New_York. */
  dateKey: string;
}

export interface WatcherInput {
  now: Date;
  heartbeatAt: Date | null;
  lastBatchAt: Date | null;
  dueWorkExists: boolean;
  laneNewDrainedAt: Date | null;
  syncFiredAt: Date | null;
  nightlySyncDate: string | null;
  downAlarmSentAt: Date | null;
  stallAlarmSentAt: Date | null;
  readSource: KeepaReadSource;
  et: EasternClock;
}

export type AlarmVariant = 'down' | 'stalled' | 'recovered';
export type StampField = 'down_alarm_sent_at' | 'stall_alarm_sent_at' | 'sync_fired_at' | 'nightly_sync_date';

export type WatcherAction =
  | { kind: 'email'; variant: AlarmVariant }
  | { kind: 'sync'; reason: 'new_lane_drained' | 'nightly' }
  | { kind: 'stamp'; field: StampField; value: Date | string | null };

export function easternClock(now: Date): EasternClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { hour: Number(get('hour')) % 24, minute: Number(get('minute')), dateKey: `${get('year')}-${get('month')}-${get('day')}` };
}

export function decideWatcherActions(i: WatcherInput): WatcherAction[] {
  const age = (d: Date | null) => (d ? i.now.getTime() - d.getTime() : Number.POSITIVE_INFINITY);
  const down = age(i.heartbeatAt) > DOWN_AFTER_MS;
  const stalled = !down && i.dueWorkExists && age(i.lastBatchAt) > STALL_AFTER_MS;

  const emails: AlarmVariant[] = [];
  const stamps: WatcherAction[] = [];
  if (down && !i.downAlarmSentAt) {
    emails.push('down');
    stamps.push({ kind: 'stamp', field: 'down_alarm_sent_at', value: i.now });
  }
  if (!down && i.downAlarmSentAt) {
    emails.push('recovered');
    stamps.push({ kind: 'stamp', field: 'down_alarm_sent_at', value: null });
  }
  if (stalled && !i.stallAlarmSentAt) {
    emails.push('stalled');
    stamps.push({ kind: 'stamp', field: 'stall_alarm_sent_at', value: i.now });
  }
  if (!stalled && !down && i.stallAlarmSentAt) {
    if (!emails.includes('recovered')) emails.push('recovered');
    stamps.push({ kind: 'stamp', field: 'stall_alarm_sent_at', value: null });
  }

  const actions: WatcherAction[] = [...emails.map((variant) => ({ kind: 'email' as const, variant })), ...stamps];

  if (i.readSource === 'products') {
    if (i.laneNewDrainedAt && (!i.syncFiredAt || i.laneNewDrainedAt > i.syncFiredAt)) {
      actions.push({ kind: 'sync', reason: 'new_lane_drained' }, { kind: 'stamp', field: 'sync_fired_at', value: i.now });
    } else if (
      i.et.hour === NIGHTLY_WINDOW.hour &&
      i.et.minute >= NIGHTLY_WINDOW.fromMinute &&
      i.et.minute <= NIGHTLY_WINDOW.toMinute &&
      age(i.lastBatchAt) <= RECENT_BATCH_MS &&
      i.nightlySyncDate !== i.et.dateKey
    ) {
      actions.push(
        { kind: 'sync', reason: 'nightly' },
        { kind: 'stamp', field: 'nightly_sync_date', value: i.et.dateKey },
        { kind: 'stamp', field: 'sync_fired_at', value: i.now },
      );
    }
  }
  return actions;
}
```

```ts
// lib/notifications/buildKeepaServiceAlarmEmail.ts
/** Pure subject/text/html for the three Keepa service watcher emails (spec 2026-10-05 §6.2). */
import type { AlarmVariant } from '@/lib/keepa/watcherRules';

export interface KeepaAlarmEmailInput {
  variant: AlarmVariant;
  heartbeatAt: Date | null;
  lastBatchAt: Date | null;
  appUrl: string;
  now: Date;
}

export interface BuiltKeepaAlarmEmail {
  subject: string;
  text: string;
  html: string;
}

function age(at: Date | null, now: Date): string {
  if (!at) return 'never';
  const ms = now.getTime() - at.getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} days ago`;
}

export function buildKeepaServiceAlarmEmail(i: KeepaAlarmEmailInput): BuiltKeepaAlarmEmail {
  const link = `${i.appUrl}/admin/keepa-enrichment`;
  const facts = `Last heartbeat: ${age(i.heartbeatAt, i.now)}. Last batch: ${age(i.lastBatchAt, i.now)}.`;
  const copy = {
    down: {
      subject: 'Keepa service down',
      lead: 'The Keepa service has not written a heartbeat for more than ten minutes.',
      hint: 'Check the Railway service: its latest deploy, logs and restarts. It resumes from the queue on its own once it is back.',
    },
    stalled: {
      subject: 'Keepa service stalled',
      lead: 'The Keepa service is alive but has not completed a batch in two hours while work is due.',
      hint: 'Check the last error on the admin page and the Railway logs; a rejected Keepa request (bad key, plan change) looks like this.',
    },
    recovered: {
      subject: 'Keepa service recovered',
      lead: 'The Keepa service is writing batches again.',
      hint: 'Nothing to do.',
    },
  }[i.variant];
  const text = `${copy.lead}\n\n${facts}\n\n${copy.hint}\n\nStatus: ${link}\n`;
  const html = `<p>${copy.lead}</p><p>${facts}</p><p>${copy.hint}</p><p><a href="${link}">Keepa service status</a></p>`;
  return { subject: copy.subject, text, html };
}
```

```ts
// lib/notifications/sendKeepaServiceAlarmEmail.ts
/**
 * Send a Keepa service watcher email to every admin. Fail-soft, mirroring sendEnrichmentEmail:
 * no key → skip; Resend error / thrown / recipient lookup failed → log coded fields and return.
 */
import { Resend } from 'resend';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { logLookupFailed, logResendError, logSendThrew } from './logSendFailure';
import { buildKeepaServiceAlarmEmail, type KeepaAlarmEmailInput } from './buildKeepaServiceAlarmEmail';

export type SendKeepaServiceAlarmEmailInput = Omit<KeepaAlarmEmailInput, 'appUrl' | 'now'>;

export async function sendKeepaServiceAlarmEmail(input: SendKeepaServiceAlarmEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'KeywordQuarry <notifications@keywordquarry.com>';
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com';
  if (!apiKey) {
    console.warn(`[sendKeepaServiceAlarmEmail] RESEND_API_KEY not set — skipping "${input.variant}" email. Expected in local dev.`);
    return;
  }
  const email = buildKeepaServiceAlarmEmail({ ...input, appUrl, now: new Date() });

  let recipients: string[] = [];
  try {
    const rows = await db.select({ email: users.email }).from(users).where(and(eq(users.role, 'admin'), isNotNull(users.email)));
    recipients = rows.map((r) => r.email).filter((e): e is string => !!e);
  } catch (e) {
    logLookupFailed('[sendKeepaServiceAlarmEmail]', e);
    return;
  }
  if (recipients.length === 0) {
    console.warn('[sendKeepaServiceAlarmEmail] no admin recipients found — skipping send.');
    return;
  }
  try {
    const result = await new Resend(apiKey).emails.send({ from, to: recipients, subject: email.subject, text: email.text, html: email.html });
    if (result.error) logResendError('[sendKeepaServiceAlarmEmail]', result.error);
    else console.log(`[sendKeepaServiceAlarmEmail] sent "${email.subject}" to ${recipients.length} admin(s). id=${result.data?.id}`);
  } catch (e) {
    logSendThrew('[sendKeepaServiceAlarmEmail]', e);
  }
}
```

```ts
// inngest/functions/keepaServiceWatcher.ts
/**
 * Keepa service watcher (spec 2026-10-05 §6.2) — every 15 minutes on the Railway worker:
 * down/stall alarms from the status row's heartbeat and last batch, and the explorer aggregate
 * sync when the never-fetched lane drains after an import or nightly at 03:30 ET. All decisions
 * live in lib/keepa/watcherRules.ts; this function only reads, decides, and acts.
 */
import { Pool } from 'pg';
import { inngest } from '../client';
import { decideWatcherActions, easternClock, type StampField } from '@/lib/keepa/watcherRules';
import { keepaReadSource } from '@/lib/keepa/readSource';
import { sendKeepaServiceAlarmEmail } from '@/lib/notifications/sendKeepaServiceAlarmEmail';

interface StatusRow {
  heartbeat_at: Date | null;
  last_batch_at: Date | null;
  tail_enabled: boolean;
  lane_new_drained_at: Date | null;
  sync_fired_at: Date | null;
  nightly_sync_date: string | null;
  down_alarm_sent_at: Date | null;
  stall_alarm_sent_at: Date | null;
}

const STAMP_SQL: Record<StampField, string> = {
  down_alarm_sent_at: 'UPDATE keepa_service_status SET down_alarm_sent_at = $1 WHERE singleton',
  stall_alarm_sent_at: 'UPDATE keepa_service_status SET stall_alarm_sent_at = $1 WHERE singleton',
  sync_fired_at: 'UPDATE keepa_service_status SET sync_fired_at = $1 WHERE singleton',
  nightly_sync_date: 'UPDATE keepa_service_status SET nightly_sync_date = $1 WHERE singleton',
};

export const keepaServiceWatcherFn = inngest.createFunction(
  {
    id: 'keepa-service-watcher',
    name: 'Keepa service watcher (alarms + explorer sync)',
    retries: 0,
    concurrency: { limit: 1 },
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 30_000, statement_timeout: 60_000 });
    try {
      const c = await pool.connect();
      try {
        const { rows } = await c.query<StatusRow>(
          `SELECT heartbeat_at, last_batch_at, tail_enabled, lane_new_drained_at, sync_fired_at,
                  nightly_sync_date::text AS nightly_sync_date, down_alarm_sent_at, stall_alarm_sent_at
           FROM keepa_service_status WHERE singleton`,
        );
        const s = rows[0];
        if (!s) return { ok: true, skipped: 'no status row' };
        const { rows: due } = await c.query<{ due: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM asin_products
             WHERE in_scope AND claimed_at IS NULL AND next_due_at <= now() AND (tier = 1 OR $1::boolean)
           ) AS due`,
          [s.tail_enabled],
        );
        const now = new Date();
        const actions = decideWatcherActions({
          now,
          heartbeatAt: s.heartbeat_at,
          lastBatchAt: s.last_batch_at,
          dueWorkExists: due[0]?.due ?? false,
          laneNewDrainedAt: s.lane_new_drained_at,
          syncFiredAt: s.sync_fired_at,
          nightlySyncDate: s.nightly_sync_date,
          downAlarmSentAt: s.down_alarm_sent_at,
          stallAlarmSentAt: s.stall_alarm_sent_at,
          readSource: keepaReadSource(),
          et: easternClock(now),
        });
        for (const a of actions) {
          if (a.kind === 'email') {
            await sendKeepaServiceAlarmEmail({ variant: a.variant, heartbeatAt: s.heartbeat_at, lastBatchAt: s.last_batch_at });
          } else if (a.kind === 'sync') {
            const { rows: meta } = await c.query<{ cw: string }>(
              `SELECT current_week_end_date::text AS cw FROM keyword_current_summary_meta WHERE singleton = true`,
            );
            if (meta[0]?.cw) await inngest.send({ name: 'keepa/aggregates-sync-requested', data: { weekEndDate: meta[0].cw } });
          } else {
            await c.query(STAMP_SQL[a.field], [a.value]);
          }
        }
        const summary = actions.map((a) => (a.kind === 'email' ? `email:${a.variant}` : a.kind === 'sync' ? `sync:${a.reason}` : `stamp:${a.field}`));
        console.log(`[keepa-watcher] ${JSON.stringify({ actions: summary })}`);
        return { ok: true, actions: summary };
      } finally {
        c.release();
      }
    } finally {
      await pool.end();
    }
  },
);
```

Register it in `inngest/functions/index.ts`: add `import { keepaServiceWatcherFn } from './keepaServiceWatcher';` and append `keepaServiceWatcherFn,` to the `functions` array (the worker's boot log prints the registered count; it goes from 12 to 13).

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run lib/keepa lib/notifications inngest`
Expected: PASS (the four new files plus everything existing).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
pnpm exec eslint lib/keepa/readSource.ts lib/keepa/readSource.test.ts lib/keepa/watcherRules.ts lib/keepa/watcherRules.test.ts lib/notifications/buildKeepaServiceAlarmEmail.ts lib/notifications/buildKeepaServiceAlarmEmail.test.ts lib/notifications/sendKeepaServiceAlarmEmail.ts lib/notifications/sendKeepaServiceAlarmEmail.test.ts inngest/functions/keepaServiceWatcher.ts inngest/functions/index.ts
git add lib/keepa/readSource.ts lib/keepa/readSource.test.ts lib/keepa/watcherRules.ts lib/keepa/watcherRules.test.ts lib/notifications/buildKeepaServiceAlarmEmail.ts lib/notifications/buildKeepaServiceAlarmEmail.test.ts lib/notifications/sendKeepaServiceAlarmEmail.ts lib/notifications/sendKeepaServiceAlarmEmail.test.ts inngest/functions/keepaServiceWatcher.ts inngest/functions/index.ts
git commit -m "feat(worker): Keepa service watcher cron — down/stall alarms with recovery, explorer sync after the new lane drains and nightly at 03:30 ET (catalog reads only), KEEPA_READ_SOURCE flag

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Flagged reader switch (phase 2)

**Files:**
- Modify: `lib/explorer/fetchKeywordDetail.ts` (the two Keepa product queries at ~lines 299–318 and ~811–828; `EnrichedProduct` at ~line 87; `mapEnrichedProducts` at ~line 408)
- Modify: `inngest/functions/refreshSummary.ts` (`stageEnrichedAsins`, ~line 725)
- Modify: `worker/kcsKeepaSyncJobs.ts` (phase 1, the `CREATE UNLOGGED TABLE tmp_asin_enriched_sync` statement)
- Modify: `lib/categoryBuilder/loadTree.ts` (the three cached builders and their callers)
- Test: `lib/explorer/enrichedProductsQuery.test.ts`
- Read first: spec §7; `lib/keepa/readSource.ts` (Task 11). `lib/research/categories.ts` only mentions the old table in a comment — no change.

- [ ] **Step 1: Write the failing test for the detail-page query helper**

```ts
// lib/explorer/enrichedProductsQuery.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
import { enrichedProductsFor } from './fetchKeywordDetail';

/** A tagged-template stand-in for neon's sql: returns the joined text and the bound values. */
const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise.resolve({ text: strings.join('?'), values })) as never;

describe('enrichedProductsFor', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads the per-week table at the keyword\'s current week by default', async () => {
    const q = (await enrichedProductsFor(fakeSql, '42')) as unknown as { text: string; values: unknown[] };
    expect(q.text).toContain('FROM asin_weekly_data a');
    expect(q.text).toContain('a.week_end_date = kcs.current_week_end_date');
    expect(q.values).toEqual(['42']);
  });

  it('reads the catalog with the new fields when KEEPA_READ_SOURCE=products', async () => {
    vi.stubEnv('KEEPA_READ_SOURCE', 'products');
    const q = (await enrichedProductsFor(fakeSql, '42')) as unknown as { text: string; values: unknown[] };
    expect(q.text).toContain('FROM asin_products a');
    expect(q.text).not.toContain('a.week_end_date');
    expect(q.text).toContain('a.monthly_sold');
    expect(q.text).toContain('a.fba_offer_count');
    expect(q.values).toEqual(['42']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run lib/explorer/enrichedProductsQuery.test.ts`
Expected: FAIL — `enrichedProductsFor` is not exported.

- [ ] **Step 3: The detail page**

In `lib/explorer/fetchKeywordDetail.ts` add `import { keepaReadSource } from '@/lib/keepa/readSource';` and, above `export async function fetchKeywordDetail(`, this exported helper:

```ts
type NeonSql = ReturnType<typeof neon>;

/**
 * Keepa facts for a keyword's top-3 ASINs (≤ 3 rows). Spec 2026-10-05 §7: from the asin_products
 * catalog when KEEPA_READ_SOURCE=products (no week predicate — the catalog holds one current row
 * per ASIN), otherwise from asin_weekly_data at the keyword's current week. Both shapes map
 * through mapEnrichedProducts; the catalog adds the new fields, null under the weekly source.
 */
export function enrichedProductsFor(sql: NeonSql, searchTermId: string) {
  if (keepaReadSource() === 'products') {
    return sql`
      SELECT
        a.asin, a.title, a.brand, a.image_url,
        a.category_path, a.category_root, a.category_leaf,
        a.current_price_cents, a.sales_rank, a.review_count, a.average_rating_x10,
        a.avg30_price_cents, a.avg90_price_cents, a.avg180_price_cents, a.avg365_price_cents,
        a.monthly_sold, a.keepa_updated_at::text AS keepa_updated_at, a.listed_since::text AS listed_since,
        a.new_offer_count, a.fba_offer_count, a.fbm_offer_count, a.amazon_availability,
        a.avg30_sales_rank, a.avg90_sales_rank,
        a.enrichment_status::text AS enrichment_status
      FROM asin_products a
      JOIN keyword_current_summary kcs
        ON kcs.search_term_id = ${searchTermId}
      JOIN keyword_weekly_metrics kwm
        ON kwm.search_term_id = kcs.search_term_id
        AND kwm.week_end_date = kcs.current_week_end_date
      WHERE a.asin = ANY(ARRAY[
          kwm.top_clicked_product_1_asin,
          kwm.top_clicked_product_2_asin,
          kwm.top_clicked_product_3_asin
        ]::text[])
    `;
  }
  return sql`
      SELECT
        a.asin, a.title, a.brand, a.image_url,
        a.category_path, a.category_root, a.category_leaf,
        a.current_price_cents, a.sales_rank, a.review_count, a.average_rating_x10,
        a.avg30_price_cents, a.avg90_price_cents, a.avg180_price_cents, a.avg365_price_cents,
        a.enrichment_status::text AS enrichment_status
      FROM asin_weekly_data a
      JOIN keyword_current_summary kcs
        ON kcs.search_term_id = ${searchTermId}
      JOIN keyword_weekly_metrics kwm
        ON kwm.search_term_id = kcs.search_term_id
        AND kwm.week_end_date = kcs.current_week_end_date
      WHERE a.week_end_date = kcs.current_week_end_date
        AND a.asin = ANY(ARRAY[
          kwm.top_clicked_product_1_asin,
          kwm.top_clicked_product_2_asin,
          kwm.top_clicked_product_3_asin
        ]::text[])
    `;
}
```

Then replace both inline queries with the helper: in the `Promise.all` array (~line 299) the whole `sql\`…\`` element — keep its leading comment, shortened to `// Keepa-enriched data for the top-3 ASINs (≤3 rows) — see enrichedProductsFor.` — becomes `enrichedProductsFor(sql, searchTermId),`; and at ~line 811 `const enrichedRowsAny = await sql\`…\`;` becomes `const enrichedRowsAny = await enrichedProductsFor(sql, searchTermId);`. Delete nothing else.

Extend `EnrichedProduct` (optional fields, so `lib/research/details.test.ts`'s literals still type-check):

```ts
  /** Catalog-only fields (null under the weekly source). Spec 2026-10-05 §4.1. */
  monthlySold?: number | null;
  keepaUpdatedAt?: string | null;
  listedSince?: string | null;
  newOfferCount?: number | null;
  fbaOfferCount?: number | null;
  fbmOfferCount?: number | null;
  amazonAvailability?: number | null;
  avg30SalesRank?: number | null;
  avg90SalesRank?: number | null;
```

and in `mapEnrichedProducts`, after `avg365PriceCents`:

```ts
      monthlySold: (r.monthly_sold as number | null) ?? null,
      keepaUpdatedAt: (r.keepa_updated_at as string | null) ?? null,
      listedSince: (r.listed_since as string | null) ?? null,
      newOfferCount: (r.new_offer_count as number | null) ?? null,
      fbaOfferCount: (r.fba_offer_count as number | null) ?? null,
      fbmOfferCount: (r.fbm_offer_count as number | null) ?? null,
      amazonAvailability: (r.amazon_availability as number | null) ?? null,
      avg30SalesRank: (r.avg30_sales_rank as number | null) ?? null,
      avg90SalesRank: (r.avg90_sales_rank as number | null) ?? null,
```

Run: `pnpm vitest run lib/explorer` — expected PASS, including the new test.

- [ ] **Step 4: The weekly refresh staging**

In `inngest/functions/refreshSummary.ts` add `import { keepaReadSource } from '@/lib/keepa/readSource';` and change `stageEnrichedAsins` so the first `client.query` becomes:

```ts
  const fromCatalog = keepaReadSource() === 'products';
  const asinsOfLatestTerms = `
        SELECT DISTINCT asin FROM (
          SELECT top_clicked_product_1_asin AS asin FROM latest_per_term WHERE top_clicked_product_1_asin IS NOT NULL
          UNION
          SELECT top_clicked_product_2_asin FROM latest_per_term WHERE top_clicked_product_2_asin IS NOT NULL
          UNION
          SELECT top_clicked_product_3_asin FROM latest_per_term WHERE top_clicked_product_3_asin IS NOT NULL
        ) all_asins`;
  await client.query(
    fromCatalog
      ? `
    CREATE TEMP TABLE asin_enriched_current ON COMMIT DROP AS
    SELECT a.asin, a.current_price_cents, a.review_count, a.average_rating_x10, a.category_leaf, a.category_path
    FROM asin_products a
    WHERE a.enrichment_status = 'active'
      AND a.asin IN (${asinsOfLatestTerms})
    `
      : `
    CREATE TEMP TABLE asin_enriched_current ON COMMIT DROP AS
    SELECT DISTINCT ON (a.asin)
      a.asin,
      a.current_price_cents,
      a.review_count,
      a.average_rating_x10,
      a.category_leaf,
      a.category_path
    FROM asin_weekly_data a
    WHERE a.week_end_date <= $1::date
      AND a.enrichment_status = 'active'
      AND a.asin IN (${asinsOfLatestTerms})
    ORDER BY a.asin, a.week_end_date DESC
    `,
    fromCatalog ? [] : [currentWeekEndDate],
  );
```

(the second statement, `CREATE INDEX ON asin_enriched_current (asin)`, stays). Update the function's doc comment with one line: "Under KEEPA_READ_SOURCE=products the catalog's current row replaces the latest-week lookup (spec 2026-10-05 §7)."

- [ ] **Step 5: The aggregate sync**

In `worker/kcsKeepaSyncJobs.ts` add `import { keepaReadSource } from '@/lib/keepa/readSource';` and replace the phase-1 `CREATE UNLOGGED TABLE` call with:

```ts
        const fromCatalog = keepaReadSource() === 'products';
        await c.query(
          fromCatalog
            ? `CREATE UNLOGGED TABLE tmp_asin_enriched_sync AS
               SELECT a.asin, a.current_price_cents, a.review_count, a.category_leaf, a.category_path
               FROM asin_products a
               WHERE a.enrichment_status = 'active'`
            : `CREATE UNLOGGED TABLE tmp_asin_enriched_sync AS
               SELECT DISTINCT ON (a.asin)
                 a.asin,
                 a.current_price_cents,
                 a.review_count,
                 a.category_leaf,
                 a.category_path
               FROM asin_weekly_data a
               WHERE a.week_end_date <= $1::date
                 AND a.enrichment_status = 'active'
               ORDER BY a.asin, a.week_end_date DESC`,
          fromCatalog ? [] : [cw],
        );
```

- [ ] **Step 6: The category builder**

In `lib/categoryBuilder/loadTree.ts` add `import { keepaReadSource, type KeepaReadSource } from '@/lib/keepa/readSource';`. Give each of the three `unstable_cache` builders a `src: KeepaReadSource` parameter after `wk` (it becomes part of the cache key, so a flag flip never serves the other table's cached tree) and branch the query:

```ts
const buildCachedRoots = unstable_cache(
  async (_sv: string, wk: string, src: KeepaReadSource): Promise<LightNode[]> => {
    const sql = neon(env.DATABASE_URL);
    const rows = (src === 'products'
      ? await sql`
      SELECT
        split_part(category_path, ' › ', 1) AS name,
        bool_or(category_path = split_part(category_path, ' › ', 1)) AS terminal,
        bool_or(position(' › ' in category_path) > 0) AS has_children
      FROM asin_products
      WHERE category_path IS NOT NULL AND category_path <> ''
      GROUP BY 1
    `
      : await sql`
      SELECT
        split_part(category_path, ' › ', 1) AS name,
        bool_or(category_path = split_part(category_path, ' › ', 1)) AS terminal,
        bool_or(position(' › ' in category_path) > 0) AS has_children
      FROM asin_weekly_data
      WHERE week_end_date = ${wk}::date
        AND category_path IS NOT NULL AND category_path <> ''
      GROUP BY 1
    `) as Array<{ name: string; terminal: boolean; has_children: boolean }>;
    return toSortedLevel(rows);
  },
  ['category-builder-roots'],
  { revalidate: REVALIDATE, tags: TAGS },
);
```

`buildCachedChildren(_sv, wk, src, prefix)`: the `sub` CTE's `FROM asin_weekly_data WHERE week_end_date = ${wk}::date AND starts_with(category_path, ${prefix})` becomes, under `products`, `FROM asin_products WHERE starts_with(category_path, ${prefix})`; the rest of the query is identical. `buildCachedLeaves(_sv, wk, src, pathStr, prefix)`: `FROM asin_weekly_data WHERE week_end_date = ${wk}::date AND (...)` becomes `FROM asin_products WHERE (...)`. Write each as a full `src === 'products' ? await sql\`…\` : await sql\`…\`` pair, as above.

Callers: `buildCachedRoots(sv ?? 'no-snapshot', wk, keepaReadSource())`, `buildCachedChildren(sv ?? 'no-snapshot', wk, keepaReadSource(), prefix)`, and the leaves caller likewise. Update the file's header comment: "Source table follows KEEPA_READ_SOURCE (lib/keepa/readSource.ts)".

- [ ] **Step 7: Typecheck, lint, tests**

Run: `pnpm typecheck && pnpm exec eslint lib/explorer/fetchKeywordDetail.ts lib/explorer/enrichedProductsQuery.test.ts inngest/functions/refreshSummary.ts worker/kcsKeepaSyncJobs.ts lib/categoryBuilder/loadTree.ts && pnpm test`
Expected: clean; the whole suite green.

- [ ] **Step 8: Commit**

```bash
git add lib/explorer/fetchKeywordDetail.ts lib/explorer/enrichedProductsQuery.test.ts inngest/functions/refreshSummary.ts worker/kcsKeepaSyncJobs.ts lib/categoryBuilder/loadTree.ts
git commit -m "feat(keepa): readers switch to the asin_products catalog behind KEEPA_READ_SOURCE — detail page (with the new fields), refresh staging, aggregate sync, category builder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Retire the old enrichment path (phase 3 — only after Task 14's phase-2 checks pass)

**Files:**
- Delete: `worker/keepaJobs.ts`, `inngest/functions/enrichKeepaForWeek.ts`, `app/api/admin/keepa-enrichment/fire-full/route.ts`, `app/admin/keepa-enrichment/KeepaEnrichmentButton.tsx`, `lib/notifications/buildEnrichmentEmail.ts`, `lib/notifications/buildEnrichmentEmail.test.ts`, `lib/notifications/sendEnrichmentEmail.ts`, `lib/notifications/sendEnrichmentEmail.test.ts`, `lib/keepa/client.ts`, `lib/keepa/parse.ts`, `lib/keepa/parse.test.ts`, `lib/keepa/__fixtures__/active-toiletpaper.json`, `lib/keepa/__fixtures__/delisted-synthesized.json`, `lib/keepa/__fixtures__/no-price-needoh.json`, `scripts/keepaSmokeTest.ts`, `scripts/fireEnrichWeek.ts`, `scripts/fireKeepaEnrichment.ts`
- Modify: `worker/index.ts` (drop the `reclaimStaleKeepaRunsOnBoot` import and the boot-time reclaim block), `inngest/functions/importFile.ts` (drop the `keepa.enrich-week-requested` send block), `inngest/functions/index.ts` (drop `enrichKeepaForWeek`), `app/admin/keepa-enrichment/page.tsx` + `page.test.tsx` (drop the button, the runs table, the `keepaEnrichmentRuns` import; the intro text now describes the service), `lib/keepa/types.ts` (drop `EnrichmentRow`; keep `KeepaProductResponse` and `AsinEnrichmentStatus` if anything still imports them — check with grep)
- Keep: `inngest/functions/syncKcsKeepaAggregates.ts` and `worker/kcsKeepaSyncJobs.ts` (fired by the watcher now), `db/schema/keepaEnrichmentRuns.ts` (the table stays; no DDL), `lib/keepa/categoryExclusions.ts`, `scripts/checkKeepaProgress.ts`, `scripts/countEnrichableAsins.ts`, `scripts/checkActiveJobs.ts` (untracked; it still queries `keepa_enrichment_runs`, which still exists).

- [ ] **Step 1: Confirm the importers** — `grep -rn "keepaJobs\|enrichKeepaForWeek\|EnrichmentEmail\|lib/keepa/client'\|lib/keepa/parse'\|from './parse'\|from './client'" --include=*.ts --include=*.tsx app lib worker inngest scripts tests | grep -v "inngest/client\|'../client'"` must list only the files named above (plus `KeepaEnrichmentButton` under the page). Anything else means a new importer appeared: stop and ask.

- [ ] **Step 2: Delete and edit**

```bash
git rm worker/keepaJobs.ts inngest/functions/enrichKeepaForWeek.ts app/api/admin/keepa-enrichment/fire-full/route.ts app/admin/keepa-enrichment/KeepaEnrichmentButton.tsx lib/notifications/buildEnrichmentEmail.ts lib/notifications/buildEnrichmentEmail.test.ts lib/notifications/sendEnrichmentEmail.ts lib/notifications/sendEnrichmentEmail.test.ts lib/keepa/client.ts lib/keepa/parse.ts lib/keepa/parse.test.ts lib/keepa/__fixtures__/active-toiletpaper.json lib/keepa/__fixtures__/delisted-synthesized.json lib/keepa/__fixtures__/no-price-needoh.json scripts/keepaSmokeTest.ts scripts/fireEnrichWeek.ts scripts/fireKeepaEnrichment.ts
```

`worker/index.ts`: remove `import { reclaimStaleKeepaRunsOnBoot } from './keepaJobs';` and the whole `reclaimStaleKeepaRunsOnBoot()...catch(...)` block with its comment inside `app.listen`.

`inngest/functions/importFile.ts`: remove the block that starts with the comment `// Trigger Keepa enrichment for the new current week.` through the closing `}` of `if (!isReplay && summaryRefreshOk && refreshResult?.currentWeekEndDate) { … }` (the Task 10 hook above it stays).

`inngest/functions/index.ts`: remove the `enrichKeepaForWeek` import and array entry.

`app/admin/keepa-enrichment/page.tsx`: remove the `keepaEnrichmentRuns`, `desc` and `KeepaEnrichmentButton` imports, the `recentRuns` query, the amber box, the "Recent runs" table and `statusColor`; replace the two intro paragraphs with:

```tsx
      <p className="mt-2 text-gray-600">
        Product data comes from the always-on Keepa service: the top-1M keywords&apos; ASINs are refreshed
        weekly in 100-ASIN batches, new ASINs first after every import. Nothing to fire by hand.
      </p>
```

`page.test.tsx`: the `dbm.select` mock now resolves one chain (`meta`) — keep `expect(dbm.select).toHaveBeenCalledTimes(1)`; drop the `'No runs yet.'` assertion.

`lib/keepa/types.ts`: delete `EnrichmentRow` (its only consumers are gone); run `grep -rn "KeepaProductResponse\|AsinEnrichmentStatus" --include=*.ts app lib worker inngest services scripts` — delete whichever of the two has no importer left outside this file; if neither has one, delete the file.

- [ ] **Step 3: Typecheck, full tests, lint**

Run: `pnpm typecheck && pnpm test && pnpm exec eslint worker/index.ts inngest/functions/importFile.ts inngest/functions/index.ts app/admin/keepa-enrichment lib/keepa`
Expected: clean. The worker's registered function count drops by one (12 after Task 11's +1 and this −1).

- [ ] **Step 4: Commit**

```bash
git add -u worker/index.ts inngest/functions/importFile.ts inngest/functions/index.ts app/admin/keepa-enrichment/page.tsx app/admin/keepa-enrichment/page.test.tsx lib/keepa/types.ts
git commit -m "chore(keepa): retire the import-time enrichment job, the full-refresh button and the old client/parser/emails — the Keepa service owns enrichment (phase 3)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(`git add -u <paths>` stages only the named tracked files; the `git rm` deletions are already staged.)

---

### Task 14: Ship and smoke, phase by phase (owner-gated)

Every push: `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` first (no running import; a `keepa_enrichment_runs` row still 'running' means the old job is mid-flight — wait), then a bare `git push origin main` as its own command, then watch `gh api repos/raw5045/AmazonAnalytics/commits/<sha>/status --jq '"overall: \(.state)", (.statuses[] | "\(.context): \(.state) @ \(.updated_at)")'` until Vercel and the worker are green. The new Railway service deploys when `services/keepa/**` or `lib/keepa/**` changed (every push below except the retire push may trigger it; harmless).

- [ ] **Step 1 (owner's go): apply 0050 + seed.** `APPLY_0050=yes node --env-file=.env.local --import tsx scripts/applyMigration0050.ts`. Expected console table: tier1_in_scope ≈ 1,003,344, tier1_never_fetched ≈ 715,083, snapshots > 356,540, earliest_tier1_due around 2026-10-10. Paste the table into the Results row.
- [ ] **Step 2 (owner's go): integration test.** `RUN_INTEGRATION=1 pnpm test:integration tests/integration/keepaService.test.ts` — 3 tests pass; `SELECT count(*) FROM asin_products WHERE asin LIKE 'TESTKS%'` returns 0 afterwards.
- [ ] **Step 3 (owner's go): push Tasks 1–12** (phase 1 code; the flag defaults to `weekly`, so nothing user-facing changes). After the deploys: the owner's Railway service shows a healthy deploy; `GET` its public URL (or the deploy's health log) returns `{"ok":true,"service":"keepa-service",…}`; Railway logs show `[keepa-svc] {"event":"token_status",…}` then `{"event":"batch","lane":"new",…}` lines about every 48 seconds; `/admin/keepa-enrichment` shows the card with "Tier 1 never fetched" falling. The worker's boot log lists 13 functions.
- [ ] **Step 4: shadow week (≈ 7 days, owner watches the card).** Expected: never-fetched tier 1 reaches 0 in about 4.5 days; fetched last 24 h ≈ 150–180k; oldest tier-1 fetch ≤ 8 days; no alarm emails; after the weekly import, Railway worker logs show `[keepa-enqueue] week …: inserted=… updated=… retired=… vacuumed=…` and the service's new lane refills with that week's ASINs. Spot check (read-only script, 10 ASINs): `asin_products` values vs the old table's latest rows for the same ASINs — titles, categories equal; prices/reviews within normal drift.
- [ ] **Step 5 (owner): flag flip (phase 2).** Owner sets `KEEPA_READ_SOURCE=products` on Vercel (Production) and on the Railway worker. Smoke: a keyword detail page shows product data for an ASIN the service fetched (compare "last fetched" on the card); the explorer's avg-price sort still works after the next nightly sync (03:30 ET) or after the next import; the category builder still lists the departments. Revert = set the variable back to `weekly`.
- [ ] **Step 6 (owner's go): push Task 13 (phase 3)** after one weekly import has gone through with both paths. Smoke after the next import: the service picks up the new ASINs (card's never-fetched count jumps then drains), no enrichment email arrives, the explorer sync runs (watcher log `sync:new_lane_drained`).
- [ ] **Step 7: docs.** Append a "Landed shape" section to this plan (deviations found during execution) and fill the Results table; commit with the next push.

**Results**

| Step | Date | Outcome | Notes |
|---|---|---|---|
| 0050 applied + seeded | | | |
| Integration test | | | |
| Phase 1 push + first batches | | | |
| Shadow week | | | |
| Flag flip | | | |
| Phase 3 push | | | |

**Landed shape** — filled during execution.


## Landed shape (2026-10-05) — what changed between the tasks above and the commits

Tasks 1–12 landed on local main (f40ad07 → the phase-1 head). Every task went through a spec-compliance review and a code-quality review with fix rounds; the fixes below override the task text. Spec §13 carries the same list from the design side.

- **Tasks 1–2 (097197c, 08f0b45 + d515519, 2c8fed8, 994002e).** `enqueueWeek` is transaction-scoped: `BEGIN`, `SET LOCAL statement_timeout = '1800s'`, `pg_advisory_xact_lock(ENQUEUE_LOCK_KEY)`, the scope guard (SQL-side `max(scope_week) > $1::date`), the upsert (`RETURNING (xmax = 0)` → inserted/updated counts; `<> ALL($4::text[])` exclusions; `t.asin ~ '^[A-Z0-9]{10}$'`), the zero-row guard, the retire, `COMMIT`, then a best-effort `VACUUM (ANALYZE)` (`vacuumed`, `vacuumError`). Neon's pooler (PgBouncer, transaction mode) does not keep session locks, hence the transaction scope. `EnqueueWeekError` codes: `enqueue_week_bad_date`, `enqueue_week_bad_client` (a Pool is refused), `enqueue_week_no_rows`, `enqueue_week_older_than_scope` (unless `force`). `ENQUEUE_LOCK_KEY = 20261005` lives in `lanes.ts`. Plan prose miscounts: Task 1 "9 tests" was 8 (now 9 with the rate test); Task 5 "8 tests" was 7.
- **Task 3 (911936a + c7fcec7, ee05c57).** Lane indexes `(tier, best_rank, asin)` / `(tier, next_due_at, asin)`; `asin_products_category_path_idx (category_path text_pattern_ops) WHERE in_scope AND category_path IS NOT NULL`; `asin_products_scope_week_idx (scope_week)`; `CHECK (char_length(...) <= 64)` on `error_code` and `last_error_code`; `autovacuum_vacuum_scale_factor = 0.05`; comment: never fetched = `last_fetched_at IS NULL`. The untracked apply script gained keepalive + error listeners, `SHOW` of the server-side timeouts, DDL assertions (5 indexes incl. predicates and opclass, 5 constraints, 41/11/16 columns), `SET LOCAL work_mem = '256MB'` transactions around seed steps 1 and 3, delisted rows seeded with the 30-day recheck, coded errors, post-seed gates, and corrected expectations (earliest tier-1 due is MONTHS back for ranks 100k–1M — expected). Never re-run the apply script once the service is live; re-scope with `scripts/fireEnqueueWeek.ts`.
- **Tasks 4–5 (cdcfde6, 65919af + 7325fd5, 5325947, 45f36cb, 7323985).** Capture used 3 tokens (the second ASIN was not charged the rating token); `history=0` kept (`stats.current` has 36 slots). B0GX1XP72Z now returns as `productType` 4. Parser: `productType` 3/4 → delisted; absence from a non-empty reply → `error`/`missing_from_reply`; no non-empty `stats.current` and no csv → `error`/`no_stats`; csv fallback only for an absent stats slot; offer counts (11/34/35) −1 → 0 (`'offerCount'` floor); NUL stripped (`replaceAll`); integers > 2³¹−1 → null; category path all-or-nothing; Keepa minutes > year 2100 → null; a throwing product object → `error`/`parse_failed`; array input → `bad_object`; exact fixture pin + decoy tests + boundary tests. Client: empty `products` or a non-object JSON body → `KeepaReplyError` (`keepa_bad_reply`; body-read failures other than `SyntaxError` keep their own name; a 429 with an unreadable body still waits 60 s); `refillIn` clamped 1–120 s; response bodies cancelled on error paths; `RangeError` batch guard.
- **Tasks 6–8 (e572a69, 7e5be97, deda012 + 778bbe2, 5c0fe04, 672137d, 40128db, 01b8b97, d641bb3).** Every store transaction opens with `SET LOCAL statement_timeout = '1900s'`, `pg_advisory_xact_lock_shared(ENQUEUE_LOCK_KEY)`, `SET LOCAL statement_timeout = '300s'`; a no-op `'error'` listener sits on the checked-out client and a failed transaction releases it with `release(true)`. Success due date by the row's CURRENT tier (`CASE WHEN tier = 1 THEN $30::timestamptz ELSE $31::timestamptz END`, 31 params). No snapshot rows for `error` outcomes. Loop: independent 60 s heartbeat ticker (`startHeartbeat`), token wait capped at 2 min (`tokenWaitMs` on the batch line; `token_wait` logged above 60 s), `keepa_tokens_exhausted` from the fifth consecutive 429, all-error batches (`batchErrorCode`) set `last_error_code` and leave `last_batch_at` alone, outage pause 1→15 min after an unanswered batch, a ≥ 10-row all-error batch or a second consecutive 400 batch, HTTP 400 marked after 3 attempts (401–499 retry forever), codes `keepa_timeout` / `keepa_network_<cause>` / `keepa_bad_reply` capped at 64, `safeIteration` (`iteration_threw` counts toward the ten-failure exit), `stale_claims_released` log, 503 health until booted, SIGTERM → `releaseOwnClaims(bootId)` (10 s cap), boot logs the server-side `statement_timeout`, pool `idleTimeoutMillis` 120 s with a `max: 3` comment, README operations + log-events table. Integration test: run with `RUN_INTEGRATION=1 pnpm vitest run tests/integration/keepaService.test.ts`, service stopped and no enqueue running; it briefly claims and releases real rows (`claimed_by = 'test-boot'`) and restores the status row.
- **Task 9 (eb20bb6 + eb6a452, 56652e7, d9dd4a5).** Loader at `lib/admin/keepaServiceOverview.ts` (out of the service's watch path; takes the kcs week from the page; status via drizzle, aggregate via raw SQL in `Promise.all`; strict alias mapping with coded `overview_missing:<alias>` errors). Card: "Tier 1 stale (fetched > 8 days ago)" (delisted excluded) and "Tier 1 in error backoff" replace the outlier-driven oldest age as the target; "Catalog scope week" / "Explorer week" ("behind the explorer" only when older); "New lane last drained"; tokens "N left · refills R/min"; capacity from the live refill rate via `lanes.ts` constants; `ageLabel`/`agoLabel`; a loader failure renders "Service status unavailable (code)" and leaves the page intact. The plan's card test needed no db mock after the constants moved.
- **Task 10 (36bf6b7 + 52b48ad, 28d062f).** Hook pool: keepalive, 20 s connect timeout, `'error'` listeners on pool and client (inside the try); logs `inserted/updated/retired/vacuumed[/vacuumError]`, a skip line for `enqueue_week_older_than_scope`, `{ week, stage, error, code }` on failure; `timePhase` gets the row count. Five focused tests pin the fail-soft contract. `scripts/fireEnqueueWeek.ts`: `DATABASE_URL` guard, a "starting" line, `FIRE_ENQUEUE_FORCE=1` warning (rewinds the live scope).
- **Task 11 (cdd70de + 24ab5c2, dd3d604, 43c1ee9, e84701b + the final round).** `DOWN_AFTER_MS` 15 min; `SYNC_MIN_GAP_MS` 6 h deferral; `serviceBooted` (no actions before the first boot); `enqueueRunning` (`pg_locks` probe with the key halves and a database filter; alarms suppressed); `explorerCaughtUp` (unknown explorer week holds syncs; the drained-lane AND the nightly sync wait for the explorer to reach the catalog's scope week); the scope/explorer weeks are read only when `syncCouldFire`; due-work probe = two EXISTS with the lane predicates and a five-minute grace; nightly window 03:30–05:59 ET, once per ET date, stamp-only when a sync ran within 6 h and the gap cannot close inside the window; stall-aware recovery (never "recovered" while stalled; a down alarm clearing into a stall sends "stalled"); setting stamps written only after a delivered alarm (`sendKeepaServiceAlarmEmail` returns a boolean); socket guards; `runWatcherTick(client, deps)` with a recording-fake test file; tick log with ages, probes and `held` reasons (`night_missed` after the window). Email copy derived from the constants. New owner-gated `tests/integration/keepaWatcher.test.ts` (each tick inside `BEGIN … ROLLBACK`; run between quarter-hours).
- **Task 12 (2cededf + 19dada7, 2eb39a1).** `type NeonSql = NeonQueryFunction<false, false>` (the plan's alias failed typecheck). Catalog detail variant adds `enrichment_status IS NOT NULL`; `mapEnrichedProducts` nulls the price fields unless the status is active. Catalog staging/sync take `enrichment_status IN ('active', 'no_price', 'delisted')` with `CASE WHEN active THEN current_price_cents END` (the weekly path fell back to the last active row; this keeps reviews/category for out-of-stock products). `stageEnrichedAsinsSql` / `enrichedSyncSourceSql` are pure builders pinned against drizzle's table columns. Category-builder catalog variants filter `in_scope`. **Flipping `KEEPA_READ_SOURCE` is an env change PLUS a redeploy** (Vercel applies env to new deployments only; Railway redeploys the worker on a variable change — run `scripts/checkActiveJobs.ts` first). Until both have redeployed, the detail page/builder (Vercel) and the aggregates (worker) read different sources.

- **Final whole-diff review fixes (0cb6bb8, d4bd9e0; re-review round 4d1f816, 9a7edc4).** The old import-time job (`worker/keepaJobs.ts`) and the service share one Keepa token bucket until phase 3, and the old client turns a 429 into a week-long `error` row; so the service yields while any `keepa_enrichment_runs` row has a heartbeat under 10 minutes old, status ignored (`KeepaStore.oldJobRunning()`, probed before the claim and again before every Keepa request, releasing its own claims when the job appears mid-batch; `runIteration` heartbeats, sleeps 60 s, returns `'yielded'`; log `yield_old_job` / `resume_after_old_job` on the transitions) and the watcher holds the stall alarm meanwhile (`WatcherInput.oldJobRecentlyLive` = a heartbeat under 30 minutes old, any status, so the service has resumed and landed a batch before the stall can be judged again; held reason `old_job_recent`; an outstanding stall alarm is neither cleared nor "recovered" while held). The stall clock runs from `lastBatchAt ?? bootedAt` (no false stall on launch day). Token-envelope fields are rounded to integers in `batchClient.ts`. Seed leaves `price_source` NULL (legacy rows do not record the series). Both go away with the old job in phase 3 (Task 13 deletes the probe, the store method and the held reason).
### Task 13, amended

In addition to the removals listed: delete the weekly variants and the `KEEPA_READ_SOURCE` flag (`lib/keepa/readSource.ts`, `enrichedProductsFor`'s weekly branch, `stageEnrichedAsinsSql`/`enrichedSyncSourceSql`'s weekly branches, the builders' weekly branches and the `src` cache-key argument, the watcher's `readSource` gate) so that after phase 3 nothing can silently read the frozen `asin_weekly_data`. The Step 5 revert is valid only until phase 3. Also: add a label for the `keepa_enqueue` phase in `app/admin/ImportStatusChip.tsx` `humanPhase()`, and add one line to the import email ("Keepa queue: +N new ASINs" or "not updated (code) — run scripts/fireEnqueueWeek.ts") since the enrichment emails go.

Also remove both `keepa_enrichment_runs` probes (the service's `oldJobRunning` and the watcher's hold) in the same push, and never drop or archive that table before they are gone: with the table missing the service fails closed (ten database failures, exit, restart loop) and the watcher tick throws before it decides anything, so not even a "down" alarm would go out.

### Task 14, amended runbook

- **Step 1 (apply 0050 + seed):** pick a quiet hour; run `scripts/checkActiveJobs.ts` first (no import mid-phase, no old enrichment run); note how long the enqueue step takes (the weekly hook runs the same statements inside the import); expect 10–30+ minutes with silences during steps 1–3; the script prints the server-side timeouts, DDL assertions, the seed counts and gates. Failure codes to expect: 57014 (timeout), 55P03 (lock), 40P01 (deadlock), 53100/53400 (temp space) → re-run, it is idempotent. Expected: `tier1_in_scope` ≈ 1,003,344; `tier1_never_fetched` ≈ 715k + legacy error-only ASINs; `earliest_tier1_due` months back (expected); `snapshots` > 356k. Never re-run the script after the service is live.
- **Step 2 (integration tests, owner's go):** `RUN_INTEGRATION=1 pnpm vitest run tests/integration/keepaService.test.ts` (service stopped, no enqueue running; briefly claims/releases real rows) and `RUN_INTEGRATION=1 pnpm vitest run tests/integration/keepaWatcher.test.ts` (between quarter-hours).
- **Step 3 (phase-1 push):** after the deploys, Railway logs of the new service show `listening`, `token_status`, `server_statement_timeout`, then `batch` lines about every 48 s; the health endpoint returns 200 `{"ok":true,"service":"keepa-service",…}`; the worker boot log lists 13 functions; the admin card's "Tier 1 never fetched" falls. **Fire drill:** stop the Railway Keepa service for ~20 minutes → "Keepa service down" email (check spam) → start it → "Keepa service recovered"; look for the `sigterm` log line on the first redeploy (it appears only if Railway's draining seconds are above 0). **First-run checklist:** the two Railway variables must be set before the push; confirm the Keepa service log shows `[keepa-svc] listening` (worker boot lines mean the wrong start command); if a weekly import lands between the seed and the push, run `FIRE_ENQUEUE_WEEK=<week> node --env-file=.env.local --import tsx scripts/fireEnqueueWeek.ts` once the service is up; the first batches run back to back (the bucket starts full); the fire drill is what proves the cron.
- **Step 4 (shadow week):** target = "Tier 1 stale (fetched > 8 days ago)" ≈ 0 with any remainder explained by "Tier 1 in error backoff" (not the oldest-fetch age); never-fetched tier 1 reaches 0 in ~4.5 days; after the weekly import the worker log shows `[keepa-enqueue] week …: inserted=… updated=… retired=… vacuumed=…` and the card's scope week moves. Spot-check 10 ASINs old vs new. After the weekly import the service log shows `yield_old_job` for the old job's run (a few hours) and then `resume_after_old_job`; the old job must show no 429s: `SELECT count(*) FROM asin_weekly_data WHERE week_end_date = '<week>' AND error_message LIKE 'Keepa HTTP 429%'` must be 0 (the old job never writes `keepa_tokens_exhausted`; the service side is the status row's `last_error_code`). Never press the admin full-refresh button while the service runs (the service would idle for the whole ~23-hour run).
- **Step 5 (flag flip):** first run the read-only pre-flip check `node --env-file=.env.local --import tsx scripts/diagKeepaReaders1005.ts` (EXPLAIN of the catalog staging/sync and builder queries, the detail query for one keyword, and the sizing count of non-active ASINs that once had an active weekly row); flip on a non-import day; set `KEEPA_READ_SOURCE=products` on Vercel AND redeploy Production, set it on the Railway worker (it redeploys; run `checkActiveJobs.ts` first); smoke: a detail page for a freshly fetched ASIN, the explorer's avg-price sort after the next nightly sync (log `phase=1 done: N active-or-fetched catalog rows`), the category builder's departments plus one drill-down and one "Add all of X". Revert = `weekly` + redeploys (valid only until phase 3).
- **Step 6 (phase-3 push):** after one weekly import has gone through with both paths; Task 13 as amended.

**Results**

| Step | Date | Outcome | Notes |
|---|---|---|---|
| 0050 applied + seeded | | | |
| Integration tests (service, watcher) | | | |
| Phase 1 push + first batches + fire drill | | | |
| Shadow week | | | |
| Pre-flip check + flag flip | | | |
| Phase 3 push | | | |

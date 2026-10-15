# Keepa Old Import-Time Job Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the old import-time Keepa enrichment job (arc 6's "phase 3") now that every reader runs on the Keepa service's catalog: copy its post-seed fetches into the snapshot table, delete the job, its trigger, its guards, the reader flag and the weekly branches, and turn the admin page into the service's page.

**Architecture:** The spec is `docs/superpowers/specs/2026-10-15-keepa-old-job-retirement-design.md` (72bd60f). One owner-gated DML backfill first (untracked script, never run by an implementer), then five code tasks ordered so the tree builds and the whole suite is green after every commit: the admin page stops using the button (Task 2) before the button is deleted (Task 3); the service and watcher lose the old-job guards (Task 4) before the flag leaves the watcher's inputs (Task 5). Nothing is dropped from the database: `asin_weekly_data` and `keepa_enrichment_runs` stay as an archive with their schema files.

**Tech Stack:** Next 16 (read `node_modules/next/dist/docs/` before touching page code), TypeScript, vitest + React Testing Library, pg, Inngest, the Keepa service under `services/keepa`.

**Conventions (every task):** commit trailer exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; local commits on `main` only, never push (the push is Task 6, owner-gated: `scripts/checkActiveJobs.ts` first, bare `git push origin main`); `git add` / `git rm` named files only, never `-A` or `.` (the tree holds untracked throwaway scripts); lint touched files only with `pnpm exec eslint <files>` (whole-project lint fails on untracked scripts); `pnpm typecheck` covers tests and untracked scripts; the tree mixes CRLF/LF, so edit with exact-match tools and never convert line endings; vitest never type-checks, so keep type-only pins; log-safe errors (never a database error's `.message`; `errFields` from `@/lib/ask/logSafe`); never print member emails; no DDL. Never set `RUN_INTEGRATION`, never connect to a database from a task (`.env.local` points at production). Quote paths with parentheses (`"app/(app)/..."`) in shell commands.

---

## File structure

| Path | Role in this arc |
|---|---|
| `scripts/backfillSnapshotsFromWeekly1015.ts` (UNTRACKED) | Task 1: the owner-gated backfill of post-seed fetches into `asin_snapshots` |
| `app/admin/keepa-enrichment/page.tsx`, `page.test.tsx`, `ServiceStatusCard.tsx`, `ServiceStatusCard.test.tsx`, `app/admin/layout.tsx` | Task 2: the service's page (card only, 7-day average row, link label) |
| `inngest/functions/importFile.ts` (+ `importFile.test.ts`), `inngest/functions/enrichKeepaForWeek.ts`, `inngest/functions/index.ts`, `worker/keepaJobs.ts`, `lib/keepa/client.ts`, `lib/keepa/parse.ts` (+ test), `lib/keepa/types.ts`, `app/api/admin/keepa-enrichment/fire-full/route.ts`, `app/admin/keepa-enrichment/KeepaEnrichmentButton.tsx`, `lib/notifications/buildEnrichmentEmail.ts` (+ test), `lib/notifications/sendEnrichmentEmail.ts` (+ test), `scripts/fireEnrichWeek.ts`, `scripts/fireKeepaEnrichment.ts`, `scripts/keepaSmokeTest.ts`, `scripts/checkKeepaProgress.ts` | Task 3: the job, its trigger, its tooling |
| `services/keepa/loop.ts` (+ `loop.test.ts`), `services/keepa/store.ts`, `services/keepa/pgStore.ts` (+ test), `services/keepa/index.ts`, `services/keepa/README.md`, `lib/keepa/watcherRules.ts` (+ test), `inngest/functions/keepaServiceWatcher.ts` (+ test) | Task 4: the guards |
| `lib/keepa/readSource.ts` (+ test), `lib/explorer/fetchKeywordDetail.ts`, `lib/explorer/enrichedProductsQuery.test.ts`, `lib/categoryBuilder/loadTree.ts`, `inngest/functions/refreshSummary.ts`, `inngest/functions/enrichedSourceSql.test.ts`, `worker/kcsKeepaSyncJobs.ts`, `lib/keepa/watcherRules.ts` (+ test), `inngest/functions/keepaServiceWatcher.ts` (+ test), `tests/integration/keepaWatcher.test.ts`, `lib/research/categories.ts`, `db/schema/asinWeeklyData.ts`, `db/schema/keepaEnrichmentRuns.ts` | Task 5: one source; the archive comments |
| `docs/superpowers/plans/2026-10-15-keepa-old-job-retirement.md` | this plan; Task 6's Results table |

Facts verified while planning (2026-10-15): `.env.example` does not list `KEEPA_READ_SOURCE` (nothing to change there; the spec's §3.3 is amended in Task 6's docs commit); the watcher's tick log carries no source field — the flag lives in `WatcherTickDeps.readSource`, `WatcherInput.readSource` and the two sync guards, which Task 5 removes; `lib/keepa/types.ts` turned out to have no importers once the job was gone (the product pages take `AsinEnrichmentStatus` from `db/schema`), so Task 3's review round deleted it, as the spec says; the card's heading is already "Keepa service", so Task 2 renames it "Service status" under the page's new "Keepa service" heading.

---

### Task 1: The backfill script (written here, run by the owner only)

**Files:**
- Create: `scripts/backfillSnapshotsFromWeekly1015.ts` (UNTRACKED: never `git add` it)

- [ ] **Step 1: Write the script**

```ts
// scripts/backfillSnapshotsFromWeekly1015.ts (UNTRACKED — run only on the owner's go; spec 2026-10-15 §2.1)
/**
 * Copies the old import-time job's post-seed fetches from asin_weekly_data into asin_snapshots with the
 * seed's own statement (scripts/applyMigration0050.ts, seed 3/4). The cutoff, enriched_at on or after
 * 2026-10-06 00:00, is the start of the day the arc-6 seed ran (~18:40 UTC): the window overlaps the seed
 * on purpose, since those fetches already have snapshots and ON CONFLICT skips them, while a cutoff after
 * the seed would lose fetches. Run it with no import and no old-job run in flight
 * (scripts/checkActiveJobs.ts clean). Idempotent: ON CONFLICT DO NOTHING against the snapshot table's
 * primary key (asin, fetched_at). Prints the count of post-seed fetches with no snapshot before and after;
 * accept the run when the after-count is 0 and the inserted count equals the before-count.
 * Run: BACKFILL_SNAPSHOTS=yes node --env-file=.env.local --import tsx scripts/backfillSnapshotsFromWeekly1015.ts
 */
import { Client } from 'pg';

const SEED_CUTOFF = '2026-10-06';
const MISSING_SQL = `
  SELECT count(*)::int AS missing
  FROM (SELECT DISTINCT a.asin, a.enriched_at FROM asin_weekly_data a
        WHERE a.enriched_at >= $1::date AND a.enrichment_status IN ('active', 'no_price')) f
  WHERE NOT EXISTS (SELECT 1 FROM asin_snapshots s WHERE s.asin = f.asin AND s.fetched_at = f.enriched_at)`;

if (process.env.BACKFILL_SNAPSHOTS !== 'yes') { console.error('Refusing to run: set BACKFILL_SNAPSHOTS=yes'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Refusing to run: DATABASE_URL is not set'); process.exit(1); }
const code = (e: unknown) => (e as { code?: string })?.code ?? (e instanceof Error ? e.name : 'unknown');

(async () => {
  const t0 = Date.now(); const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  const c = new Client({ connectionString: process.env.DATABASE_URL, keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
  c.on('error', () => undefined);
  await c.connect();
  const countMissing = async (): Promise<number> => {
    await c.query('BEGIN READ ONLY');
    try {
      await c.query("SET LOCAL statement_timeout = '600s'");
      const n = (await c.query<{ missing: number }>(MISSING_SQL, [SEED_CUTOFF])).rows[0].missing;
      await c.query('COMMIT');
      return n;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  };
  try {
    const before = await countMissing();
    log(`post-seed fetches without a snapshot before: ${before}`);
    if (before === 0) log('nothing to copy (already backfilled)');
    log('copying post-seed fetches into asin_snapshots (two more scans of the archive table, the copy and the after-count: a minute or more each is normal)');
    await c.query('BEGIN');
    let inserted: number;
    try {
      await c.query("SET LOCAL work_mem = '256MB'");
      await c.query("SET LOCAL statement_timeout = '600s'");
      const r = await c.query(
        `INSERT INTO asin_snapshots (asin, fetched_at, current_price_cents, sales_rank, review_count, average_rating_x10, enrichment_status)
         SELECT DISTINCT ON (a.asin, a.enriched_at)
           a.asin, a.enriched_at, a.current_price_cents, a.sales_rank, a.review_count, a.average_rating_x10, a.enrichment_status
         FROM asin_weekly_data a
         WHERE a.enriched_at >= $1::date AND a.enrichment_status IN ('active', 'no_price')
         ORDER BY a.asin, a.enriched_at, a.week_end_date DESC
         ON CONFLICT DO NOTHING`,
        [SEED_CUTOFF],
      );
      inserted = r.rowCount ?? 0;
      await c.query('COMMIT');
      log(`committed: ${inserted} snapshot rows inserted`);
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
    const after = await countMissing();
    log(`inserted ${inserted} snapshot rows; post-seed fetches without a snapshot after: ${after}`);
    const accepted = after === 0 && inserted === before;
    log(accepted ? 'backfill accepted' : 'CHECK: counts do not match (re-run is safe; if an import or the old Keepa job is running, re-run after it finishes)');
    if (!accepted) process.exitCode = 1;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('failed:', code(e)); process.exit(1); });
```

- [ ] **Step 2: Lint and type-check it (no run)**

Run: `pnpm exec eslint scripts/backfillSnapshotsFromWeekly1015.ts && pnpm typecheck`
Expected: no output from eslint; `tsc --noEmit` exits 0.

- [ ] **Step 3: Confirm it is untracked and stays so**

Run: `git status --short scripts/backfillSnapshotsFromWeekly1015.ts`
Expected: `?? scripts/backfillSnapshotsFromWeekly1015.ts`. No commit in this task.

---

### Task 2: The admin page becomes the service's page; the card's 7-day average

**Files:**
- Modify: `app/admin/keepa-enrichment/page.tsx` (whole file below)
- Modify: `app/admin/keepa-enrichment/page.test.tsx:43-66`
- Modify: `app/admin/keepa-enrichment/ServiceStatusCard.tsx:31` (heading) and `:64` (the fetched row)
- Modify: `app/admin/keepa-enrichment/ServiceStatusCard.test.tsx:42` (+ any heading pin)
- Modify: `app/admin/layout.tsx:40-42` (link label)

Read `node_modules/next/dist/docs/01-app/02-guides/authentication.md` ("Layouts and auth checks") before editing the page: the page-level `requireAdmin()` gate stays exactly as it is.

- [ ] **Step 1: Write the failing tests**

In `app/admin/keepa-enrichment/page.test.tsx`, replace the three admin cases (lines 43–66; keep the non-admin redirect case and the mocks above them) with:

```tsx
  it('renders the service page for an admin: one heading, the status card, no controls, no run list', async () => {
    render(await KeepaEnrichmentAdminPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Keepa service' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Service status' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Manual full refresh' })).toBeNull();
    expect(screen.queryByText('No runs yet.')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(dbm.select).toHaveBeenCalledTimes(1); // the explorer week only: the run list is gone
    expect(overviewMock.load).toHaveBeenCalledWith(null);
  });

  it('reads the explorer week once and hands it to the overview loader', async () => {
    dbm.select.mockReturnValue({ from: () => ({ limit: async () => [{ currentWeekEndDate: '2026-10-03' }] }) });
    render(await KeepaEnrichmentAdminPage());
    expect(overviewMock.load).toHaveBeenCalledWith('2026-10-03');
    expect(dbm.select).toHaveBeenCalledTimes(1);
  });

  it('degrades the status card to one line when the overview loader fails, and keeps the page', async () => {
    overviewMock.load.mockRejectedValue(Object.assign(new Error('relation "asin_products" does not exist'), { code: '42P01' }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(await KeepaEnrichmentAdminPage());
    expect(screen.getByText('Service status unavailable (42P01)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Keepa service' })).toBeInTheDocument();
    expect(logged).toHaveBeenCalledWith('[keepa-admin] overview failed', JSON.stringify({ error: 'Error', code: '42P01' }));
    logged.mockRestore();
  });
```

(If the file's `dbm.select` default mock still returns an `orderBy` branch for the run list, leave it: an unused branch does not fail a test.)

In `app/admin/keepa-enrichment/ServiceStatusCard.test.tsx` change line 42 to:

```ts
    expect(valueOf('Fetched last 24 h')).toBe('160,000 · 7-day average 128,571 per day');
```

(900,000 / 7 = 128,571.4, rounded.) If the file pins the heading text `'Keepa service'`, change that pin to `'Service status'`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run app/admin/keepa-enrichment`
Expected: the three page cases and the fetched-row case fail (`Manual full refresh` still rendered; `160,000` without the average).

- [ ] **Step 3: Rewrite the page**

Replace the whole of `app/admin/keepa-enrichment/page.tsx` with:

```tsx
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { redirect } from 'next/navigation';
import { db } from '@/db/client';
import { keywordCurrentSummaryMeta } from '@/db/schema';
import { loadKeepaServiceOverview, type KeepaServiceOverview } from '@/lib/admin/keepaServiceOverview';
import { errFields } from '@/lib/ask/logSafe';
import { ServiceStatusCard } from './ServiceStatusCard';

export const dynamic = 'force-dynamic';

/**
 * The Keepa service's admin page (spec 2026-10-15 §5): the status card and nothing else. The old
 * import-time job's full-refresh button and run list went with the job (arc 11); the service refreshes
 * every tier-1 product on its own 7-day cycle. The route path stays /admin/keepa-enrichment.
 */
export default async function KeepaEnrichmentAdminPage() {
  // Page-level gate, mirroring app/admin/ask-ai/page.tsx: Next 16 renders layouts and pages in
  // parallel, and a client-sent Next-Router-State-Tree can claim the /admin layout already ran, so
  // app/admin/layout.tsx's requireAdmin() is not a guaranteed gate on its own (vendored docs,
  // 01-app/02-guides/authentication.md, "Layouts and auth checks"). Checked here before any data read.
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer');
    throw e;
  }
  const [meta] = await db.select().from(keywordCurrentSummaryMeta).limit(1);
  // The status card is best-effort: a failed read degrades to one line on the card instead of taking
  // the page down. Coded fields only in the log, never a message.
  let overview: KeepaServiceOverview | null = null;
  let overviewError: string | null = null;
  try {
    overview = await loadKeepaServiceOverview(meta?.currentWeekEndDate ?? null);
  } catch (e) {
    const { error, code } = errFields(e);
    console.error('[keepa-admin] overview failed', JSON.stringify({ error, code }));
    overviewError = code ?? error;
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">Keepa service</h1>
      <p className="mt-2 text-gray-600">
        Always-on enrichment on its own Railway service: every tier-1 product is refreshed on a 7-day
        cycle and new products are fetched within a day of the weekly import. The watcher emails when the
        service is down or stalled.
      </p>
      <ServiceStatusCard overview={overview} error={overviewError} now={new Date()} />
    </div>
  );
}
```

In `app/admin/keepa-enrichment/ServiceStatusCard.tsx`:
- line 31: `<h2 id="keepa-service-heading" className="text-sm font-semibold text-slate-900">Keepa service</h2>` → the text `Service status` (the id stays).
- line 64: `['Fetched last 24 h', fmt(counts.fetchedLast24h)],` → `['Fetched last 24 h', `${fmt(counts.fetchedLast24h)} · 7-day average ${fmt(Math.round(counts.fetchedLast7d / 7))} per day`],`

In `app/admin/layout.tsx` lines 40–42 the link text `Keepa enrichment` → `Keepa service` (the href stays `/admin/keepa-enrichment`). If `app/admin/layout.test.tsx` pins the label, update that pin.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run app/admin/keepa-enrichment app/admin` then `pnpm exec eslint "app/admin/keepa-enrichment/page.tsx" "app/admin/keepa-enrichment/page.test.tsx" "app/admin/keepa-enrichment/ServiceStatusCard.tsx" "app/admin/keepa-enrichment/ServiceStatusCard.test.tsx" app/admin/layout.tsx` then `pnpm typecheck`
Expected: all green; eslint silent; tsc exits 0. (`KeepaEnrichmentButton.tsx` still exists and compiles on its own; Task 3 deletes it.)

- [ ] **Step 5: Commit**

```bash
git add "app/admin/keepa-enrichment/page.tsx" "app/admin/keepa-enrichment/page.test.tsx" "app/admin/keepa-enrichment/ServiceStatusCard.tsx" "app/admin/keepa-enrichment/ServiceStatusCard.test.tsx" app/admin/layout.tsx
git commit -m "feat(admin): the Keepa page is the service's page — status card only, with the 7-day average per day on the fetched row" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Include `app/admin/layout.test.tsx` in the add if it changed.)

---

### Task 3: Remove the old job, its trigger and its tooling

**Files:**
- Modify: `inngest/functions/importFile.ts:1215-1242` (delete the block), `inngest/functions/importFile.test.ts` (one pin), `inngest/functions/index.ts` (one import + one entry), `lib/keepa/types.ts` (trim)
- Delete: `inngest/functions/enrichKeepaForWeek.ts`, `worker/keepaJobs.ts`, `lib/keepa/client.ts`, `lib/keepa/parse.ts`, `lib/keepa/parse.test.ts`, `app/api/admin/keepa-enrichment/fire-full/route.ts`, `app/admin/keepa-enrichment/KeepaEnrichmentButton.tsx`, `lib/notifications/buildEnrichmentEmail.ts`, `lib/notifications/buildEnrichmentEmail.test.ts`, `lib/notifications/sendEnrichmentEmail.ts`, `lib/notifications/sendEnrichmentEmail.test.ts`, `scripts/fireEnrichWeek.ts`, `scripts/fireKeepaEnrichment.ts`, `scripts/keepaSmokeTest.ts`, `scripts/checkKeepaProgress.ts`

- [ ] **Step 1: Write the failing test**

`inngest/functions/importFile.test.ts` already mocks the Inngest client (search the file for `inngest` to find the captured `send` calls; the suite names the mock near its top). In the existing successful-import case (the one that asserts the summary refresh ran and the import ended `completed`), add:

```ts
    expect(sentEventNames()).not.toContain('keepa.enrich-week-requested');
```

where `sentEventNames()` is a one-line helper beside the other helpers that maps the mocked `send` calls to their `name` fields, e.g. `const sentEventNames = () => sendMock.mock.calls.map(([e]) => (e as { name: string }).name);` with `sendMock` being the file's existing mock of `inngest.send`. If the file already exposes such a helper, use it.

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm vitest run inngest/functions/importFile.test.ts`
Expected: that case fails (`keepa.enrich-week-requested` is still sent).

- [ ] **Step 3: Delete the trigger block**

In `inngest/functions/importFile.ts` delete, from the line `    // Trigger Keepa enrichment for the new current week. Long-running` through the closing `    }` of the statement `if (!isReplay && summaryRefreshOk && refreshResult?.currentWeekEndDate) {` (the `inngest.send({ name: 'keepa.enrich-week-requested', … })` block and its try/catch; lines 1215–1242 at HEAD). Leave the surrounding `.where(eq(uploadedFiles.id, file.id));` and the `// Notify admins via email` block untouched. The `keepa_enqueue` phase earlier in the file stays.

- [ ] **Step 4: Delete the job and its tooling; trim the shared types**

```bash
git rm inngest/functions/enrichKeepaForWeek.ts worker/keepaJobs.ts lib/keepa/client.ts lib/keepa/parse.ts lib/keepa/parse.test.ts "app/api/admin/keepa-enrichment/fire-full/route.ts" "app/admin/keepa-enrichment/KeepaEnrichmentButton.tsx" lib/notifications/buildEnrichmentEmail.ts lib/notifications/buildEnrichmentEmail.test.ts lib/notifications/sendEnrichmentEmail.ts lib/notifications/sendEnrichmentEmail.test.ts scripts/fireEnrichWeek.ts scripts/fireKeepaEnrichment.ts scripts/keepaSmokeTest.ts scripts/checkKeepaProgress.ts
```

In `inngest/functions/index.ts` remove `import { enrichKeepaForWeek } from './enrichKeepaForWeek';` and the `enrichKeepaForWeek,` entry of `functions`.

Replace the whole of `lib/keepa/types.ts` with:

```ts
/**
 * The enrichment outcome of a catalog row (mirrors the db enum asin_enrichment_status). The Keepa
 * service (services/keepa, lib/keepa/parseProduct.ts) writes it; the product pages read it. The old
 * import-time job's request/row types left with that job (arc 11).
 */
export type AsinEnrichmentStatus = 'active' | 'no_price' | 'delisted' | 'error';
```

Then: `git grep -n "keepaJobs\|enrichKeepaForWeek\|sendEnrichmentEmail\|buildEnrichmentEmail\|lib/keepa/client\|lib/keepa/parse'\|fire-full\|KeepaEnrichmentButton\|EnrichmentRow\|KeepaProductResponse" -- app lib inngest worker services scripts tests db` must show no import hits; comment-only hits may remain in the files Tasks 4 and 5 own (`services/keepa/store.ts`, `worker/kcsKeepaSyncJobs.ts`, the two archive schema files) and in the applied migrations' COMMENT literals; fix any other hit (a stale import or comment) before continuing.

- [ ] **Step 5: Run the gates**

Run: `pnpm typecheck && pnpm vitest run inngest/functions/importFile.test.ts lib/keepa lib/notifications app/admin && pnpm exec eslint inngest/functions/importFile.ts inngest/functions/importFile.test.ts inngest/functions/index.ts lib/keepa/types.ts`
Expected: tsc exits 0 (the deleted modules had no other importers); the suites green; eslint silent.

- [ ] **Step 6: Commit**

```bash
git add inngest/functions/importFile.ts inngest/functions/importFile.test.ts inngest/functions/index.ts lib/keepa/types.ts
git commit -m "chore(keepa): retire the old import-time enrichment job — no event after the import, orchestrator, worker job, old client/parser, full-refresh route and button, enrichment emails and helper scripts removed" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(The `git rm` of Step 4 already staged the deletions.)

---

### Task 4: The service and the watcher stop deferring to the old job

**Files:**
- Modify: `services/keepa/loop.ts` (lines 40–44, 82–83, 97–98, 86, 129–162, 213–225, 256–258, 276–285), `services/keepa/loop.test.ts` (the fake store at line 53, the seven old-job cases at lines 84–215), `services/keepa/store.ts:35-41`, `services/keepa/pgStore.ts:277-292`, `services/keepa/pgStore.test.ts:299-306`, `services/keepa/index.ts` (the `'yielded'` branch, if any), `services/keepa/README.md` (lines 21, 23, 30, 55–57), `lib/keepa/lanes.ts:23-26` (the `TOKEN_RESERVE` doc comment), `tests/integration/keepaService.test.ts:146-149` (the `oldJobRunning` case; the file self-skips without `RUN_INTEGRATION` and is never run here)
- Modify: `lib/keepa/watcherRules.ts` (the `oldJobRecentlyLive` input, `stallHeld`, the `old_job_recent` reason), `lib/keepa/watcherRules.test.ts` (base input line 24, the cases at lines 130–150 and 313), `inngest/functions/keepaServiceWatcher.ts:104-115` and the input field, `inngest/functions/keepaServiceWatcher.test.ts` (the `oldJob` harness option and the cases at lines 198–207)

- [ ] **Step 1: Write the failing tests**

`services/keepa/loop.test.ts`: delete the seven cases titled
`'yields while the old enrichment job runs: …'`, `'resumes once the old job is done: …'`, the case at line ~118 whose store throws from `oldJobRunning` (`stage: 'old_job_probe'`), `'a failed heartbeat while yielding counts as a database failure (stage heartbeat)'`, `'a completed yield tick resets the database-failure count'`, `'an old run that starts after the claim: …'`, `'re-probes before every retry: …'`, the second `old_job_probe` case at line ~188, and `'a failed claim release while yielding mid-batch is logged; …'`; remove `oldJobRunning: async () => { calls.push('probe'); return false; },` from `makeStore`. Then add one case next to `'claims, fetches once, parses and writes a batch, then reports it'`:

```ts
  it('never probes the old enrichment job: claim follows the stale release directly', async () => {
    const store = makeStore([[row('B1')]]);
    const deps = makeDeps(store, async (asins) => reply(asins));
    await expect(runIteration(deps, initialState())).resolves.toBe('batch');
    expect(store.calls.slice(0, 2)).toEqual(['release', 'claim']);
    expect(deps.logs.map((l) => l.event)).not.toContain('yield_old_job');
  });
```

(`store.calls` is the fake's call log; if the fake exposes it under another name, use that name. Any existing case that asserted a `'probe'` entry in the call order loses that entry.)

`services/keepa/pgStore.test.ts`: delete the case `'oldJobRunning is one plain read of the old job\'s runs table: …'` (lines 299–306).

`lib/keepa/watcherRules.test.ts`: remove `oldJobRecentlyLive: false,` from `base` (line 24); delete the two cases that set `oldJobRecentlyLive: true` (the one around line 130 and the `justFinished` one around lines 147–150) and the `heldReasons({ ...done, oldJobRecentlyLive: true })` assertion at line 313.

`inngest/functions/keepaServiceWatcher.test.ts`: remove the `oldJob?: boolean;` option (lines 55–56) and the `if (text.includes('FROM keepa_enrichment_runs')) …` line of the fake query (line 73); delete the two cases at lines 198–207 that pass `oldJob: true` (the held-stall case and the down case); add to the existing case that lists the tick's statements (the one asserting `calls[3]` or the statement order):

```ts
    expect(held.calls.map((c) => c.text).join('\n')).not.toContain('keepa_enrichment_runs');
```

adapting the variable name to that case's harness.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run services/keepa lib/keepa inngest/functions/keepaServiceWatcher.test.ts`
Expected: the new loop case fails (`'probe'` precedes `'claim'`; `makeStore` lacks `oldJobRunning` so the typed fake no longer matches at runtime — vitest does not type-check, so the failure shows as the loop calling an undefined method); the watcher statement pin fails.

- [ ] **Step 3: Remove the guard from the service loop**

In `services/keepa/loop.ts`:
- delete lines 40–44: the doc comment and `export const OLD_JOB_YIELD_SLEEP_MS = 60_000;`
- in `LoopState` delete the comment and field `yieldingToOldJob: boolean;` (lines 82–83) and in `initialState()` the line `yieldingToOldJob: false,`
- `export type IterationResult = 'batch' | 'idle' | 'yielded' | 'keepa_error' | 'db_error' | 'threw';` → drop `'yielded'`
- delete the whole `probeOldJob` function with its doc comment (lines 129–153) and the whole `releaseOwnClaimsQuietly` function with its doc comment (lines 155–162)
- delete the pre-claim block (lines 213–225): the comment `// Before claiming: while an old enrichment run is live, idle …`, `const beforeClaim = await probeOldJob(deps, state);`, and the two `if` statements that follow it, up to and including `return 'yielded';` and its closing `}`
- inside the retry loop delete the comment block starting `// Before EVERY request: an old run may have started …` and the lines `const beforeFetch = await probeOldJob(deps, state);`, `if (beforeFetch === 'db_error') return 'db_error';`, and the `if (beforeFetch === 'old_job') { await releaseOwnClaimsQuietly(deps); return 'yielded'; }` block (lines 276–285), so the loop body begins at `try { reply = await deps.keepa.fetchBatch(asins); }`.
- lines 256–258 (the pacing comment that names the old job's two-token calls during the shadow week): reword to `// Pace on Keepa's once-a-minute refill and leave TOKEN_RESERVE in the bucket after the batch as a margin against Keepa's own rounding.` keeping the rest of that comment's content; give `lib/keepa/lanes.ts:23-26` (the `TOKEN_RESERVE` doc comment) the same rationale (`/** Tokens left in the bucket after a batch as a margin against Keepa's own rounding. */`-style, matching the file's comment style).
- `tests/integration/keepaService.test.ts`: delete the case at lines 146–149 that calls `store.oldJobRunning()` (and any helper only it used); do not run the file.
- `grep -n "yielded\|old_job\|OldJob\|shadow week" services/keepa/loop.ts lib/keepa/lanes.ts tests/integration/keepaService.test.ts` must print nothing.

In `services/keepa/store.ts` delete the doc comment and the method `oldJobRunning(): Promise<boolean>;` (lines 35–41). In `services/keepa/pgStore.ts` delete the `async oldJobRunning()` method with its comment (lines 277–292). In `services/keepa/index.ts`, if any branch handles the `'yielded'` iteration result (search `'yielded'`), remove that branch (the loop no longer returns it).

In `services/keepa/README.md`:
- line 21: `… release claims older than ten minutes → probe the old enrichment job (yield while it runs) → claim up to 100 due ASINs …` → `… release claims older than ten minutes → claim up to 100 due ASINs …`, and `→ wait for tokens → probe again (before every request, retries included) → one Keepa request` → `→ wait for tokens → one Keepa request`
- line 23: the clause `and keeps `TOKEN_RESERVE` (50) tokens in the bucket after a batch so the old import-time job's two-token calls (its per-ASIN requests cost 2 tokens) never find it empty during the shadow week` → `and keeps `TOKEN_RESERVE` (50) tokens in the bucket after a batch as a margin against Keepa's own rounding` (the constant stays: no behaviour change)
- delete the whole bullet at line 30 (`**Shares the Keepa token bucket with the old import-time enrichment job until phase 3:** …`)
- delete the three event rows `yield_old_job`, `resume_after_old_job`, `release_own_claims_failed` (lines 55–57)

- [ ] **Step 4: Remove the hold from the watcher**

In `lib/keepa/watcherRules.ts`: delete the `oldJobRecentlyLive` field and its doc comment from `WatcherInput`; delete `'old_job_recent'` from `HeldReason`; in `decideWatcherActions` delete the two comment lines about the old job and the line `const stallHeld = i.oldJobRecentlyLive;`, then simplify `const stalled = !down && !stallHeld && i.dueWorkExists && …` to `const stalled = !down && i.dueWorkExists && stallSince !== null && age(stallSince) > STALL_AFTER_MS;` and `const stallCleared = !stallHeld && !!i.stallAlarmSentAt;` to `const stallCleared = !!i.stallAlarmSentAt;`; in `heldReasons` delete `if (i.oldJobRecentlyLive) held.add('old_job_recent');` and drop `the stall alarm held: old_job_recent.` from its doc comment.

In `inngest/functions/keepaServiceWatcher.ts`: delete the comment block and the `keepa_enrichment_runs` read (lines 104–115, from `// Until phase 3 the service yields …` through `const oldJobRecentlyLive = oldJob[0]?.running ?? false;`) and the `oldJobRecentlyLive,` line of the `WatcherInput` literal.

- [ ] **Step 5: Run the gates**

Run: `pnpm typecheck && pnpm vitest run services/keepa lib/keepa inngest/functions/keepaServiceWatcher.test.ts && pnpm exec eslint services/keepa/loop.ts services/keepa/loop.test.ts services/keepa/store.ts services/keepa/pgStore.ts services/keepa/pgStore.test.ts services/keepa/index.ts lib/keepa/watcherRules.ts lib/keepa/watcherRules.test.ts inngest/functions/keepaServiceWatcher.ts inngest/functions/keepaServiceWatcher.test.ts lib/keepa/lanes.ts tests/integration/keepaService.test.ts`
Expected: tsc exits 0 (once the integration test's case is deleted, `oldJobRunning` and `oldJobRecentlyLive` have no remaining user); every suite green; eslint silent. `git grep -n "oldJobRunning\|oldJobRecentlyLive\|old_job\|keepa_enrichment_runs" -- services lib inngest worker app` prints nothing (the schema file `db/schema/keepaEnrichmentRuns.ts` may still name the table; that is the archive).

- [ ] **Step 6: Commit**

```bash
git add services/keepa/loop.ts services/keepa/loop.test.ts services/keepa/store.ts services/keepa/pgStore.ts services/keepa/pgStore.test.ts services/keepa/README.md lib/keepa/watcherRules.ts lib/keepa/watcherRules.test.ts inngest/functions/keepaServiceWatcher.ts inngest/functions/keepaServiceWatcher.test.ts lib/keepa/lanes.ts tests/integration/keepaService.test.ts
git commit -m "chore(keepa): the service no longer yields to the old job and the watcher no longer holds its stall alarm for it" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Add `services/keepa/index.ts` if it changed.)

---

### Task 5: One source — the flag and the weekly branches go; the archive is marked

**Files:**
- Delete: `lib/keepa/readSource.ts`, `lib/keepa/readSource.test.ts`
- Modify: `lib/explorer/fetchKeywordDetail.ts:230-290` (`enrichedProductsFor`), `lib/explorer/enrichedProductsQuery.test.ts` (the `enrichedProductsFor` describe), `lib/categoryBuilder/loadTree.ts` (header + the three builders), `inngest/functions/refreshSummary.ts:717-795` (`stageEnrichedAsinsSql`, `stageEnrichedAsins`), `inngest/functions/enrichedSourceSql.test.ts`, `worker/kcsKeepaSyncJobs.ts:7-17,38,47-83,134-141`, `lib/keepa/watcherRules.ts` (`readSource` in `WatcherInput`, the sync guards, `syncCouldFire`, `heldReasons`), `lib/keepa/watcherRules.test.ts`, `inngest/functions/keepaServiceWatcher.ts` (`WatcherTickDeps.readSource`, the call sites), `inngest/functions/keepaServiceWatcher.test.ts`, `tests/integration/keepaWatcher.test.ts` (the `readSource` argument in three calls), `lib/research/categories.ts:18`, `db/schema/asinWeeklyData.ts` (header), `db/schema/keepaEnrichmentRuns.ts` (header)

- [ ] **Step 1: Write the failing tests**

`lib/explorer/enrichedProductsQuery.test.ts`: replace the `statementFor` helper and the `describe('enrichedProductsFor', …)` block with:

```ts
/** The statement enrichedProductsFor builds (one source since arc 11: the catalog). */
async function statement(): Promise<Captured> {
  return (await enrichedProductsFor(fakeSql, '42')) as unknown as Captured;
}

describe('enrichedProductsFor', () => {
  it('reads the catalog with the new fields, no week predicate, skipping rows with no outcome', async () => {
    const q = await statement();
    expect(q.text).toContain('FROM asin_products a');
    expect(q.text).not.toContain('asin_weekly_data');
    expect(q.text).not.toContain('a.week_end_date');
    expect(q.text).toContain('a.monthly_sold');
    expect(q.text).toContain('a.fba_offer_count');
    expect(q.text).toContain('a.enrichment_status IS NOT NULL');
    expect(q.values).toEqual(['42']);
  });

  it('names only real catalog columns', async () => {
    const q = await statement();
    expect(aliasColumns(q.text).size).toBeGreaterThan(10);
    expect(missingFrom(aliasColumns(q.text), dbColumns(asinProducts))).toEqual([]);
  });
});
```

Drop the now-unused imports (`afterEach`, `vi` if nothing else uses them, `asinWeeklyData`, `selectList`); keep the `mapEnrichedProducts` describe as it is (the "null when a weekly row lacks them" case keeps its name: it pins the mapper on a row without the new fields, which a delisted catalog row still is).

`inngest/functions/enrichedSourceSql.test.ts`: the builders lose their source parameter. Change `build('products', WEEK)` to `build()` in the catalog case and the column case, delete the `weekly:` case (line 36) and the `weekly` half of the column case (lines 45–47 keep only the catalog assertion), and drop the `asinWeeklyData` import. The shared `build` wrapper at the top of the file (it calls `stageEnrichedAsinsSql(source, week)` and `enrichedSyncSourceSql(source, cw)`) becomes `() => stageEnrichedAsinsSql()` and `() => enrichedSyncSourceSql()`.

`lib/keepa/watcherRules.test.ts`: remove `readSource: 'products',` from `base`; delete the `readSource: 'weekly'` assertions at lines 171, 280 and 326; in the grid case (lines 284–289) drop the outer `(['products', 'weekly'] as const).flatMap((readSource) =>` layer and the `readSource,` field of the literal (the grid is then one source wide).

`inngest/functions/keepaServiceWatcher.test.ts`: `harness`'s second parameter becomes `Partial<Pick<WatcherTickDeps, 'now'>>`; the deps literal loses `readSource: 'products',`; delete the `weekly` harness block at lines 166–168 (`const weekly = harness(…, { readSource: 'weekly' }); … expect(readsWeeks(weekly.texts())).toBe(false);`).

`tests/integration/keepaWatcher.test.ts`: remove `readSource: 'weekly',` / `readSource: 'products',` from the three `runWatcherTick(...)` calls (lines 136, 165, 198). The first case's title and assertions stay (an alarm tick never depended on the source).

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run lib/explorer/enrichedProductsQuery.test.ts inngest/functions/enrichedSourceSql.test.ts lib/keepa inngest/functions/keepaServiceWatcher.test.ts`
Expected: the explorer case fails on `vi.stubEnv` no longer setting the source (the default statement still reads `asin_weekly_data`); the SQL-builder cases fail on the arity; the watcher cases fail on the missing `readSource`.

- [ ] **Step 3: Delete the flag module and rewrite the five readers**

```bash
git rm lib/keepa/readSource.ts lib/keepa/readSource.test.ts
```

`lib/explorer/fetchKeywordDetail.ts`: replace the whole `enrichedProductsFor` function (and its doc comment) with:

```ts
/**
 * Keepa facts for a keyword's top-3 ASINs (≤ 3 rows) from the asin_products catalog (spec 2026-10-05
 * §7; the only source since arc 11): no week predicate, the catalog holds one current row per ASIN;
 * rows with no outcome yet (enrichment_status NULL) are skipped. Mapped through mapEnrichedProducts
 * (prices only for active rows, no point-in-time facts for delisted ones).
 */
export function enrichedProductsFor(sql: NeonSql, searchTermId: string) {
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
        AND a.enrichment_status IS NOT NULL
    `;
}
```

Remove the `keepaReadSource` import at the top of the file and reword the two header comments at lines 85 and 847 that mention `KEEPA_READ_SOURCE=products, else asin_weekly_data` to name the catalog only.

`lib/categoryBuilder/loadTree.ts`: remove the `keepaReadSource` import; in each of the three builders drop the `src: KeepaReadSource` parameter and keep only the `asin_products` statement (delete the `src === 'products' ? … : …` ternary and the `asin_weekly_data` branch); the `wk` parameter stays as `_wk` (unused in the SQL now, but part of the cache key, and `loadRootDepartments` still returns `[]` without a week; the underscore keeps the unused-variable lint rule quiet, as `_sv` already does); the three call sites lose the `keepaReadSource()` argument; the header's paragraph `Source table follows KEEPA_READ_SOURCE …` becomes `Reads the in-scope rows of the asin_products catalog (no week); the week stays in the cache key so a weekly refresh rebuilds the tree.` and the last header paragraph's `The catalog variants keep the weekly queries' shape, with the week predicate replaced by in_scope` becomes `The catalog queries keep the original weekly queries' shape, with the week predicate replaced by in_scope`.

`inngest/functions/refreshSummary.ts`: `stageEnrichedAsinsSql` becomes

```ts
/**
 * The asin_enriched_current statement, text and bound values together (pure, pinned against the
 * schema in enrichedSourceSql.test.ts): the catalog's one current row per ASIN in status active,
 * no_price or delisted, priced only when active (see stageEnrichedAsins).
 */
export function stageEnrichedAsinsSql(): { text: string; values: unknown[] } {
  return {
    text: `
    CREATE TEMP TABLE asin_enriched_current ON COMMIT DROP AS
    SELECT
      a.asin,
      CASE WHEN a.enrichment_status = 'active' THEN a.current_price_cents END AS current_price_cents,
      a.review_count,
      a.average_rating_x10,
      a.category_leaf,
      a.category_path
    FROM asin_products a
    WHERE a.enrichment_status IN ('active', 'no_price', 'delisted')
      AND a.asin IN (${ASINS_OF_LATEST_TERMS})
    `,
    values: [],
  };
}
```

`stageEnrichedAsins(client, currentWeekEndDate)` becomes `stageEnrichedAsins(client)` calling `stageEnrichedAsinsSql()` (update its one caller and drop the now-unused parameter); its doc comment keeps only the catalog paragraph (`The catalog keeps one row per ASIN … Rows with no outcome yet or only errors are left out.`), the weekly paragraphs go. Remove the `keepaReadSource` / `KeepaReadSource` imports.

`worker/kcsKeepaSyncJobs.ts`: remove line 38's import; `enrichedSyncSourceSql(source, cw)` becomes `enrichedSyncSourceSql()` returning only the catalog statement (the doc comment names the catalog only); at the call site `const source = keepaReadSource(); const phase1 = enrichedSyncSourceSql(source, cw);` becomes `const phase1 = enrichedSyncSourceSql();` and the log line becomes `` log(`phase=1 done: ${cnt[0].n} active/no_price/delisted catalog rows`); `` (the `cw` variable stays if other phases use it; otherwise remove it and its read). The file header (lines 7–17) still lists the deleted job as a trigger and names `worker/keepaJobs.ts`: keep only the watcher bullet, without "under KEEPA_READ_SOURCE=products only", and make line 17 read "Mirrors the worker/calibrationJobs.ts pattern:".

`lib/keepa/watcherRules.ts`: remove the `import type { KeepaReadSource } from './readSource';` line and the `readSource: KeepaReadSource;` field; in `decideWatcherActions` replace `if (i.readSource === 'products') { … }` by its body (the sync branches run unconditionally); `syncCouldFire` becomes

```ts
export function syncCouldFire(i: Pick<WatcherInput, 'laneNewDrainedAt' | 'syncFiredAt' | 'et'>): boolean {
  return drainPending(i) || inNightlyWindow(i.et);
}
```

with its doc comment losing `catalog reads on,`; in `heldReasons` replace `if (i.readSource === 'products') { … }` by its body.

`inngest/functions/keepaServiceWatcher.ts`: remove the `readSource` import line and the `readSource: KeepaReadSource;` field of `WatcherTickDeps`; `const { now, readSource } = deps;` → `const { now } = deps;`; the `syncCouldFire({ readSource, … })` call loses `readSource,`; the `WatcherInput` literal loses `readSource,`; the handler's deps literal loses `readSource: keepaReadSource(),`.

`lib/research/categories.ts:18`: `so no separate `asin_weekly_data` tree walk is needed` → `so no separate catalog tree walk is needed`; line 301: "after every Keepa enrichment run" → "after every Keepa aggregate sync (worker/kcsKeepaSyncJobs.ts, fired by the service watcher)".

`db/schema/asinWeeklyData.ts`: insert at the top of the table's doc comment (before `Per-(asin, week) snapshot of Keepa-sourced product data.`):

```
 * ARCHIVE since 2026-10-15 (arc 11): no writers (the old import-time job is gone) and never read by
 * the app (every reader uses the asin_products catalog and asin_snapshots, seeded from this table on
 * 2026-10-05 and backfilled for its post-seed fetches). 24 weeks, 2026-05-02 → 2026-10-10, ~5.5 GB.
 * Kept as raw history; dropping or exporting it is a separate decision (spec 2026-10-15 §9).
 *
```

`db/schema/keepaEnrichmentRuns.ts`: the same shape at the top of its doc comment: `ARCHIVE since 2026-10-15 (arc 11): the old import-time job's 30 runs (2026-05-19 → 2026-10-13); no writers, no readers. Kept as history.`

- [ ] **Step 4: Run the gates**

Run: `pnpm typecheck && pnpm vitest run lib/explorer lib/categoryBuilder inngest/functions lib/keepa worker && pnpm exec eslint lib/explorer/fetchKeywordDetail.ts lib/explorer/enrichedProductsQuery.test.ts lib/categoryBuilder/loadTree.ts inngest/functions/refreshSummary.ts inngest/functions/enrichedSourceSql.test.ts worker/kcsKeepaSyncJobs.ts lib/keepa/watcherRules.ts lib/keepa/watcherRules.test.ts inngest/functions/keepaServiceWatcher.ts inngest/functions/keepaServiceWatcher.test.ts tests/integration/keepaWatcher.test.ts lib/research/categories.ts db/schema/asinWeeklyData.ts db/schema/keepaEnrichmentRuns.ts`
Expected: tsc exits 0; every suite green; eslint silent. `git grep -n "KEEPA_READ_SOURCE\|keepaReadSource\|KeepaReadSource\|'weekly'" -- app lib inngest worker services tests db` prints only unrelated hits (`app/sitemap.ts`, `lib/sqpCalibration`, `lib/volumeModel` use the word for other things) — none in the Keepa modules.

- [ ] **Step 5: Commit**

```bash
git add lib/explorer/fetchKeywordDetail.ts lib/explorer/enrichedProductsQuery.test.ts lib/categoryBuilder/loadTree.ts inngest/functions/refreshSummary.ts inngest/functions/enrichedSourceSql.test.ts worker/kcsKeepaSyncJobs.ts lib/keepa/watcherRules.ts lib/keepa/watcherRules.test.ts inngest/functions/keepaServiceWatcher.ts inngest/functions/keepaServiceWatcher.test.ts tests/integration/keepaWatcher.test.ts lib/research/categories.ts db/schema/asinWeeklyData.ts db/schema/keepaEnrichmentRuns.ts
git commit -m "chore(keepa): one Keepa source — the reader flag and the weekly branches go; asin_weekly_data and keepa_enrichment_runs are marked as the archive" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(The `git rm` of Step 3 already staged the two deletions.)

---

### Task 6: Ship (owner-gated, each step on the owner's explicit go)

Not a subagent task: the controller runs it with the owner, in the spec's order (§8). Record every step in the Results table.

- [ ] **Step 0: Final whole-diff review + the spec amendment**

Before anything ships: a read-only final review of the arc's range (`pnpm vitest run` whole suite, `pnpm typecheck`, `pnpm build`, the leftover greps of Tasks 3–5, the Keepa service's `services/keepa/index.ts` boot path). Then a docs commit amending the spec (landed early as d51effd, together with the arc-6 spec's token-reserve note): §3.2 "the `readSource` field of its log line" → "its `readSource` dependency and the two sync guards"; §3.3 "`.env.example` loses the variable" → "`.env.example` never listed it (verified)"; §5 the fetched row → `` `${fmt(counts.fetchedLast24h)} · 7-day avg ${fmt(Math.round(counts.fetchedLast7d / 7))}/day` `` and the degraded line `Could not load (code)` (the longer row text wrapped at the card's 355 px column; the old degraded line read like a down service under the renamed heading).

- [ ] **Step 1: Backfill**

`BACKFILL_SNAPSHOTS=yes node --env-file=.env.local --import tsx scripts/backfillSnapshotsFromWeekly1015.ts`
Expected: `post-seed fetches without a snapshot before: N` with N ≤ 20,835 (the 2026-10-15 diag also counted delisted fetches, which the seed and this script skip; a further old-job run before the push raises N), `committed: N snapshot rows inserted`, `inserted N snapshot rows; … after: 0`, `backfill accepted` (every line carries an elapsed-seconds prefix; a mismatch prints a CHECK line and exits 1). A mismatch: re-run (idempotent) and read the counts. If the push lands after an import has fired the old job once more (2026-10-20), run this step again after the deploy: the script is idempotent and copies the new run's fetches. In that case also re-check the two ARCHIVE headers (`db/schema/asinWeeklyData.ts`: the last week; `db/schema/keepaEnrichmentRuns.ts`: the run count and last date) before the push.

- [ ] **Step 2: Push and deploys**

`node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` (0 Keepa runs, 0 imports mid-phase) → bare `git push origin main` → watch `gh api repos/raw5045/AmazonAnalytics/commits/<sha>/status --jq '"overall: \(.state)", (.statuses[] | "\(.context): \(.state) @ \(.updated_at)")'` until `Vercel`, `amazon-analytics-worker - AmazonAnalytics` and `amazon-analytics-worker - keepa-importer` are success. This push changes `/services/keepa/**` and `/lib/keepa/**`, so the Keepa service redeploys: its in-flight batch is reclaimed by the 10-minute stale-claim rule, as on every service deploy.

- [ ] **Step 3: Smoke**

The admin page `/admin/keepa-enrichment`: heading "Keepa service", the card (heading "Service status") with `Fetched last 24 h: N · 7-day avg M/day`, no button, no run list. A keyword page (the "kindle" page, rank 4) still lists its top clicked products with prices; the Category Builder still loads (perf line under a second warm). `scripts/checkKeepaService1010.ts`: the service heartbeat fresh after its redeploy, batches landing, 0 errors. Then the owner may delete `KEEPA_READ_SOURCE` from Vercel and the Railway worker (after a green day; nothing reads it) and `KEEPA_API_KEY` from the Railway worker (only the Keepa service and local scripts read it now). Check `scripts/checkActiveJobs.ts` still prints 0 Keepa runs: it counts `status = 'running'` rows of the archive table, and with the boot-time reclaim gone a row stranded by the deploy would never flip; if one does, switch that probe to a heartbeat window (`heartbeat_at > now() - interval '10 minutes'`).

- [ ] **Step 4: The 2026-10-20 import**

After the first import that runs on the new code: `SELECT count(*) FROM keepa_enrichment_runs WHERE started_at > '2026-10-16'` = 0; `import_phase_timings` shows `keepa_enqueue` (and `top_asins_build`, `ba_crosswalk_build`); the service's new lane drains the week's new tier-1 products within the day (the card's "New lane last drained"). Fill the Results row.

#### Results

| Step | Date | Outcome | Notes |
|---|---|---|---|
| Final review | | | |
| Backfill | | | |
| Push + deploys | | | |
| Smoke | | | |
| First import without the old job | | | |

---

## Landed shape

Deviations from the plan as executed are recorded here, task by task, during execution.

- **Task 1:** landed as written (untracked, byte-identical to the plan; eslint + typecheck clean; never run). The spec review confirmed the cutoff is safe (the seed ran after midnight 2026-10-06: every post-cutoff fetch that already has a snapshot got it from the seed) and corrected the Results expectation: the before-count is ≤ 20,835, since the diag's figure included delisted fetches the seed never copied; a late push means re-running the backfill after the deploy (Task 6 step 1 says so now). The quality round then made the two counts run in their own READ ONLY transactions with `SET LOCAL statement_timeout` (a session-level SET before BEGIN goes through Neon's transaction-mode pooler and lingers on a shared server connection), added the elapsed-seconds logger, a "copying…" line, the committed count right after COMMIT, "nothing to copy" when the before-count is 0, exit code 1 on a mismatch, keepAlive on the client, and corrected the header: the seed ran 2026-10-06 ~18:40 UTC, so the cutoff is the start of that day and overlaps the seed on purpose. The plan's code block above is the final file.
- **Task 2:** landed d503917 as planned (the card test had two heading pins, both → 'Service status'; `app/admin/layout.test.tsx` does not exist; the implementer kept the degrade case's log-safety assertion `not.toContain('does not exist')`). The quality round (37d75db) then deviated from the plan's text in three places, adopted by the controller: the page intro is one sentence that does not repeat the card's first line ("Refreshes every tier-1 product on a 7-day cycle and fetches new products usually within a day of each weekly import; the watcher emails when the service is down or stalled."); the fetched row reads `N · 7-day avg M/day` instead of `N · 7-day average M per day`, because the longer text wrapped at the card's 355 px column (measured 377 px); the degraded line reads `Could not load (code)` instead of `Service status unavailable (code)`, which read like a down service under the renamed heading. Also: the component is `KeepaServiceAdminPage`; the dead `orderBy` mock branch and its stale comment went; the tests pin the region's aria-labelledby, the table read (`keywordCurrentSummaryMeta`), the rounding (0 → `0/day`, 900,003 → 128,572) and `queryAllByRole('button')` length 0. Follow-up, not taken: move the explorer-week read inside the best-effort try so a failed read degrades to the card's line instead of the error page.
- **Task 3:** landed 0f502e1 (28 files, +19/−2,936; the whole suite 2,939 green). Deviations: `worker/index.ts` imported the deleted job's boot-time reclaim (`reclaimStaleKeepaRunsOnBoot`, which only let the orchestrator wrap up) — the import and its boot block went too, so a run row stranded 'running' is never flipped any more (the archive table; the Task 6 note covers `scripts/checkActiveJobs.ts`); seven comment-only edits dropped references to the deleted modules in `importBatch.ts`, `processCalibrationUpload.ts`, `processMonthlySfr.ts`, `categoryExclusions.ts`, `buildCalibrationEmail.ts`, `sendCalibrationEmail.ts`, `monthlySfrJobs.ts`; the gitignored generated `.next/types/validator.ts` and `.next/dev/types/validator.ts` still imported the deleted route and were hand-edited so `pnpm typecheck` passes (Next regenerates them at `pnpm build`; the ship's build does). The test pin sits in the `keepa_enqueue hook` describe's first case (the only success case whose refresh mock yields a week), proven non-vacuous by mutation. The review round (54104d1) deleted `lib/keepa/types.ts` outright (nothing imported it: the product pages take `AsinEnrichmentStatus` from `db/schema`, the service uses `FactsStatus`), and reworded `sendKeepaServiceAlarmEmail.ts:3`, the aggregate sync's trigger docblock (fired by the watcher), `categoryExclusions.ts` (a never-existing script removed from its list; the enqueue-phase wording), `enqueueWeek.ts:5-6` and `processMonthlySfr.ts:7`. Carried into Tasks 4 and 5: the `TOKEN_RESERVE` comments in `loop.ts`/`lanes.ts`, the `oldJobRunning` case in `tests/integration/keepaService.test.ts`, the sync file's header, `categories.ts:301`.
- **Task 4:** landed 9ea4dda (12 files, +19/−320; 171 tests green). Forced deviations: the `OLD_JOB_YIELD_SLEEP_MS` import left `loop.test.ts` with the constant; the watcher tick's statement-count pin went from 4 to 3; the two old-job watcher harnesses were one `it`; `services/keepa/index.ts` never handled `'yielded'`, so it is untouched; the red phase failed 48 cases, not two, because the fakes lost `oldJobRunning` before the source did. The review round (2c7650a) replaced the plan's negative pins with a positive one (a batch's store calls are exactly `['release', 'claim', 'write']`; the watcher case pins no weeks read and no writes), gave the `TOKEN_RESERVE` comments in `lanes.ts`, `loop.ts` and the README a rationale the numbers support (a cushion for an ad-hoc script on the same key; a constant offset, so throughput stays at the refill rate) instead of the plan's "margin against Keepa's own rounding", and reflowed the `heldReasons` doc comment. Outside the repo: the untracked push gate `scripts/checkActiveJobs.ts` now judges a Keepa run by `heartbeat_at > now() - interval '10 minutes'` (the removed service probe's rule), since nothing resets a stranded 'running' row any more. Behaviour notes from the review, not changed: a database failure in the middle of a Keepa retry series no longer aborts the batch as `db_error`; a rare stalled-then-recovered email pair remains possible when the service idled over two hours and an enqueue longer than five minutes then lands (pre-existing).
- **Task 5:** landed 10bdc35 (17 files, +132/−327; 832 tests green; every catalog statement byte-identical to its former `products` branch, proven by comparing the template literals with the TypeScript compiler API). Deviations: `db/schema/asinProducts.ts:8` lost its flag mention (the plan's own grep covered `db`); `worker/kcsKeepaSyncJobs.ts` comments beyond the listed lines; two test titles reworded; `loadTree.ts` had four call sites, not three; the roots builder carries an `eslint-disable-next-line @typescript-eslint/no-unused-vars` because the repo's rule has no underscore ignore pattern and `_sv`/`_wk` must stay as `unstable_cache` key parts; the ARCHIVE header says the seed ran 2026-10-06 (correct; the plan said 2026-10-05). The plan's premise that an alarm tick never depended on the source was wrong: with the flag gone, the integration down-alarm case's seed left a live `lane_new_drained_at` in play, so the review round (c769763) seeds that case with no pending drain and tonight's `nightly_sync_date` (both the implementer and the spec reviewer swept `decideWatcherActions` over that state, 11,520 and 14,976 ticks: no sync action), and reworded the last weekly-source comments and the archive files' deleted-writer pointers. The quality round (7c4ae5d) fixed comment accuracy (the loadTree header: `snapshot_version` drives the rebuild and REVALIDATE bounds the staleness; three refreshSummary comments; two fetchKeywordDetail comments; a "not dead code" note on `asinWeeklyData.ts`, whose enum and type the catalog tables and product pages still use; the sync file's header lists all eight Phase 2 columns), renamed the mapper test, and added a grid pin that `heldReasons` ignores the explorer week whenever no sync could fire. Kept: `_wk` in the builders (the plan's choice).

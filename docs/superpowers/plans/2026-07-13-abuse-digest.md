# Daily Admin Abuse-Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the report-only abuse safety net: daily activity counters + a 7:30am ET cron that emails all admins a flags-first summary of yesterday's signups, reads, creations, and contact-form pressure.

**Architecture:** Two tiny counter tables (per-user-per-day and app-wide-per-day) bumped fire-and-forget from the read/contact chokepoints, plus a `session.created` webhook stamp. A four-module pipeline (`load → evaluateFlags → buildEmail → send`) mirrors the weekly digest's pure/impure split; idempotency is one `app_settings` key. An admin preview page with Send-now is the testing story.

**Tech Stack:** Next.js 16 App Router server components, Drizzle ORM (neon-http on Vercel / node-postgres on the Railway worker), Inngest cron on the Railway worker, Resend, vitest.

**Spec:** `docs/superpowers/specs/2026-07-13-abuse-digest-design.md`

---

## Repo conventions the engineer must know

- **Package manager:** `pnpm`. Test: `pnpm test` (vitest run). Typecheck: `pnpm typecheck`. Build: `pnpm build`.
- **Migrations are hand-numbered raw SQL** (0027+): a `.sql` file in `db/migrations/` applied by a gated script in `scripts/` (mirror `scripts/applyMigration0042.ts`). NEVER run `pnpm db:generate`/`db:migrate`. **Applying DDL to Neon requires the user's explicit go-ahead** — the apply step is a human checkpoint at the end, not part of a code task.
- **`.env.local` DATABASE_URL points at the live Neon DB.** Do not run ad-hoc DDL or destructive SQL. Code tasks only touch files; nothing in Tasks 1–11 executes SQL.
- **No `import 'server-only'`** in any module reachable from `lib/notifications/**` or `inngest/**` — the Railway worker imports them in plain Node and would crash-loop on boot (see the header comment in `lib/notifications/digest/sendWeeklyDigest.ts`).
- **Commit trailer (exact):** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Never `git push`** — pushing to main deploys Vercel AND restarts the Railway worker (killing any running jobs). Pushes happen only at the final human checkpoint with the user's explicit authorization.
- Unit tests are colocated (`foo.ts` + `foo.test.ts`) and import from `vitest`: `import { describe, expect, it } from 'vitest';`
- Path alias `@/` = repo root (e.g. `@/db/client`).

## File map (what this plan creates/modifies)

| File | Responsibility |
|---|---|
| `db/migrations/0043_activity_daily_counters.sql` (create) | DDL for the two counter tables |
| `scripts/applyMigration0043.ts` (create) | Gated apply script (run later by user checkpoint) |
| `db/schema/userActivityDaily.ts` (create) | Drizzle table: per-user-per-day counters |
| `db/schema/appActivityDaily.ts` (create) | Drizzle table: app-wide-per-day counters |
| `db/schema/index.ts` (modify) | Export the two new tables |
| `lib/activity/etDay.ts` (create) | Pure ET calendar-day helpers |
| `lib/activity/etDay.test.ts` (create) | Unit tests incl. DST boundaries |
| `lib/activity/bump.ts` (create) | Fire-and-forget counter upserts + metric unions |
| `app/(app)/explorer/page.tsx` (modify) | Bump `explorer_query` |
| `app/(app)/explorer/keyword/[id]/page.tsx` (modify) | Bump `detail_view` |
| `app/api/contact/route.ts` (modify) | Bump `contact_submission` / `contact_honeypot` |
| `app/api/webhooks/clerk/route.ts` (modify) | Handle `session.created` → stamp `last_login_at` |
| `lib/notifications/abuseDigest/types.ts` (create) | `AbuseDigestStats`, `PerUserActivity`, `Flag` |
| `lib/notifications/abuseDigest/assembleStats.ts` (create) | Pure merge of query outputs → `PerUserActivity[]` |
| `lib/notifications/abuseDigest/assembleStats.test.ts` (create) | Unit tests |
| `lib/notifications/abuseDigest/loadAbuseDigestData.ts` (create) | The day-scoped SQL, thin, returns `AbuseDigestStats` |
| `lib/notifications/abuseDigest/evaluateFlags.ts` (create) | Pure thresholds → `Flag[]` |
| `lib/notifications/abuseDigest/evaluateFlags.test.ts` (create) | Unit tests |
| `lib/notifications/abuseDigest/buildAbuseDigestEmail.ts` (create) | Pure `{subject, html, text}` builder |
| `lib/notifications/abuseDigest/buildAbuseDigestEmail.test.ts` (create) | Unit tests |
| `lib/notifications/abuseDigest/sendAbuseDigest.ts` (create) | Orchestrator: idempotency key, recipients, Resend send |
| `inngest/functions/sendAbuseDigest.ts` (create) | Daily 7:30am ET cron wrapper |
| `inngest/functions/index.ts` (modify) | Register the cron fn |
| `app/admin/abuse-digest/page.tsx` (create) | Preview page (renders email HTML) |
| `app/admin/abuse-digest/SendNowButton.tsx` (create) | Client button → POST send route |
| `app/api/admin/abuse-digest/send/route.ts` (create) | Admin-gated force-send route |
| `app/admin/layout.tsx` (modify) | Sidebar nav link |

---

### Task 1: Migration 0043 + Drizzle schemas

**Files:**
- Create: `db/migrations/0043_activity_daily_counters.sql`
- Create: `scripts/applyMigration0043.ts`
- Create: `db/schema/userActivityDaily.ts`
- Create: `db/schema/appActivityDaily.ts`
- Modify: `db/schema/index.ts`

- [ ] **Step 1: Write the migration SQL**

Create `db/migrations/0043_activity_daily_counters.sql`:

```sql
-- 0043: daily activity counters for the admin abuse-digest.
--
-- user_activity_daily: one row per (user, ET calendar day, metric), bumped
-- fire-and-forget from the explorer/detail read paths. ON DELETE CASCADE is
-- deliberate — unlike audit_log's RESTRICT, activity counters must never
-- block a user deletion (the Clerk user.deleted webhook cascade).
--
-- app_activity_daily: app-wide counters with no user (signed-out contact
-- form: submissions + honeypot trips).
--
-- 'day' is the ET (America/New_York) calendar date, computed app-side.
-- See docs/superpowers/specs/2026-07-13-abuse-digest-design.md.

CREATE TABLE IF NOT EXISTS user_activity_daily (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     date NOT NULL,
  metric  varchar(64) NOT NULL,
  count   integer NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, day, metric)
);

CREATE INDEX IF NOT EXISTS user_activity_daily_day_idx
  ON user_activity_daily (day);

CREATE TABLE IF NOT EXISTS app_activity_daily (
  day    date NOT NULL,
  metric varchar(64) NOT NULL,
  count  integer NOT NULL DEFAULT 1,
  PRIMARY KEY (day, metric)
);
```

- [ ] **Step 2: Write the gated apply script**

Create `scripts/applyMigration0043.ts` (mirrors `scripts/applyMigration0042.ts` — read it if unsure):

```ts
/**
 * Apply migration 0043 (daily activity counter tables) to DATABASE_URL,
 * then assert both tables exist. Gated by APPLY_0043=yes.
 *
 * Run: APPLY_0043=yes node --env-file=.env.local --import tsx scripts/applyMigration0043.ts
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

if (process.env.APPLY_0043 !== 'yes') {
  console.error('Refusing to run: set APPLY_0043=yes to proceed.');
  process.exit(1);
}

(async () => {
  const sql = readFileSync('db/migrations/0043_activity_daily_counters.sql', 'utf8');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 60_000 });
  const c = await pool.connect();
  try {
    console.log('Applying 0043_activity_daily_counters.sql (two empty tables — instant)...');
    await c.query(sql);

    const { rows } = await c.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('user_activity_daily', 'app_activity_daily')`,
    );
    if (rows.length !== 2) {
      console.error(`❌ assertion FAILED — expected 2 tables, found ${rows.length}`);
      process.exit(1);
    }
    console.log('✅ 0043 applied — user_activity_daily + app_activity_daily exist');
  } finally {
    c.release();
    await pool.end();
  }
})();
```

**Do NOT run this script in this task.** Applying it is the user checkpoint in Task 12.

- [ ] **Step 3: Write the Drizzle schema files**

Create `db/schema/userActivityDaily.ts`:

```ts
import { pgTable, uuid, date, varchar, integer, index, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Per-user daily activity counters for the admin abuse-digest. See
 * migration 0043 + docs/superpowers/specs/2026-07-13-abuse-digest-design.md.
 *
 * `day` is the ET (America/New_York) calendar date (computed app-side by
 * lib/activity/etDay.ts). ON DELETE CASCADE is deliberate — activity
 * counters must never block the Clerk user.deleted webhook cascade
 * (audit_log's RESTRICT FK is the cautionary tale).
 */
export const userActivityDaily = pgTable(
  'user_activity_daily',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    metric: varchar('metric', { length: 64 }).notNull(),
    count: integer('count').notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.day, t.metric] }),
    dayIdx: index('user_activity_daily_day_idx').on(t.day),
  }),
);

export type UserActivityDailyRow = typeof userActivityDaily.$inferSelect;
```

Create `db/schema/appActivityDaily.ts`:

```ts
import { pgTable, date, varchar, integer, primaryKey } from 'drizzle-orm/pg-core';

/**
 * App-wide (no-user) daily activity counters — signed-out surfaces like the
 * public contact form. See migration 0043 + the abuse-digest spec.
 */
export const appActivityDaily = pgTable(
  'app_activity_daily',
  {
    day: date('day').notNull(),
    metric: varchar('metric', { length: 64 }).notNull(),
    count: integer('count').notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.day, t.metric] }),
  }),
);

export type AppActivityDailyRow = typeof appActivityDaily.$inferSelect;
```

- [ ] **Step 4: Export from the schema barrel**

In `db/schema/index.ts`, add these two lines alongside the existing exports (the file is a flat list of `export *` lines):

```ts
export * from './userActivityDaily';
export * from './appActivityDaily';
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0043_activity_daily_counters.sql scripts/applyMigration0043.ts db/schema/userActivityDaily.ts db/schema/appActivityDaily.ts db/schema/index.ts
git commit -m "feat(abuse-digest): migration 0043 + schemas — daily activity counter tables

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: ET calendar-day helpers (TDD)

**Files:**
- Create: `lib/activity/etDay.test.ts`
- Create: `lib/activity/etDay.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/activity/etDay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { etDay, previousEtDay } from './etDay';

describe('etDay', () => {
  it('returns the ET calendar date for a UTC instant that is still "yesterday" in ET', () => {
    // 2026-07-13T03:00:00Z = 2026-07-12 23:00 EDT
    expect(etDay(new Date('2026-07-13T03:00:00Z'))).toBe('2026-07-12');
  });

  it('returns the ET calendar date for a UTC instant just past ET midnight', () => {
    // 2026-07-13T04:30:00Z = 2026-07-13 00:30 EDT
    expect(etDay(new Date('2026-07-13T04:30:00Z'))).toBe('2026-07-13');
  });

  it('handles winter (EST, UTC-5)', () => {
    // 2026-01-15T04:30:00Z = 2026-01-14 23:30 EST
    expect(etDay(new Date('2026-01-15T04:30:00Z'))).toBe('2026-01-14');
  });

  it('pads month and day', () => {
    // 2026-03-05T12:00:00Z = 2026-03-05 07:00 EST
    expect(etDay(new Date('2026-03-05T12:00:00Z'))).toBe('2026-03-05');
  });
});

describe('previousEtDay', () => {
  it('subtracts one calendar day', () => {
    // 07:30 EDT on Jul 13 → previous day Jul 12
    expect(previousEtDay(new Date('2026-07-13T11:30:00Z'))).toBe('2026-07-12');
  });

  it('crosses a month boundary', () => {
    // 2026-08-01 07:30 EDT
    expect(previousEtDay(new Date('2026-08-01T11:30:00Z'))).toBe('2026-07-31');
  });

  it('crosses a year boundary', () => {
    // 2026-01-01 07:30 EST = 12:30Z
    expect(previousEtDay(new Date('2026-01-01T12:30:00Z'))).toBe('2025-12-31');
  });

  it('is correct on the spring-forward morning (2026-03-08 is a 23h ET day)', () => {
    // 2026-03-08 07:30 EDT = 11:30Z → previous ET day is 03-07
    expect(previousEtDay(new Date('2026-03-08T11:30:00Z'))).toBe('2026-03-07');
  });

  it('is correct on the fall-back morning (2026-11-01 is a 25h ET day)', () => {
    // 2026-11-01 07:30 EST = 12:30Z → previous ET day is 10-31
    expect(previousEtDay(new Date('2026-11-01T12:30:00Z'))).toBe('2026-10-31');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/activity/etDay.test.ts`
Expected: FAIL — cannot resolve `./etDay`.

- [ ] **Step 3: Implement**

Create `lib/activity/etDay.ts`:

```ts
/**
 * ET (America/New_York) calendar-day helpers for the activity counters and
 * the abuse digest. `Intl` owns the DST rules; `previousEtDay` does pure
 * calendar arithmetic on the resulting Y-M-D (in UTC space) so it is
 * immune to 23h/25h ET days.
 */
const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The ET calendar date of `date`, as 'YYYY-MM-DD'. */
export function etDay(date: Date): string {
  return ET_DATE_FMT.format(date); // en-CA formats as YYYY-MM-DD
}

/** The ET calendar date one day before `date`'s ET calendar date. */
export function previousEtDay(date: Date): string {
  const [y, m, d] = etDay(date).split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000);
  const mm = String(prev.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(prev.getUTCDate()).padStart(2, '0');
  return `${prev.getUTCFullYear()}-${mm}-${dd}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/activity/etDay.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/activity/etDay.ts lib/activity/etDay.test.ts
git commit -m "feat(abuse-digest): ET calendar-day helpers (DST-safe)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Fire-and-forget bump helpers

No unit test — these are 10-line DB upsert wrappers with a swallow-all contract, and the repo's integration harness is parked WIP. Verified by typecheck here and end-to-end via the preview page at ship time.

**Files:**
- Create: `lib/activity/bump.ts`

- [ ] **Step 1: Implement**

Create `lib/activity/bump.ts`:

```ts
/**
 * Fire-and-forget daily activity counters (admin abuse-digest source data).
 *
 * CONTRACT: callers invoke these UN-AWAITED (`void bumpUserActivity(...)`)
 * from hot request paths. Every error is swallowed to a console.warn — a
 * lost count is acceptable; a slowed or crashed request is not. (On Vercel,
 * the function freeze after a response can also occasionally drop an
 * in-flight bump — same accepted trade.)
 *
 * No `import 'server-only'` — keep this importable everywhere.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { userActivityDaily, appActivityDaily } from '@/db/schema';
import { etDay } from './etDay';

export type UserActivityMetric = 'explorer_query' | 'detail_view';
export type AppActivityMetric = 'contact_submission' | 'contact_honeypot';

export async function bumpUserActivity(userId: string, metric: UserActivityMetric): Promise<void> {
  try {
    await db
      .insert(userActivityDaily)
      .values({ userId, day: etDay(new Date()), metric, count: 1 })
      .onConflictDoUpdate({
        target: [userActivityDaily.userId, userActivityDaily.day, userActivityDaily.metric],
        set: { count: sql`${userActivityDaily.count} + 1` },
      });
  } catch (e) {
    console.warn(`[activity] bumpUserActivity(${metric}) failed:`, e instanceof Error ? e.message : e);
  }
}

export async function bumpAppActivity(metric: AppActivityMetric): Promise<void> {
  try {
    await db
      .insert(appActivityDaily)
      .values({ day: etDay(new Date()), metric, count: 1 })
      .onConflictDoUpdate({
        target: [appActivityDaily.day, appActivityDaily.metric],
        set: { count: sql`${appActivityDaily.count} + 1` },
      });
  } catch (e) {
    console.warn(`[activity] bumpAppActivity(${metric}) failed:`, e instanceof Error ? e.message : e);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add lib/activity/bump.ts
git commit -m "feat(abuse-digest): fire-and-forget daily counter upserts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Instrument the four call sites

**Files:**
- Modify: `app/(app)/explorer/page.tsx` (~line 136, after the `Promise.all` that runs the query)
- Modify: `app/(app)/explorer/keyword/[id]/page.tsx` (~line 59, after `isWatched`)
- Modify: `app/api/contact/route.ts`
- Modify: `app/api/webhooks/clerk/route.ts`

- [ ] **Step 1: Explorer page — bump `explorer_query`**

In `app/(app)/explorer/page.tsx`, add to the imports:

```ts
import { bumpUserActivity } from '@/lib/activity/bump';
```

Inside `ExplorerResults`, immediately AFTER this existing block (~line 136):

```ts
  const [queryResult, categoriesTimed, leafCategories] = await Promise.all([
    runExplorerQuery(queryFilters),
    categoriesPromise,
    leafCategoriesPromise,
  ]);
```

add:

```ts
  // Abuse-digest counter — fire-and-forget by contract (see lib/activity/bump.ts).
  if (user) void bumpUserActivity(user.id, 'explorer_query');
```

(`user` is already in scope from `const user = await getCurrentUser();` earlier in the function. Keep-warm crons never render this page, so synthetic traffic is not counted.)

- [ ] **Step 2: Detail page — bump `detail_view`**

In `app/(app)/explorer/keyword/[id]/page.tsx`, add to the imports:

```ts
import { bumpUserActivity } from '@/lib/activity/bump';
```

After these existing lines (~line 57–60):

```ts
  const user = await getCurrentUser();
  timer.mark('auth');
  const isWatched = user ? await isKeywordWatched(user.id, id) : false;
  timer.mark('isWatched');
```

add:

```ts
  // Abuse-digest counter — fire-and-forget by contract (see lib/activity/bump.ts).
  if (user) void bumpUserActivity(user.id, 'detail_view');
```

- [ ] **Step 3: Contact route — bump both app metrics**

In `app/api/contact/route.ts`, add to the imports:

```ts
import { bumpAppActivity } from '@/lib/activity/bump';
```

Change the honeypot branch from:

```ts
  if (typeof body.company === 'string' && body.company.trim().length > 0) {
    return NextResponse.json({ ok: true }); // honeypot tripped — swallow silently
  }
```

to:

```ts
  if (typeof body.company === 'string' && body.company.trim().length > 0) {
    void bumpAppActivity('contact_honeypot'); // abuse-digest counter (fire-and-forget)
    return NextResponse.json({ ok: true }); // honeypot tripped — swallow silently
  }
```

And change the success tail from:

```ts
  const result = await sendContactEmail(v.input);
  if (!result.sent) {
    return NextResponse.json(
      { error: "Couldn't send your message right now — please try again later." },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
```

to:

```ts
  const result = await sendContactEmail(v.input);
  if (!result.sent) {
    return NextResponse.json(
      { error: "Couldn't send your message right now — please try again later." },
      { status: 503 },
    );
  }
  void bumpAppActivity('contact_submission'); // abuse-digest counter (fire-and-forget)
  return NextResponse.json({ ok: true });
```

(Malformed 400s are deliberately not counted in v1.)

- [ ] **Step 4: Clerk webhook — handle `session.created`**

In `app/api/webhooks/clerk/route.ts`, replace the existing event typing:

```ts
interface ClerkEvent {
  type: 'user.created' | 'user.updated' | 'user.deleted';
  data: ClerkUserData;
}
```

with:

```ts
interface ClerkSessionData {
  id: string;
  user_id: string;
}

type ClerkEvent =
  | { type: 'user.created' | 'user.updated' | 'user.deleted'; data: ClerkUserData }
  | { type: 'session.created'; data: ClerkSessionData };
```

Then, inside the existing `try { ... }` block, add a `session.created` branch BEFORE the `user.created || user.updated` branch:

```ts
    if (event.type === 'session.created') {
      // Sign-in stamp for the abuse digest. UPDATE matching zero rows (a
      // session for a user we don't know) is a silent no-op by design —
      // session events must never 500 into a Svix retry loop.
      await db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.clerkUserId, event.data.user_id));
    } else if (event.type === 'user.created' || event.type === 'user.updated') {
```

(i.e. the previous `if (event.type === 'user.created' || ...)` becomes an `else if`; the `user.deleted` branch and the catch are unchanged. `db`, `users`, and `eq` are already imported in this file.)

**Note:** the Clerk dashboard must also subscribe the webhook endpoint to `session.created` — that is a user step in Task 12, not code.

- [ ] **Step 5: Verify — typecheck + full test suite**

Run: `pnpm typecheck`
Expected: exit 0.

Run: `pnpm test`
Expected: all existing tests still pass (nothing in this task has its own unit tests; the webhook change is type-safe restructuring).

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/explorer/page.tsx" "app/(app)/explorer/keyword/[id]/page.tsx" app/api/contact/route.ts app/api/webhooks/clerk/route.ts
git commit -m "feat(abuse-digest): instrument read/contact call sites + session.created login stamp

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Digest types + pure stats assembly (TDD)

**Files:**
- Create: `lib/notifications/abuseDigest/types.ts`
- Create: `lib/notifications/abuseDigest/assembleStats.test.ts`
- Create: `lib/notifications/abuseDigest/assembleStats.ts`

- [ ] **Step 1: Write the types**

Create `lib/notifications/abuseDigest/types.ts`:

```ts
// lib/notifications/abuseDigest/types.ts
// Shared shapes for the daily admin abuse-digest. See
// docs/superpowers/specs/2026-07-13-abuse-digest-design.md.

export interface SignupRow {
  email: string;
  name: string | null;
  /** ISO timestamp of users.created_at */
  createdAt: string;
}

export interface PerUserActivity {
  userId: string;
  email: string;
  name: string | null;
  explorerQueries: number;
  detailViews: number;
  watchlistAdds: number;
  savedViewsCreated: number;
  customCategoriesCreated: number;
}

export interface AbuseDigestStats {
  /** ET calendar day this digest covers, YYYY-MM-DD */
  day: string;
  totalUsers: number;
  signups: SignupRow[];
  /** One row per active user, sorted by reads (queries + detail views) desc. */
  activeUsers: PerUserActivity[];
  signIns: { count: number; emails: string[] };
  contact: { submissions: number; honeypotTrips: number };
}

export interface Flag {
  severity: 'amber' | 'red';
  message: string;
}
```

- [ ] **Step 2: Write the failing tests for the assembly function**

Create `lib/notifications/abuseDigest/assembleStats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assemblePerUserActivity, type CounterRow, type CreationCounts, type UserInfo } from './assembleStats';

const U1 = '00000000-0000-0000-0000-000000000001';
const U2 = '00000000-0000-0000-0000-000000000002';
const U3 = '00000000-0000-0000-0000-000000000003';

const info = new Map<string, UserInfo>([
  [U1, { email: 'a@x.com', name: 'A' }],
  [U2, { email: 'b@x.com', name: null }],
  [U3, { email: 'c@x.com', name: 'C' }],
]);

describe('assemblePerUserActivity', () => {
  it('merges counters and creations into one row per user, sorted by reads desc', () => {
    const counters: CounterRow[] = [
      { userId: U1, metric: 'explorer_query', count: 5 },
      { userId: U1, metric: 'detail_view', count: 2 },
      { userId: U2, metric: 'explorer_query', count: 100 },
    ];
    const creations: CreationCounts = {
      watchlistAdds: new Map([[U1, 3]]),
      savedViewsCreated: new Map(),
      customCategoriesCreated: new Map([[U3, 1]]),
    };

    const rows = assemblePerUserActivity(counters, creations, info);

    expect(rows.map((r) => r.userId)).toEqual([U2, U1, U3]); // 100 reads, 7 reads, 0 reads
    expect(rows[1]).toEqual({
      userId: U1,
      email: 'a@x.com',
      name: 'A',
      explorerQueries: 5,
      detailViews: 2,
      watchlistAdds: 3,
      savedViewsCreated: 0,
      customCategoriesCreated: 0,
    });
    // A creations-only user (no counters) still appears as active:
    expect(rows[2].customCategoriesCreated).toBe(1);
    expect(rows[2].explorerQueries).toBe(0);
  });

  it('ignores unknown metrics defensively', () => {
    const counters = [{ userId: U1, metric: 'future_metric', count: 9 }] as CounterRow[];
    const rows = assemblePerUserActivity(
      counters,
      { watchlistAdds: new Map(), savedViewsCreated: new Map(), customCategoriesCreated: new Map() },
      info,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].explorerQueries).toBe(0);
    expect(rows[0].detailViews).toBe(0);
  });

  it('falls back to placeholder identity when the users row is missing', () => {
    const counters: CounterRow[] = [{ userId: U1, metric: 'explorer_query', count: 1 }];
    const rows = assemblePerUserActivity(
      counters,
      { watchlistAdds: new Map(), savedViewsCreated: new Map(), customCategoriesCreated: new Map() },
      new Map(),
    );
    expect(rows[0].email).toBe('(unknown user)');
    expect(rows[0].name).toBeNull();
  });

  it('returns [] when nothing happened', () => {
    expect(
      assemblePerUserActivity(
        [],
        { watchlistAdds: new Map(), savedViewsCreated: new Map(), customCategoriesCreated: new Map() },
        info,
      ),
    ).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run lib/notifications/abuseDigest/assembleStats.test.ts`
Expected: FAIL — cannot resolve `./assembleStats`.

- [ ] **Step 4: Implement**

Create `lib/notifications/abuseDigest/assembleStats.ts`:

```ts
// lib/notifications/abuseDigest/assembleStats.ts
// Pure merge of the loader's raw query outputs into PerUserActivity rows.
// Split out from loadAbuseDigestData so it can be unit-tested without a DB.
import type { PerUserActivity } from './types';

export interface CounterRow {
  userId: string;
  metric: string;
  count: number;
}

export interface CreationCounts {
  watchlistAdds: Map<string, number>;
  savedViewsCreated: Map<string, number>;
  customCategoriesCreated: Map<string, number>;
}

export interface UserInfo {
  email: string;
  name: string | null;
}

/**
 * One row per user that has ANY counter or creation for the day, sorted by
 * reads (explorer queries + detail views) desc. Unknown metric names are
 * ignored (forward-compat if a future metric ships before the digest knows
 * how to display it).
 */
export function assemblePerUserActivity(
  counters: CounterRow[],
  creations: CreationCounts,
  userInfo: Map<string, UserInfo>,
): PerUserActivity[] {
  const byUser = new Map<string, PerUserActivity>();

  const rowFor = (userId: string): PerUserActivity => {
    let row = byUser.get(userId);
    if (!row) {
      const info = userInfo.get(userId);
      row = {
        userId,
        email: info?.email ?? '(unknown user)',
        name: info?.name ?? null,
        explorerQueries: 0,
        detailViews: 0,
        watchlistAdds: 0,
        savedViewsCreated: 0,
        customCategoriesCreated: 0,
      };
      byUser.set(userId, row);
    }
    return row;
  };

  for (const c of counters) {
    const row = rowFor(c.userId);
    if (c.metric === 'explorer_query') row.explorerQueries = c.count;
    else if (c.metric === 'detail_view') row.detailViews = c.count;
    // unknown metrics: row still marks the user active, but no column moves
  }
  for (const [userId, n] of creations.watchlistAdds) rowFor(userId).watchlistAdds = n;
  for (const [userId, n] of creations.savedViewsCreated) rowFor(userId).savedViewsCreated = n;
  for (const [userId, n] of creations.customCategoriesCreated) rowFor(userId).customCategoriesCreated = n;

  return [...byUser.values()].sort(
    (a, b) => b.explorerQueries + b.detailViews - (a.explorerQueries + a.detailViews),
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run lib/notifications/abuseDigest/assembleStats.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/notifications/abuseDigest/types.ts lib/notifications/abuseDigest/assembleStats.ts lib/notifications/abuseDigest/assembleStats.test.ts
git commit -m "feat(abuse-digest): types + pure per-user activity assembly

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Data loader

Thin day-scoped SQL; the merging logic was tested in Task 5. No unit test for the SQL itself (integration harness is parked) — it is exercised via the preview page in Task 12.

**Files:**
- Create: `lib/notifications/abuseDigest/loadAbuseDigestData.ts`

- [ ] **Step 1: Implement**

Create `lib/notifications/abuseDigest/loadAbuseDigestData.ts`:

```ts
// lib/notifications/abuseDigest/loadAbuseDigestData.ts
//
// IMPORTANT: do NOT add `import 'server-only'` here. This module is pulled
// into the Railway worker's import graph via sendAbuseDigest.ts (the worker
// runs plain Node via tsx). See the matching note in
// lib/notifications/digest/loadDigestData.ts.
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  users,
  watchlistItems,
  savedViews,
  customCategories,
  userActivityDaily,
  appActivityDaily,
} from '@/db/schema';
import { assemblePerUserActivity, type CounterRow, type UserInfo } from './assembleStats';
import type { AbuseDigestStats, SignupRow } from './types';

const SIGNIN_EMAILS_CAP = 10;

/**
 * Load everything the digest reports for one ET calendar day (YYYY-MM-DD).
 *
 * timestamptz columns (created_at / added_at / last_login_at) are filtered
 * with the half-open window [day 00:00 ET, day+1 00:00 ET): Postgres's
 * `naive_ts AT TIME ZONE 'America/New_York'` interprets the naive timestamp
 * as ET wall time and yields the correct UTC instant across DST changes.
 * Counter tables carry the ET day directly in their `day` column.
 */
export async function loadAbuseDigestData(day: string): Promise<AbuseDigestStats> {
  const dayStart = sql`((${day})::date)::timestamp AT TIME ZONE 'America/New_York'`;
  const dayEnd = sql`(((${day})::date + 1))::timestamp AT TIME ZONE 'America/New_York'`;

  // 1. Signups + total users.
  const signupRows = await db
    .select({ email: users.email, name: users.name, createdAt: users.createdAt })
    .from(users)
    .where(and(gte(users.createdAt, dayStart), lt(users.createdAt, dayEnd)))
    .orderBy(asc(users.createdAt));
  const signups: SignupRow[] = signupRows.map((r) => ({
    email: r.email,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
  }));

  const [{ totalUsers }] = await db
    .select({ totalUsers: sql<number>`count(*)::int` })
    .from(users);

  // 2. Per-user read counters for the day.
  const counters: CounterRow[] = await db
    .select({
      userId: userActivityDaily.userId,
      metric: userActivityDaily.metric,
      count: userActivityDaily.count,
    })
    .from(userActivityDaily)
    .where(eq(userActivityDaily.day, day));

  // 3. Same-day creations, grouped per user.
  const watchlistRows = await db
    .select({ userId: watchlistItems.userId, n: sql<number>`count(*)::int` })
    .from(watchlistItems)
    .where(and(gte(watchlistItems.addedAt, dayStart), lt(watchlistItems.addedAt, dayEnd)))
    .groupBy(watchlistItems.userId);
  const savedViewRows = await db
    .select({ userId: savedViews.userId, n: sql<number>`count(*)::int` })
    .from(savedViews)
    .where(and(gte(savedViews.createdAt, dayStart), lt(savedViews.createdAt, dayEnd)))
    .groupBy(savedViews.userId);
  const categoryRows = await db
    .select({ userId: customCategories.userId, n: sql<number>`count(*)::int` })
    .from(customCategories)
    .where(and(gte(customCategories.createdAt, dayStart), lt(customCategories.createdAt, dayEnd)))
    .groupBy(customCategories.userId);

  // 4. Identity for every user involved.
  const involvedIds = [
    ...new Set([
      ...counters.map((c) => c.userId),
      ...watchlistRows.map((r) => r.userId),
      ...savedViewRows.map((r) => r.userId),
      ...categoryRows.map((r) => r.userId),
    ]),
  ];
  const userInfo = new Map<string, UserInfo>();
  if (involvedIds.length > 0) {
    const infoRows = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, involvedIds));
    for (const r of infoRows) userInfo.set(r.id, { email: r.email, name: r.name });
  }

  const activeUsers = assemblePerUserActivity(
    counters,
    {
      watchlistAdds: new Map(watchlistRows.map((r) => [r.userId, r.n])),
      savedViewsCreated: new Map(savedViewRows.map((r) => [r.userId, r.n])),
      customCategoriesCreated: new Map(categoryRows.map((r) => [r.userId, r.n])),
    },
    userInfo,
  );

  // 5. Sign-ins (supplementary; latest-stamp only — see spec).
  const signInRows = await db
    .select({ email: users.email })
    .from(users)
    .where(and(gte(users.lastLoginAt, dayStart), lt(users.lastLoginAt, dayEnd)));
  const signIns = {
    count: signInRows.length,
    emails: signInRows.slice(0, SIGNIN_EMAILS_CAP).map((r) => r.email),
  };

  // 6. App-wide contact counters.
  const appRows = await db
    .select({ metric: appActivityDaily.metric, count: appActivityDaily.count })
    .from(appActivityDaily)
    .where(eq(appActivityDaily.day, day));
  const contact = {
    submissions: appRows.find((r) => r.metric === 'contact_submission')?.count ?? 0,
    honeypotTrips: appRows.find((r) => r.metric === 'contact_honeypot')?.count ?? 0,
  };

  return { day, totalUsers, signups, activeUsers, signIns, contact };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0. (If drizzle complains about comparing a timestamp column to an SQL fragment in `gte`/`lt`, wrap the comparison as `sql`${users.createdAt} >= ${dayStart}`` inside `and(...)` — but the `gte(column, sqlFragment)` form typechecks on drizzle-orm 0.45.)

- [ ] **Step 3: Commit**

```bash
git add lib/notifications/abuseDigest/loadAbuseDigestData.ts
git commit -m "feat(abuse-digest): day-scoped data loader

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Flag evaluation (TDD)

**Files:**
- Create: `lib/notifications/abuseDigest/evaluateFlags.test.ts`
- Create: `lib/notifications/abuseDigest/evaluateFlags.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/notifications/abuseDigest/evaluateFlags.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateFlags } from './evaluateFlags';
import type { AbuseDigestStats, PerUserActivity } from './types';

function quietStats(): AbuseDigestStats {
  return {
    day: '2026-07-12',
    totalUsers: 2,
    signups: [],
    activeUsers: [],
    signIns: { count: 0, emails: [] },
    contact: { submissions: 0, honeypotTrips: 0 },
  };
}

function userWith(overrides: Partial<PerUserActivity>): PerUserActivity {
  return {
    userId: 'u1',
    email: 'a@x.com',
    name: null,
    explorerQueries: 0,
    detailViews: 0,
    watchlistAdds: 0,
    savedViewsCreated: 0,
    customCategoriesCreated: 0,
    ...overrides,
  };
}

function signup(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    email: `s${i}@x.com`,
    name: null,
    createdAt: '2026-07-12T12:00:00.000Z',
  }));
}

describe('evaluateFlags', () => {
  it('returns no flags on a quiet day', () => {
    expect(evaluateFlags(quietStats())).toEqual([]);
  });

  it('does not flag AT a threshold (strictly greater-than)', () => {
    const stats = { ...quietStats(), signups: signup(10) };
    expect(evaluateFlags(stats)).toEqual([]);
  });

  it('flags signups amber above 10 and red above 25 (one flag, red supersedes)', () => {
    expect(evaluateFlags({ ...quietStats(), signups: signup(11) })).toEqual([
      { severity: 'amber', message: '11 signups yesterday (amber threshold: 10)' },
    ]);
    const red = evaluateFlags({ ...quietStats(), signups: signup(26) });
    expect(red).toEqual([{ severity: 'red', message: '26 signups yesterday (red threshold: 25)' }]);
  });

  it('flags per-user reads (queries + detail views combined)', () => {
    const amber = evaluateFlags({
      ...quietStats(),
      activeUsers: [userWith({ explorerQueries: 400, detailViews: 101 })],
    });
    expect(amber).toEqual([
      { severity: 'amber', message: 'a@x.com: 501 reads (amber threshold: 500)' },
    ]);
    const red = evaluateFlags({
      ...quietStats(),
      activeUsers: [userWith({ explorerQueries: 2001 })],
    });
    expect(red[0].severity).toBe('red');
  });

  it('flags per-user creations', () => {
    const flags = evaluateFlags({
      ...quietStats(),
      activeUsers: [
        userWith({ watchlistAdds: 101, savedViewsCreated: 16, customCategoriesCreated: 11 }),
      ],
    });
    expect(flags).toEqual([
      { severity: 'amber', message: 'a@x.com: 101 watchlist adds (amber threshold: 100)' },
      { severity: 'amber', message: 'a@x.com: 16 saved views created (amber threshold: 15)' },
      { severity: 'amber', message: 'a@x.com: 11 custom categories created (amber threshold: 10)' },
    ]);
    const red = evaluateFlags({ ...quietStats(), activeUsers: [userWith({ watchlistAdds: 501 })] });
    expect(red).toEqual([
      { severity: 'red', message: 'a@x.com: 501 watchlist adds (red threshold: 500)' },
    ]);
  });

  it('flags contact-form pressure', () => {
    const flags = evaluateFlags({
      ...quietStats(),
      contact: { submissions: 11, honeypotTrips: 21 },
    });
    expect(flags).toEqual([
      { severity: 'amber', message: '21 honeypot trips yesterday (amber threshold: 20)' },
      { severity: 'amber', message: '11 contact submissions yesterday (amber threshold: 10)' },
    ]);
  });

  it('sorts red flags before amber', () => {
    const flags = evaluateFlags({
      ...quietStats(),
      signups: signup(11), // amber
      activeUsers: [userWith({ explorerQueries: 3000 })], // red
    });
    expect(flags.map((f) => f.severity)).toEqual(['red', 'amber']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/notifications/abuseDigest/evaluateFlags.test.ts`
Expected: FAIL — cannot resolve `./evaluateFlags`.

- [ ] **Step 3: Implement**

Create `lib/notifications/abuseDigest/evaluateFlags.ts`:

```ts
// lib/notifications/abuseDigest/evaluateFlags.ts
// Pure threshold evaluation. This module is the single tuning point for
// what the digest flags — and the seam a future intra-day tripwire would
// reuse unchanged (deferred v2; see the spec's non-goals).
import type { AbuseDigestStats, Flag } from './types';

/**
 * V1 thresholds are deliberate GUESSES (2026-07-13, pre-launch traffic ≈
 * two known users). Tune against real digest data; all comparisons are
 * strictly greater-than.
 */
export const THRESHOLDS = {
  signupsPerDay: { amber: 10, red: 25 },
  userReadsPerDay: { amber: 500, red: 2000 }, // explorer queries + detail views
  userWatchlistAddsPerDay: { amber: 100, red: 500 },
  userSavedViewsPerDay: { amber: 15 },
  userCustomCategoriesPerDay: { amber: 10 },
  honeypotTripsPerDay: { amber: 20 },
  contactSubmissionsPerDay: { amber: 10 },
} as const;

export function evaluateFlags(stats: AbuseDigestStats): Flag[] {
  const flags: Flag[] = [];

  const banded = (
    value: number,
    t: { amber: number; red?: number },
    label: (v: number, threshold: number, sev: 'amber' | 'red') => string,
  ) => {
    if (t.red !== undefined && value > t.red) {
      flags.push({ severity: 'red', message: label(value, t.red, 'red') });
    } else if (value > t.amber) {
      flags.push({ severity: 'amber', message: label(value, t.amber, 'amber') });
    }
  };

  banded(stats.signups.length, THRESHOLDS.signupsPerDay, (v, th, sev) =>
    `${v} signups yesterday (${sev} threshold: ${th})`,
  );

  for (const u of stats.activeUsers) {
    banded(u.explorerQueries + u.detailViews, THRESHOLDS.userReadsPerDay, (v, th, sev) =>
      `${u.email}: ${v} reads (${sev} threshold: ${th})`,
    );
    banded(u.watchlistAdds, THRESHOLDS.userWatchlistAddsPerDay, (v, th, sev) =>
      `${u.email}: ${v} watchlist adds (${sev} threshold: ${th})`,
    );
    banded(u.savedViewsCreated, THRESHOLDS.userSavedViewsPerDay, (v, th, sev) =>
      `${u.email}: ${v} saved views created (${sev} threshold: ${th})`,
    );
    banded(u.customCategoriesCreated, THRESHOLDS.userCustomCategoriesPerDay, (v, th, sev) =>
      `${u.email}: ${v} custom categories created (${sev} threshold: ${th})`,
    );
  }

  banded(stats.contact.honeypotTrips, THRESHOLDS.honeypotTripsPerDay, (v, th, sev) =>
    `${v} honeypot trips yesterday (${sev} threshold: ${th})`,
  );
  banded(stats.contact.submissions, THRESHOLDS.contactSubmissionsPerDay, (v, th, sev) =>
    `${v} contact submissions yesterday (${sev} threshold: ${th})`,
  );

  // Red first so the worst news leads the email.
  return flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/notifications/abuseDigest/evaluateFlags.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/notifications/abuseDigest/evaluateFlags.ts lib/notifications/abuseDigest/evaluateFlags.test.ts
git commit -m "feat(abuse-digest): pure flag evaluation with v1 thresholds

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Email builder (TDD)

**Files:**
- Create: `lib/notifications/abuseDigest/buildAbuseDigestEmail.test.ts`
- Create: `lib/notifications/abuseDigest/buildAbuseDigestEmail.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/notifications/abuseDigest/buildAbuseDigestEmail.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildAbuseDigestEmail, ACTIVE_USER_ROW_CAP } from './buildAbuseDigestEmail';
import type { AbuseDigestStats, PerUserActivity } from './types';

function quietStats(): AbuseDigestStats {
  return {
    day: '2026-07-12',
    totalUsers: 2,
    signups: [],
    activeUsers: [],
    signIns: { count: 0, emails: [] },
    contact: { submissions: 0, honeypotTrips: 0 },
  };
}

function activeUser(i: number, reads: number): PerUserActivity {
  return {
    userId: `u${i}`,
    email: `user${i}@x.com`,
    name: null,
    explorerQueries: reads,
    detailViews: 0,
    watchlistAdds: 0,
    savedViewsCreated: 0,
    customCategoriesCreated: 0,
  };
}

describe('buildAbuseDigestEmail', () => {
  it('quiet day: pulse subject with zeros, "all quiet" body, still a full email', () => {
    const built = buildAbuseDigestEmail(quietStats(), []);
    expect(built.subject).toBe('KeywordQuarry daily — 0 signups · 0 active · 0 reads');
    expect(built.html).toContain('All quiet');
    expect(built.text).toContain('All quiet');
    expect(built.html).toContain('2026-07-12');
  });

  it('normal day: subject carries signups/active/reads; body lists signups and activity', () => {
    const stats: AbuseDigestStats = {
      ...quietStats(),
      signups: [{ email: 'new@x.com', name: 'New Person', createdAt: '2026-07-12T15:30:00.000Z' }],
      activeUsers: [activeUser(1, 1200), activeUser(2, 34)],
      signIns: { count: 2, emails: ['user1@x.com', 'user2@x.com'] },
      contact: { submissions: 1, honeypotTrips: 3 },
    };
    const built = buildAbuseDigestEmail(stats, []);
    expect(built.subject).toBe('KeywordQuarry daily — 1 signup · 2 active · 1,234 reads');
    expect(built.html).toContain('new@x.com');
    expect(built.html).toContain('user1@x.com');
    expect(built.html).toContain('1,200');
    expect(built.text).toContain('new@x.com');
    expect(built.html).toContain('/admin');
  });

  it('flags prefix the subject and render before everything else', () => {
    const built = buildAbuseDigestEmail(quietStats(), [
      { severity: 'red', message: 'bad thing' },
      { severity: 'amber', message: 'warm thing' },
    ]);
    expect(built.subject).toBe('⚠️ 2 flags — KeywordQuarry daily — 0 signups · 0 active · 0 reads');
    expect(built.html.indexOf('bad thing')).toBeLessThan(built.html.indexOf('All quiet'));
    expect(built.text).toContain('bad thing');
  });

  it('uses singular "flag" for one flag', () => {
    const built = buildAbuseDigestEmail(quietStats(), [{ severity: 'amber', message: 'x' }]);
    expect(built.subject.startsWith('⚠️ 1 flag —')).toBe(true);
  });

  it(`caps the activity table at ${ACTIVE_USER_ROW_CAP} rows and says how many were dropped`, () => {
    const stats = {
      ...quietStats(),
      activeUsers: Array.from({ length: ACTIVE_USER_ROW_CAP + 3 }, (_, i) => activeUser(i, 100 - i)),
    };
    const built = buildAbuseDigestEmail(stats, []);
    expect(built.html).toContain(`user${ACTIVE_USER_ROW_CAP - 1}@x.com`);
    expect(built.html).not.toContain(`user${ACTIVE_USER_ROW_CAP}@x.com`);
    expect(built.html).toContain('and 3 more active users');
  });

  it('escapes HTML in user-controlled fields', () => {
    const stats: AbuseDigestStats = {
      ...quietStats(),
      signups: [{ email: 'x@x.com', name: '<script>alert(1)</script>', createdAt: '2026-07-12T15:30:00.000Z' }],
    };
    const built = buildAbuseDigestEmail(stats, []);
    expect(built.html).not.toContain('<script>');
    expect(built.html).toContain('&lt;script&gt;');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/notifications/abuseDigest/buildAbuseDigestEmail.test.ts`
Expected: FAIL — cannot resolve `./buildAbuseDigestEmail`.

- [ ] **Step 3: Implement**

Create `lib/notifications/abuseDigest/buildAbuseDigestEmail.ts`:

```ts
// lib/notifications/abuseDigest/buildAbuseDigestEmail.ts
// Pure builder for the daily admin abuse-digest email. Mirrors
// buildDigestEmail.ts: no network, returns { subject, text, html }.
// The subject line IS the quiet-day pulse — flags, signups, active users,
// and total reads are readable without opening the email.
import type { AbuseDigestStats, Flag } from './types';

export const ACTIVE_USER_ROW_CAP = 25;

const AMBER_BG = '#fef3c7';
const AMBER_BORDER = '#f59e0b';
const RED_BG = '#fee2e2';
const RED_BORDER = '#dc2626';

export interface BuiltAbuseDigestEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildAbuseDigestEmail(stats: AbuseDigestStats, flags: Flag[]): BuiltAbuseDigestEmail {
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com';
  const totalReads = stats.activeUsers.reduce((s, u) => s + u.explorerQueries + u.detailViews, 0);

  const pulse = `${stats.signups.length} signup${plural(stats.signups.length)} · ${stats.activeUsers.length} active · ${totalReads.toLocaleString()} reads`;
  const subject = flags.length
    ? `⚠️ ${flags.length} flag${plural(flags.length)} — KeywordQuarry daily — ${pulse}`
    : `KeywordQuarry daily — ${pulse}`;

  const quiet = stats.signups.length === 0 && stats.activeUsers.length === 0;
  const shownUsers = stats.activeUsers.slice(0, ACTIVE_USER_ROW_CAP);
  const droppedUsers = stats.activeUsers.length - shownUsers.length;

  // ---------- text ----------
  const textLines: string[] = [`KeywordQuarry daily digest — ${stats.day}`, ''];
  if (flags.length) {
    textLines.push('FLAGS:');
    for (const f of flags) textLines.push(`  [${f.severity.toUpperCase()}] ${f.message}`);
    textLines.push('');
  }
  if (quiet) {
    textLines.push('All quiet — no signups and no user activity.');
  } else {
    textLines.push(`Signups (${stats.signups.length}) — total users now ${stats.totalUsers}:`);
    for (const s of stats.signups) textLines.push(`  ${s.email}${s.name ? ` (${s.name})` : ''} at ${s.createdAt}`);
    textLines.push('');
    textLines.push(`Active users (${stats.activeUsers.length}):`);
    for (const u of shownUsers) {
      textLines.push(
        `  ${u.email}: ${u.explorerQueries} queries, ${u.detailViews} detail views, ` +
          `${u.watchlistAdds} watchlist adds, ${u.savedViewsCreated} views, ${u.customCategoriesCreated} categories`,
      );
    }
    if (droppedUsers > 0) textLines.push(`  ...and ${droppedUsers} more active users`);
  }
  textLines.push('');
  textLines.push(`Sign-ins: ${stats.signIns.count}${stats.signIns.emails.length ? ` (${stats.signIns.emails.join(', ')})` : ''}`);
  textLines.push(`Contact form: ${stats.contact.submissions} submissions, ${stats.contact.honeypotTrips} honeypot trips`);
  textLines.push('');
  textLines.push(`Admin: ${appUrl}/admin/abuse-digest`);
  const text = textLines.join('\n');

  // ---------- html ----------
  const flagsHtml = flags
    .map((f) => {
      const bg = f.severity === 'red' ? RED_BG : AMBER_BG;
      const border = f.severity === 'red' ? RED_BORDER : AMBER_BORDER;
      return `<div style="background:${bg};border-left:4px solid ${border};padding:8px 12px;margin:0 0 8px 0;font-size:13px;color:#111;">${escapeHtml(f.message)}</div>`;
    })
    .join('');

  const signupsHtml = stats.signups.length
    ? `<ul style="margin:0 0 4px 0;padding-left:18px;font-size:13px;color:#333;">${stats.signups
        .map((s) => `<li><strong>${escapeHtml(s.email)}</strong>${s.name ? ` (${escapeHtml(s.name)})` : ''} — ${escapeHtml(fmtTime(s.createdAt))}</li>`)
        .join('')}</ul>`
    : `<p style="margin:0;font-size:13px;color:#6b7280;">No signups.</p>`;

  const activityHtml = stats.activeUsers.length
    ? `<table style="border-collapse:collapse;width:100%;font-size:12px;">
        <thead><tr style="text-align:left;color:#555;border-bottom:1px solid #e5e7eb;">
          <th style="padding:5px 8px 5px 0;">User</th>
          <th style="padding:5px 8px;text-align:right;">Queries</th>
          <th style="padding:5px 8px;text-align:right;">Detail views</th>
          <th style="padding:5px 8px;text-align:right;">Watchlist adds</th>
          <th style="padding:5px 8px;text-align:right;">Saved views</th>
          <th style="padding:5px 0 5px 8px;text-align:right;">Categories</th>
        </tr></thead>
        <tbody>${shownUsers
          .map(
            (u) => `<tr style="border-bottom:1px solid #f3f4f6;">
          <td style="padding:5px 8px 5px 0;">${escapeHtml(u.email)}</td>
          <td style="padding:5px 8px;text-align:right;">${u.explorerQueries.toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right;">${u.detailViews.toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right;">${u.watchlistAdds.toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right;">${u.savedViewsCreated.toLocaleString()}</td>
          <td style="padding:5px 0 5px 8px;text-align:right;">${u.customCategoriesCreated.toLocaleString()}</td>
        </tr>`,
          )
          .join('')}</tbody>
      </table>${droppedUsers > 0 ? `<p style="margin:6px 0 0 0;font-size:12px;color:#6b7280;">…and ${droppedUsers} more active users</p>` : ''}`
    : `<p style="margin:0;font-size:13px;color:#6b7280;">No user activity.</p>`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px 16px;color:#111;">
    <h1 style="margin:0 0 4px 0;font-size:18px;">KeywordQuarry daily digest</h1>
    <p style="margin:0 0 16px 0;font-size:13px;color:#6b7280;">${escapeHtml(stats.day)} (ET) · ${stats.totalUsers} total users</p>
    ${flagsHtml ? `<div style="margin:0 0 16px 0;">${flagsHtml}</div>` : ''}
    ${
      quiet
        ? `<p style="margin:0 0 16px 0;font-size:14px;color:#333;">All quiet — no signups and no user activity.</p>`
        : `
    <h2 style="margin:0 0 6px 0;font-size:14px;">Signups (${stats.signups.length})</h2>
    ${signupsHtml}
    <h2 style="margin:18px 0 6px 0;font-size:14px;">Active users (${stats.activeUsers.length})</h2>
    ${activityHtml}`
    }
    <p style="margin:18px 0 0 0;font-size:13px;color:#333;">
      Sign-ins: <strong>${stats.signIns.count}</strong>${stats.signIns.emails.length ? ` (${escapeHtml(stats.signIns.emails.join(', '))})` : ''}<br/>
      Contact form: <strong>${stats.contact.submissions}</strong> submissions, <strong>${stats.contact.honeypotTrips}</strong> honeypot trips
    </p>
    <p style="margin:20px 0 0 0;font-size:12px;color:#6b7280;">
      <a href="${appUrl}/admin/abuse-digest" style="color:#2563eb;">Open the admin digest page</a> · generated ${new Date().toISOString()}
    </p>
  </div>`;

  return { subject, text, html };
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

/** '2026-07-12T15:30:00.000Z' → '15:30 UTC' (compact; the day is in the header). */
function fmtTime(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? `${m[1]} UTC` : iso;
}

// Same escaping set as sendContactEmail.ts / buildImportEmail.ts.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/notifications/abuseDigest/buildAbuseDigestEmail.test.ts`
Expected: PASS (6 tests). Note the "1,234 reads" test: 1,200 + 34 = 1,234 — `toLocaleString()` in a Node ≥22 default locale emits the comma; if this ever fails on locale grounds, the fix is forcing `toLocaleString('en-US')` in the builder, not changing the test.

- [ ] **Step 5: Commit**

```bash
git add lib/notifications/abuseDigest/buildAbuseDigestEmail.ts lib/notifications/abuseDigest/buildAbuseDigestEmail.test.ts
git commit -m "feat(abuse-digest): pure email builder (pulse subject, flags-first body)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Send orchestrator

No unit test (thin impure glue over already-tested parts; mirrors the untested-by-unit sendWeeklyDigest orchestrator). Verified end-to-end in Task 12.

**Files:**
- Create: `lib/notifications/abuseDigest/sendAbuseDigest.ts`

- [ ] **Step 1: Implement**

Create `lib/notifications/abuseDigest/sendAbuseDigest.ts`:

```ts
// lib/notifications/abuseDigest/sendAbuseDigest.ts
//
// IMPORTANT: do NOT add `import 'server-only'` here — this runs on the
// Railway worker (see lib/notifications/digest/sendWeeklyDigest.ts).
//
// Orchestrator: idempotency key check → load → flags → build → ONE Resend
// email to all admins → advance the key. Send-then-mark (at-least-once): a
// crash between send and mark re-sends on retry — a duplicate email to the
// admin inbox is harmless, a silent miss is not.
import { Resend } from 'resend';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { appSettings, users } from '@/db/schema';
import { isUndeliverableEmail } from '@/lib/notifications/digest/recipients';
import { previousEtDay } from '@/lib/activity/etDay';
import { loadAbuseDigestData } from './loadAbuseDigestData';
import { evaluateFlags } from './evaluateFlags';
import { buildAbuseDigestEmail } from './buildAbuseDigestEmail';

const LAST_SENT_KEY = 'abuse_digest:last_sent_day';

export interface SendAbuseDigestResult {
  day: string;
  skipped?: 'already_sent' | 'not_configured' | 'no_recipients';
  sent: boolean;
  recipients: number;
  flags: number;
  activeUsers: number;
}

export async function sendAbuseDigest(opts?: {
  day?: string;
  force?: boolean;
}): Promise<SendAbuseDigestResult> {
  const day = opts?.day ?? previousEtDay(new Date());
  const base = { day, sent: false, recipients: 0, flags: 0, activeUsers: 0 };

  // 1. Idempotency gate ('YYYY-MM-DD' strings compare correctly as text).
  if (!opts?.force) {
    const last = await getLastSentDay();
    if (last && last >= day) {
      console.log(`[abuse-digest] already sent for ${last} — skipping ${day}.`);
      return { ...base, skipped: 'already_sent' };
    }
  }

  // 2. Load + evaluate + build.
  const stats = await loadAbuseDigestData(day);
  const flags = evaluateFlags(stats);
  const built = buildAbuseDigestEmail(stats, flags);

  // 3. Recipients: every admin with a deliverable email.
  const adminRows = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNotNull(users.email)));
  const recipients = adminRows.map((r) => r.email).filter((e) => !!e && !isUndeliverableEmail(e));
  if (recipients.length === 0) {
    console.warn('[abuse-digest] no admin recipients — nothing sent, key not advanced.');
    return { ...base, skipped: 'no_recipients', flags: flags.length, activeUsers: stats.activeUsers.length };
  }

  // 4. Send (fail-soft without an API key — local dev).
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'onboarding@resend.dev';
  if (!apiKey) {
    console.warn(`[abuse-digest] RESEND_API_KEY not set — skipping send for ${day}.`);
    return { ...base, skipped: 'not_configured', recipients: recipients.length, flags: flags.length, activeUsers: stats.activeUsers.length };
  }
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: recipients,
    subject: built.subject,
    html: built.html,
    text: built.text,
  });
  if (error) {
    // Throw so the Inngest wrapper retries (key not advanced → safe re-send).
    throw new Error(`[abuse-digest] Resend error: ${error.message ?? 'send failed'}`);
  }

  // 5. Advance the key — only for COMPLETED ET days. A "today so far" send
  //    (or a typo'd future day) must never seal tomorrow's cron window: the
  //    full-day digest for today still needs to go out tomorrow morning.
  //    Backwards moves are blocked inside advanceLastSentDay.
  if (day <= previousEtDay(new Date())) await advanceLastSentDay(day);

  return {
    day,
    sent: true,
    recipients: recipients.length,
    flags: flags.length,
    activeUsers: stats.activeUsers.length,
  };
}

async function getLastSentDay(): Promise<string | null> {
  const rows = await db
    .select({ valueJson: appSettings.valueJson })
    .from(appSettings)
    .where(eq(appSettings.key, LAST_SENT_KEY));
  const v = rows[0]?.valueJson as { day?: unknown } | undefined;
  return typeof v?.day === 'string' ? v.day : null;
}

async function advanceLastSentDay(day: string): Promise<void> {
  // Atomic monotone advance: the conditional lives IN the upsert, so two
  // concurrent sends can never move the key backwards (YYYY-MM-DD compares
  // correctly as text; a missing 'day' key yields NULL → no update).
  await db
    .insert(appSettings)
    .values({ key: LAST_SENT_KEY, valueJson: { day } })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { valueJson: { day }, updatedAt: new Date() },
      setWhere: sql`(${appSettings.valueJson}->>'day') < ${day}`,
    });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add lib/notifications/abuseDigest/sendAbuseDigest.ts
git commit -m "feat(abuse-digest): send orchestrator with app_settings idempotency key

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Inngest cron function

**Files:**
- Create: `inngest/functions/sendAbuseDigest.ts`
- Modify: `inngest/functions/index.ts`

- [ ] **Step 1: Implement the cron wrapper**

Create `inngest/functions/sendAbuseDigest.ts`:

```ts
// inngest/functions/sendAbuseDigest.ts
/**
 * Daily admin abuse-digest — 7:30am ET, covering the previous ET calendar
 * day. Runs on the Railway worker. The orchestrator's app_settings key
 * makes retry re-invocations safe (they exit 'already_sent'); retries
 * usefully cover pre-send transient errors (loader/Neon blips) and failed
 * Resend sends (the key only advances after a successful send).
 *
 * See docs/superpowers/specs/2026-07-13-abuse-digest-design.md.
 */
import { inngest } from '../client';
import { sendAbuseDigest } from '@/lib/notifications/abuseDigest/sendAbuseDigest';

export const sendAbuseDigestFn = inngest.createFunction(
  {
    id: 'send-abuse-digest',
    name: 'Send daily admin abuse digest',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=America/New_York 30 7 * * *' }],
  },
  async ({ step }) => {
    return step.run('send', () => sendAbuseDigest());
  },
);
```

- [ ] **Step 2: Register it**

In `inngest/functions/index.ts`, add the import after the `sendWeeklyDigestFn` import:

```ts
import { sendAbuseDigestFn } from './sendAbuseDigest';
```

and add `sendAbuseDigestFn,` to the `functions` array (after `sendWeeklyDigestFn,`).

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add inngest/functions/sendAbuseDigest.ts inngest/functions/index.ts
git commit -m "feat(abuse-digest): daily 7:30am ET Inngest cron

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Admin preview page + Send-now route + nav link

**Files:**
- Create: `app/api/admin/abuse-digest/send/route.ts`
- Create: `app/admin/abuse-digest/SendNowButton.tsx`
- Create: `app/admin/abuse-digest/page.tsx`
- Modify: `app/admin/layout.tsx`

- [ ] **Step 1: The admin force-send route**

Create `app/api/admin/abuse-digest/send/route.ts`:

```ts
// app/api/admin/abuse-digest/send/route.ts
/**
 * Admin endpoint: force-send the abuse digest for a given ET day (defaults
 * to yesterday). Runs the orchestrator inline (one email — fast), with
 * force=true so re-sends and today-so-far sends bypass the idempotency key.
 *
 * Body: { day?: 'YYYY-MM-DD' }
 * Response: SendAbuseDigestResult | { error } (4xx/5xx)
 */
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { sendAbuseDigest } from '@/lib/notifications/abuseDigest/sendAbuseDigest';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as { day?: unknown };
  let day: string | undefined;
  if (body.day !== undefined) {
    if (typeof body.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.day)) {
      return NextResponse.json({ error: 'day must be YYYY-MM-DD' }, { status: 400 });
    }
    day = body.day;
  }

  try {
    const result = await sendAbuseDigest({ day, force: true });
    return NextResponse.json(result);
  } catch (e) {
    console.error('[abuse-digest] force send failed:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'send failed' },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: The Send-now client button**

Create `app/admin/abuse-digest/SendNowButton.tsx`:

```tsx
'use client';

import { useState } from 'react';

/** Posts the page's displayed day to the force-send route and shows the result. */
export function SendNowButton({ day }: { day: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [detail, setDetail] = useState<string>('');

  async function send() {
    setState('sending');
    setDetail('');
    try {
      const res = await fetch('/api/admin/abuse-digest/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day }),
      });
      const json = await res.json();
      if (!res.ok) {
        setState('error');
        setDetail(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setState('done');
      setDetail(
        json.sent
          ? `Sent to ${json.recipients} admin${json.recipients === 1 ? '' : 's'} (${json.flags} flags).`
          : `Not sent: ${json.skipped ?? 'unknown'}`,
      );
    } catch (e) {
      setState('error');
      setDetail(e instanceof Error ? e.message : 'request failed');
    }
  }

  return (
    <span className="inline-flex items-center gap-3">
      <button
        onClick={send}
        disabled={state === 'sending'}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {state === 'sending' ? 'Sending…' : `Send now (${day})`}
      </button>
      {detail && (
        <span className={`text-sm ${state === 'error' ? 'text-red-700' : 'text-gray-600'}`}>{detail}</span>
      )}
    </span>
  );
}
```

- [ ] **Step 3: The preview page**

Create `app/admin/abuse-digest/page.tsx`:

```tsx
// app/admin/abuse-digest/page.tsx
/**
 * Non-sending browser preview of the daily abuse-digest email, for any ET
 * day (?day=YYYY-MM-DD, default yesterday), plus a Send-now button that
 * force-sends the displayed day to all admins. Admin-gating is enforced by
 * app/admin/layout.tsx (requireAdmin).
 */
import Link from 'next/link';
import { etDay, previousEtDay } from '@/lib/activity/etDay';
import { loadAbuseDigestData } from '@/lib/notifications/abuseDigest/loadAbuseDigestData';
import { evaluateFlags } from '@/lib/notifications/abuseDigest/evaluateFlags';
import { buildAbuseDigestEmail } from '@/lib/notifications/abuseDigest/buildAbuseDigestEmail';
import { SendNowButton } from './SendNowButton';

export const dynamic = 'force-dynamic';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AbuseDigestPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  const sp = await searchParams;
  const yesterday = previousEtDay(new Date());
  const today = etDay(new Date());
  const day = sp.day && DAY_RE.test(sp.day) ? sp.day : yesterday;

  const stats = await loadAbuseDigestData(day);
  const flags = evaluateFlags(stats);
  const built = buildAbuseDigestEmail(stats, flags);

  return (
    <div>
      <h1 className="mb-2 text-xl font-semibold">Abuse digest</h1>
      <p className="mb-4 text-sm text-gray-600">
        Preview for <strong>{day}</strong> (ET). No email sent by viewing this page. The cron sends
        yesterday&apos;s digest at 7:30am ET daily.
      </p>
      <div className="mb-4 flex items-center gap-4 text-sm">
        <Link href={`/admin/abuse-digest?day=${yesterday}`} className="text-blue-700 underline">
          Yesterday ({yesterday})
        </Link>
        <Link href={`/admin/abuse-digest?day=${today}`} className="text-blue-700 underline">
          Today so far ({today})
        </Link>
        <SendNowButton day={day} />
      </div>
      <p className="mb-2 text-sm text-gray-600">
        Subject: <strong>{built.subject}</strong>
      </p>
      <div className="rounded border border-gray-200 bg-white p-2">
        <div dangerouslySetInnerHTML={{ __html: built.html }} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Sidebar nav link**

In `app/admin/layout.tsx`, after the existing Weekly digests link:

```tsx
          <Link href="/admin/digests" className="hover:underline">
            Weekly digests
          </Link>
```

add:

```tsx
          <Link href="/admin/abuse-digest" className="hover:underline">
            Abuse digest
          </Link>
```

- [ ] **Step 5: Verify — typecheck + full suite + build**

Run: `pnpm typecheck` → exit 0.
Run: `pnpm test` → all tests pass (including the ~26 new ones from Tasks 2/5/7/8).
Run: `pnpm build` → completes without errors. (The new page/route compile; nothing queries the DB at build time — the page is `force-dynamic`.)

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/abuse-digest/send/route.ts app/admin/abuse-digest/SendNowButton.tsx app/admin/abuse-digest/page.tsx app/admin/layout.tsx
git commit -m "feat(abuse-digest): admin preview page + force-send route + nav link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: Ship — migration, push, Clerk config, E2E (HUMAN CHECKPOINTS)

Everything here requires the user's explicit go-ahead. **Stop and ask before each starred step.**

- [ ] **Step 1 ★ (user): apply migration 0043 to Neon**

Ask the user to confirm, then run:

```bash
APPLY_0043=yes node --env-file=.env.local --import tsx scripts/applyMigration0043.ts
```

Expected: `✅ 0043 applied — user_activity_daily + app_activity_daily exist`. Instant (two empty tables).

- [ ] **Step 2: local smoke test via a no-auth script**

**Do NOT use the local `/admin` page for this** — since the 2026-07-13 Clerk cutover, localhost signs in via the DEV Clerk instance while the owner's `users` row carries the PROD Clerk ID, so local admin auth misses (pre-existing wrinkle, unrelated to this feature). Instead, write a throwaway script `scripts/previewAbuseDigest.ts` (untracked, per repo convention):

```ts
/** Smoke-test the abuse-digest loader + builder against the real DB (read-only). */
import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  const { etDay } = await import('@/lib/activity/etDay');
  const { loadAbuseDigestData } = await import('@/lib/notifications/abuseDigest/loadAbuseDigestData');
  const { evaluateFlags } = await import('@/lib/notifications/abuseDigest/evaluateFlags');
  const { buildAbuseDigestEmail } = await import('@/lib/notifications/abuseDigest/buildAbuseDigestEmail');

  const day = process.argv[2] ?? etDay(new Date());
  const stats = await loadAbuseDigestData(day);
  const flags = evaluateFlags(stats);
  const built = buildAbuseDigestEmail(stats, flags);
  console.log('day:', day);
  console.log('subject:', built.subject);
  console.log('stats:', JSON.stringify({ ...stats, activeUsers: stats.activeUsers.length }, null, 2));
  console.log('flags:', flags);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Run: `node --env-file=.env.local --import tsx scripts/previewAbuseDigest.ts`
Expected: a quiet-day subject (`KeywordQuarry daily — 0 signups · …`) and zeroed stats, no SQL errors. This exercises the loader's real SQL (the part unit tests can't reach). The admin preview PAGE is verified on production in Step 5.

- [ ] **Step 3 ★ (user): pre-push job check + push authorization**

Run `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` — confirm no running import/Keepa jobs (a push restarts the Railway worker). Then ask the user to authorize `git push`. Only push after an explicit yes.

- [ ] **Step 4 ★ (user): tick `session.created` in Clerk**

After deploy, the user adds `session.created` to the subscribed events of the keywordquarry.com webhook endpoint in the Clerk dashboard (Configure → Webhooks). Until then, sign-in stamping simply doesn't fire; everything else works.

- [ ] **Step 5: production E2E**

1. Open `https://keywordquarry.com/admin/abuse-digest` — preview renders.
2. Click **Send now** — expect "Sent to 1 admin (0 flags)." and the email in raw5045@gmail.com's inbox (subject `KeywordQuarry daily — …`).
3. Sign out/in once (after Step 4) and confirm the preview's today view shows the sign-in.
4. Next morning after 7:30am ET: confirm the cron email arrived on its own (check Inngest dashboard run history if not).

- [ ] **Step 6: update memory/docs**

Add the shipped feature to the pre-launch memory notes (abuse digest shipped; thresholds are in `lib/notifications/abuseDigest/evaluateFlags.ts` for post-launch tuning).

---

## Self-review notes (already applied)

- Watchlist creation timestamp is **`added_at`** (`watchlistItems.addedAt`), not `created_at` — Task 6 uses it correctly.
- `users`, `db`, `eq` are already imported in the Clerk webhook route; Task 4 adds no imports there.
- The email builder reads `APP_PUBLIC_URL` from env directly (matches `sendWeeklyDigest.ts`'s pattern) rather than threading it as a parameter; tests don't set it, so the default `https://keywordquarry.com` renders — the `/admin` assertion matches either way.
- `buildAbuseDigestEmail` includes `generated <ISO timestamp>` via `new Date()` — fine for a pure-ish builder (no test asserts on it).
- Counter `day` columns are drizzle `date` mode-default (strings in JS) — `eq(userActivityDaily.day, day)` compares string-to-date correctly.

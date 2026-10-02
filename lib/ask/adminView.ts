import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { monthStartUtc } from './ledger';

/**
 * Read-only queries for the admin page (spec §11.5). Emails are shown to the admin here by design
 * (spec §11.5 lists "email" as a table column) — never write one to a console.* line from this file.
 */

/**
 * One row per account, for the admin member table. `turnsMonth` counts this month's 'usage' ledger
 * rows — one per settled model call, which is a question or an approval resume (arc 4) — so it is
 * turns, not questions; the month's question count is ask_global_usage.questions, which a resume
 * does not bump (settleTurn's countQuestion).
 */
export type AdminAccountRow = {
  userId: string; email: string; role: 'admin' | 'standard_user'; access: boolean; monthlyAllowanceMicro: number; allowanceUsedMicro: number;
  periodStart: string; creditMicro: number; turnsMonth: number; spendMonthMicro: number; lastAt: Date | null;
};

// A `type` alias, not an `interface`: db.execute<TRow>'s TRow extends Record<string, unknown>, and
// only an object type literal (via `type`) gets TypeScript's implicit index signature to satisfy
// that constraint — a structurally identical `interface` does not (mirrors lib/ask/ledger.ts's
// AccountRow). bigint columns (monthly_allowance_micro etc.) arrive as strings over neon-http;
// period_start is a `date` column, read via `::text` below rather than relying on the driver's own
// date parsing.
type AdminAccountQueryRow = {
  user_id: string; email: string; role: 'admin' | 'standard_user'; access: boolean; monthly_allowance_micro: string; allowance_used_micro: string;
  period_start: string; credit_micro: string; turns_month: string; spend_month_micro: string; last_at: string | Date | null;
};

type UserIdRow = { id: string };
type ModelMixQueryRow = { model: string; n: string; cost_micro: string };
type CreditTotalRow = { total: string };

const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * UTC midnight of the given month, as a full timestamp string — bound to the `created_at >=`
 * filters below as `::timestamptz`, not `${month}::date`, whose interpretation against a
 * `timestamptz` column depends on the session time zone (Task 10 review, C-m6). `period_start`
 * itself is a `date` column, so comparisons against it below still use `::date`.
 */
function monthStartIso(now: Date): string {
  return `${monthStartUtc(now)}T00:00:00.000Z`;
}

/**
 * Spec §11.5, amended (Task 10 review, S3): every account with this month's turn count, spend
 * and last activity, newest activity first. "Used this period" reads 0 once `period_start` is
 * stale — the same rule `sumRemainingAllowances` (lib/ask/ledger.ts) applies for the lazy period
 * reset (§9.3) — rather than showing last month's figure until the member's next question
 * re-triggers the reset.
 */
export async function listAccountsForAdmin(now: Date): Promise<AdminAccountRow[]> {
  const month = monthStartUtc(now);
  const sinceIso = monthStartIso(now);
  const r = await db.execute<AdminAccountQueryRow>(sql`
    SELECT u.id AS user_id, u.email, u.role, a.access, a.monthly_allowance_micro,
           CASE WHEN a.period_start < ${month}::date THEN 0 ELSE a.allowance_used_micro END AS allowance_used_micro,
           -- Consistent with the zeroed "used" above: a stale period reads as already reset here too
           -- (Task 10 nits, N6), rather than showing last month's date alongside this month's $0.
           GREATEST(a.period_start, ${month}::date)::text AS period_start, a.credit_micro,
           COALESCE(q.n, 0)::text AS turns_month, COALESCE(q.spend_micro, 0)::text AS spend_month_micro, q.last_at
    FROM ask_accounts a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN (
      -- 'usage' ledger rows store amount_micro as a NEGATIVE delta (the cost just charged — see
      -- settleTurn in lib/ask/ledger.ts) — negated here so spend_micro reads as a positive spend.
      SELECT user_id, count(*) AS n, max(created_at) AS last_at, -COALESCE(SUM(amount_micro), 0) AS spend_micro
      FROM ask_ledger WHERE kind = 'usage' AND created_at >= ${sinceIso}::timestamptz GROUP BY user_id
    ) q ON q.user_id = a.user_id
    ORDER BY q.last_at DESC NULLS LAST, u.email`);
  return r.rows.map((x) => ({
    userId: x.user_id, email: x.email, role: x.role, access: x.access, monthlyAllowanceMicro: num(x.monthly_allowance_micro), allowanceUsedMicro: num(x.allowance_used_micro),
    periodStart: String(x.period_start).slice(0, 10), creditMicro: num(x.credit_micro), turnsMonth: num(x.turns_month), spendMonthMicro: num(x.spend_month_micro),
    lastAt: x.last_at === null ? null : new Date(x.last_at),
  }));
}

/**
 * Case-insensitive lookup for the admin route's grant-by-email path. `lower(email)` seq-scans
 * `users` (no functional index) — acceptable at this table's size (Task 10 review, C-m6).
 */
export async function findUserIdByEmail(email: string): Promise<string | null> {
  const r = await db.execute<UserIdRow>(sql`SELECT id FROM users WHERE lower(email) = ${email.trim().toLowerCase()} LIMIT 1`);
  return r.rows[0]?.id ?? null;
}

/** `turns`: this month's 'usage' ledger rows for the model — questions plus approval resumes (see AdminAccountRow). */
export type ModelMixRow = { model: string; turns: number; costMicro: number };

/** Spec §11.5: turns and spend by model for the month, for the admin page's model-mix line (Task 10 review, S2). */
export async function modelMixForMonth(now: Date): Promise<ModelMixRow[]> {
  const sinceIso = monthStartIso(now);
  const r = await db.execute<ModelMixQueryRow>(sql`
    SELECT model, count(*) AS n, (-COALESCE(SUM(amount_micro), 0))::text AS cost_micro
    FROM ask_ledger WHERE kind = 'usage' AND created_at >= ${sinceIso}::timestamptz AND model IS NOT NULL
    GROUP BY model ORDER BY n DESC, model`);
  return r.rows.map((x) => ({ model: x.model, turns: num(x.n), costMicro: num(x.cost_micro) }));
}

/**
 * Spec §11.5 amendment (Task 10 review, C-m7): spendable credit on accounts with access, counted
 * alongside remaining allowances in the admin page's "ceiling too low" check — credit is real
 * spendable balance too (see lib/ask/ledger.ts's balanceMicro), not just the committed allowance.
 */
export async function sumCreditWithAccess(): Promise<number> {
  const r = await db.execute<CreditTotalRow>(sql`SELECT COALESCE(SUM(credit_micro), 0)::text AS total FROM ask_accounts WHERE access = true`);
  return num(r.rows[0]?.total);
}

import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { monthStartUtc } from './ledger';

/**
 * Read-only queries for the admin page (spec §11.5). Emails are shown to the admin here by design
 * (spec §11.5 lists "email" as a table column) — never write one to a console.* line from this file.
 */

/** One row per account, for the admin member table. */
export type AdminAccountRow = {
  userId: string; email: string; role: 'admin' | 'standard_user'; access: boolean; monthlyAllowanceMicro: number; allowanceUsedMicro: number;
  periodStart: string; creditMicro: number; questionsMonth: number; lastAt: Date | null;
};

// A `type` alias, not an `interface`: db.execute<TRow>'s TRow extends Record<string, unknown>, and
// only an object type literal (via `type`) gets TypeScript's implicit index signature to satisfy
// that constraint — a structurally identical `interface` does not (mirrors lib/ask/ledger.ts's
// AccountRow). bigint columns (monthly_allowance_micro etc.) arrive as strings over neon-http;
// period_start is a `date` column, read via `::text` below rather than relying on the driver's own
// date parsing.
type AdminAccountQueryRow = {
  user_id: string; email: string; role: 'admin' | 'standard_user'; access: boolean; monthly_allowance_micro: string; allowance_used_micro: string;
  period_start: string; credit_micro: string; questions_month: string; last_at: string | Date | null;
};

type UserIdRow = { id: string };

const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

/** Spec §11.5: every account with this month's question count and last activity, newest activity first. */
export async function listAccountsForAdmin(now: Date): Promise<AdminAccountRow[]> {
  const month = monthStartUtc(now);
  const r = await db.execute<AdminAccountQueryRow>(sql`
    SELECT u.id AS user_id, u.email, u.role, a.access, a.monthly_allowance_micro, a.allowance_used_micro, a.period_start::text AS period_start, a.credit_micro,
           COALESCE(q.n, 0)::text AS questions_month, q.last_at
    FROM ask_accounts a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN (
      SELECT user_id, count(*) AS n, max(created_at) AS last_at FROM ask_ledger WHERE kind = 'usage' AND created_at >= ${month}::date GROUP BY user_id
    ) q ON q.user_id = a.user_id
    ORDER BY q.last_at DESC NULLS LAST, u.email`);
  return r.rows.map((x) => ({
    userId: x.user_id, email: x.email, role: x.role, access: x.access, monthlyAllowanceMicro: num(x.monthly_allowance_micro), allowanceUsedMicro: num(x.allowance_used_micro),
    periodStart: String(x.period_start).slice(0, 10), creditMicro: num(x.credit_micro), questionsMonth: num(x.questions_month), lastAt: x.last_at === null ? null : new Date(x.last_at),
  }));
}

/** Case-insensitive lookup for the admin route's grant-by-email path. */
export async function findUserIdByEmail(email: string): Promise<string | null> {
  const r = await db.execute<UserIdRow>(sql`SELECT id FROM users WHERE lower(email) = ${email.trim().toLowerCase()} LIMIT 1`);
  return r.rows[0]?.id ?? null;
}

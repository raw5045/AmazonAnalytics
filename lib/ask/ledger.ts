import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import type { AskModelId } from './config';
import type { TurnUsage } from './pricing';

/**
 * The per-member money ledger (spec §9). Every write that must be atomic is ONE statement with
 * data-modifying CTEs: neon-http has no transactions. Amounts are integer micro-dollars; bigint
 * columns come back from the driver as strings and are converted here, once.
 */
export interface AskAccount {
  userId: string;
  access: boolean;
  monthlyAllowanceMicro: number;
  allowanceUsedMicro: number;
  /** YYYY-MM-DD, the first day of the current allowance period (UTC month start until Stripe). */
  periodStart: string;
  creditMicro: number;
  conversationCount: number;
  /** Spec 2026-10-01 §3: "Always approve" remembered — changes (create/update/add/remove) and deletes separately. */
  autoApproveChanges: boolean;
  autoApproveDeletes: boolean;
}

// A `type` alias, not an `interface`: db.execute<TRow>'s TRow extends Record<string, unknown>, and
// only an object type literal (via `type`) gets TypeScript's implicit index signature to satisfy
// that constraint — a structurally identical `interface` does not (see the Task 5 deviation note).
type AccountRow = {
  user_id: string; access: boolean; monthly_allowance_micro: string | number; allowance_used_micro: string | number;
  period_start: string; credit_micro: string | number; conversation_count: number; auto_approve_changes: boolean; auto_approve_deletes: boolean;
};

const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

function toAccount(r: AccountRow): AskAccount {
  return {
    userId: r.user_id, access: r.access, monthlyAllowanceMicro: num(r.monthly_allowance_micro), allowanceUsedMicro: num(r.allowance_used_micro),
    periodStart: String(r.period_start).slice(0, 10), creditMicro: num(r.credit_micro), conversationCount: Number(r.conversation_count),
    autoApproveChanges: r.auto_approve_changes === true, autoApproveDeletes: r.auto_approve_deletes === true,
  };
}

const ACCOUNT_COLUMNS = sql.raw('user_id, access, monthly_allowance_micro, allowance_used_micro, period_start::text AS period_start, credit_micro, conversation_count, auto_approve_changes, auto_approve_deletes');

export function monthStartUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export function balanceMicro(a: Pick<AskAccount, 'monthlyAllowanceMicro' | 'allowanceUsedMicro' | 'creditMicro'>): number {
  return Math.max(0, a.monthlyAllowanceMicro - a.allowanceUsedMicro) + a.creditMicro;
}

export async function getAccount(userId: string): Promise<AskAccount | null> {
  const r = await db.execute<AccountRow>(sql`SELECT ${ACCOUNT_COLUMNS} FROM ask_accounts WHERE user_id = ${userId}::uuid`);
  return r.rows[0] ? toAccount(r.rows[0]) : null;
}

/** Creates the row if missing (metering row for admins: access false, allowance 0) and returns it. */
export async function ensureAccount(userId: string, now: Date, opts: { access: boolean; allowanceMicro: number }): Promise<AskAccount> {
  const r = await db.execute<AccountRow>(sql`
    INSERT INTO ask_accounts (user_id, access, monthly_allowance_micro, period_start)
    VALUES (${userId}::uuid, ${opts.access}, ${opts.allowanceMicro}, ${monthStartUtc(now)}::date)
    ON CONFLICT (user_id) DO UPDATE SET updated_at = ask_accounts.updated_at
    RETURNING ${ACCOUNT_COLUMNS}`);
  return toAccount(r.rows[0]);
}

/**
 * Spec §9.3: when period_start is before the current UTC month, zero the used allowance and move
 * the period, writing an allowance_reset entry — all in one statement. Returns the (possibly
 * unchanged) account, or null when there is no row.
 *
 * The final SELECT mirrors `due`'s WHERE/SET — CASE WHEN period_start < month THEN 0 ELSE
 * allowance_used_micro END, GREATEST(period_start, month) — instead of reading
 * allowance_used_micro/period_start back from ask_accounts. Two reasons this form is required, not
 * just tidier: (1) per Postgres docs 7.8.4, every statement in a WITH query — including the
 * primary query — runs against the SAME snapshot taken at the start of the overall statement, so a
 * plain `SELECT ... FROM ask_accounts` here would be blind to `due`'s own UPDATE and return last
 * month's stale values right after the reset (the bug this fixes: a caller gating on this result —
 * Task 8's gate — would wrongly refuse a member on their first question of a new month); (2) it is
 * also correct for a caller that loses a race against a concurrent resetPeriodIfDue for the same
 * user — its own snapshot may predate the winner's commit, but comparing the (possibly stale)
 * period_start against the same `month` literal still derives the right answer, unlike trusting
 * the raw column. Both reasons are why this mirrored form is preferred over re-reading the row
 * after the statement.
 *
 * The two write toggles (arc 4) are read straight from the row — `due` never changes them — but
 * they must stay in this hand-written list: the gates and the /ask page take their account from
 * here, and toAccount maps a missing toggle to false.
 */
export async function resetPeriodIfDue(userId: string, now: Date): Promise<AskAccount | null> {
  const month = monthStartUtc(now);
  const r = await db.execute<AccountRow>(sql`
    WITH due AS (
      UPDATE ask_accounts SET allowance_used_micro = 0, period_start = ${month}::date, updated_at = now()
      WHERE user_id = ${userId}::uuid AND period_start < ${month}::date
      RETURNING user_id, monthly_allowance_micro
    ), led AS (
      INSERT INTO ask_ledger (user_id, kind, amount_micro, note)
      SELECT user_id, 'allowance_reset', monthly_allowance_micro, ${'period ' + month} FROM due RETURNING id
    )
    SELECT user_id, access, monthly_allowance_micro,
           CASE WHEN period_start < ${month}::date THEN 0 ELSE allowance_used_micro END AS allowance_used_micro,
           GREATEST(period_start, ${month}::date)::text AS period_start,
           credit_micro, conversation_count, auto_approve_changes, auto_approve_deletes
    FROM ask_accounts WHERE user_id = ${userId}::uuid`);
  return r.rows[0] ? toAccount(r.rows[0]) : null;
}

/**
 * Spec 2026-10-01 §8: a partial update of the two write toggles. An omitted field is left as is
 * (bound as NULL); `false` turns a toggle off. Owner-scoped by primary key.
 */
export async function setAutoApprove(userId: string, patch: { changes?: boolean; deletes?: boolean }): Promise<AskAccount | null> {
  const r = await db.execute<AccountRow>(sql`
    UPDATE ask_accounts
    SET auto_approve_changes = COALESCE(${patch.changes ?? null}::boolean, auto_approve_changes),
        auto_approve_deletes = COALESCE(${patch.deletes ?? null}::boolean, auto_approve_deletes),
        updated_at = now()
    WHERE user_id = ${userId}::uuid
    RETURNING ${ACCOUNT_COLUMNS}`);
  return r.rows[0] ? toAccount(r.rows[0]) : null;
}

export interface SettleArgs {
  userId: string; conversationId: string; messageId: string | null; model: AskModelId; usage: TurnUsage; costMicro: number; now: Date;
}
export interface SettleResult {
  fromAllowanceMicro: number; fromCreditMicro: number; absorbedMicro: number; globalCostMicro: number; globalQuestions: number;
}

/**
 * Spec §9.4: allowance first, then credit, overshoot absorbed; ledger entry and the global monthly
 * counter in the same statement — all-or-nothing: `glob`'s INSERT is sourced `FROM upd` (not a
 * bare VALUES), so it only runs when `upd` actually produced a row. Without that, a data-modifying
 * CTE always runs to completion regardless of the other CTEs, so a missing account would still
 * bump the global counter even though the statement correctly returns no row and the caller
 * correctly sees "no ask_accounts row" — a real cost silently counted against no one.
 *
 * NOT idempotent — never retry a settle. An error thrown after this statement has committed (e.g.
 * the connection drops while the driver is still reading back the response) may already have
 * billed; retrying would charge the same turn's cost twice.
 *
 * `countQuestion: false` is for an approval resume (spec 2026-10-01 §6): a billed turn — the
 * `usage` row, the allowance/credit split and the month's cost exactly as for a question — that is
 * not a new question, so the month's `questions` counter is neither started nor bumped by it.
 */
export async function settleTurn(a: SettleArgs, opts: { countQuestion?: boolean } = {}): Promise<SettleResult> {
  if (!Number.isSafeInteger(a.costMicro) || a.costMicro < 0) throw new Error('settleTurn: costMicro must be a non-negative integer');
  const month = monthStartUtc(a.now);
  const questions = opts.countQuestion === false ? 0 : 1;
  const r = await db.execute<{ from_allowance: string; from_credit: string; global_cost_micro: string; global_questions: number }>(sql`
    WITH acct AS (
      SELECT user_id, GREATEST(0, monthly_allowance_micro - allowance_used_micro) AS remaining, credit_micro
      FROM ask_accounts WHERE user_id = ${a.userId}::uuid FOR UPDATE
    ), split AS (
      SELECT LEAST(${a.costMicro}::bigint, remaining) AS from_allowance,
             LEAST(${a.costMicro}::bigint - LEAST(${a.costMicro}::bigint, remaining), credit_micro) AS from_credit
      FROM acct
    ), upd AS (
      UPDATE ask_accounts x SET allowance_used_micro = x.allowance_used_micro + s.from_allowance,
                                credit_micro = x.credit_micro - s.from_credit, updated_at = now()
      FROM split s WHERE x.user_id = ${a.userId}::uuid
      RETURNING s.from_allowance, s.from_credit
    ), led AS (
      INSERT INTO ask_ledger (user_id, kind, amount_micro, conversation_id, message_id, model, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, from_allowance_micro, from_credit_micro, absorbed_micro)
      SELECT ${a.userId}::uuid, 'usage', -(${a.costMicro}::bigint), ${a.conversationId}::uuid, ${a.messageId}::uuid, ${a.model},
             ${a.usage.noCacheTokens}, ${a.usage.cacheWriteTokens}, ${a.usage.cacheReadTokens}, ${a.usage.outputTokens},
             from_allowance, from_credit, ${a.costMicro}::bigint - from_allowance - from_credit
      FROM upd RETURNING id
    ), glob AS (
      INSERT INTO ask_global_usage (month, cost_micro, questions)
      SELECT ${month}::date, ${a.costMicro}::bigint, ${questions}::int FROM upd
      ON CONFLICT (month) DO UPDATE SET cost_micro = ask_global_usage.cost_micro + EXCLUDED.cost_micro, questions = ask_global_usage.questions + ${questions}::int
      RETURNING cost_micro, questions
    )
    SELECT upd.from_allowance, upd.from_credit, glob.cost_micro AS global_cost_micro, glob.questions AS global_questions FROM upd, glob`);
  const row = r.rows[0];
  if (!row) throw new Error(`settleTurn: no ask_accounts row for user ${a.userId}`);
  const fromAllowance = num(row.from_allowance);
  const fromCredit = num(row.from_credit);
  return { fromAllowanceMicro: fromAllowance, fromCreditMicro: fromCredit, absorbedMicro: a.costMicro - fromAllowance - fromCredit, globalCostMicro: num(row.global_cost_micro), globalQuestions: Number(row.global_questions) };
}

interface AdminArgs { userId: string; adminId: string; now: Date }

/** Spec §9.7 grant: creates or re-enables the account at `allowanceMicro`, period = current UTC month. */
export async function grantAccess(a: AdminArgs & { allowanceMicro: number }): Promise<AskAccount> {
  if (!Number.isSafeInteger(a.allowanceMicro) || a.allowanceMicro < 0) throw new Error('grantAccess: allowance must be a non-negative integer');
  const month = monthStartUtc(a.now);
  const r = await db.execute<AccountRow>(sql`
    WITH up AS (
      INSERT INTO ask_accounts (user_id, access, monthly_allowance_micro, period_start)
      VALUES (${a.userId}::uuid, true, ${a.allowanceMicro}, ${month}::date)
      ON CONFLICT (user_id) DO UPDATE SET access = true, monthly_allowance_micro = EXCLUDED.monthly_allowance_micro, updated_at = now()
      RETURNING ${ACCOUNT_COLUMNS}
    ), led AS (
      INSERT INTO ask_ledger (user_id, kind, amount_micro, created_by, note)
      VALUES (${a.userId}::uuid, 'grant', ${a.allowanceMicro}, ${a.adminId}::uuid, 'access granted') RETURNING id
    )
    SELECT * FROM up`);
  return toAccount(r.rows[0]);
}

export async function setAllowance(a: AdminArgs & { allowanceMicro: number }): Promise<AskAccount | null> {
  if (!Number.isSafeInteger(a.allowanceMicro) || a.allowanceMicro < 0) throw new Error('setAllowance: allowance must be a non-negative integer');
  const r = await db.execute<AccountRow>(sql`
    WITH up AS (
      UPDATE ask_accounts SET monthly_allowance_micro = ${a.allowanceMicro}, updated_at = now() WHERE user_id = ${a.userId}::uuid
      RETURNING ${ACCOUNT_COLUMNS}
    ), led AS (
      INSERT INTO ask_ledger (user_id, kind, amount_micro, created_by, note)
      SELECT user_id, 'adjustment', ${a.allowanceMicro}, ${a.adminId}::uuid, 'allowance set' FROM up RETURNING id
    )
    SELECT * FROM up`);
  return r.rows[0] ? toAccount(r.rows[0]) : null;
}

export async function addCredit(a: AdminArgs & { amountMicro: number; note: string }): Promise<AskAccount | null> {
  if (!Number.isSafeInteger(a.amountMicro) || a.amountMicro <= 0) throw new Error('addCredit: amount must be a positive integer');
  const r = await db.execute<AccountRow>(sql`
    WITH up AS (
      UPDATE ask_accounts SET credit_micro = credit_micro + ${a.amountMicro}, updated_at = now() WHERE user_id = ${a.userId}::uuid
      RETURNING ${ACCOUNT_COLUMNS}
    ), led AS (
      INSERT INTO ask_ledger (user_id, kind, amount_micro, created_by, note)
      SELECT user_id, 'credit', ${a.amountMicro}, ${a.adminId}::uuid, ${a.note} FROM up RETURNING id
    )
    SELECT * FROM up`);
  return r.rows[0] ? toAccount(r.rows[0]) : null;
}

export async function revokeAccess(a: AdminArgs): Promise<AskAccount | null> {
  const r = await db.execute<AccountRow>(sql`
    WITH up AS (
      UPDATE ask_accounts SET access = false, updated_at = now() WHERE user_id = ${a.userId}::uuid
      RETURNING ${ACCOUNT_COLUMNS}
    ), led AS (
      INSERT INTO ask_ledger (user_id, kind, amount_micro, created_by, note)
      SELECT user_id, 'revoke', 0, ${a.adminId}::uuid, 'access revoked' FROM up RETURNING id
    )
    SELECT * FROM up`);
  return r.rows[0] ? toAccount(r.rows[0]) : null;
}

export interface GlobalUsage { month: string; costMicro: number; questions: number; alerted80At: Date | null; alerted100At: Date | null }

export async function globalUsageForMonth(month: string): Promise<GlobalUsage> {
  const r = await db.execute<{ month: string; cost_micro: string; questions: number; alerted_80_at: string | Date | null; alerted_100_at: string | Date | null }>(
    sql`SELECT month::text AS month, cost_micro, questions, alerted_80_at, alerted_100_at FROM ask_global_usage WHERE month = ${month}::date`,
  );
  const row = r.rows[0];
  if (!row) return { month, costMicro: 0, questions: 0, alerted80At: null, alerted100At: null };
  const d = (v: string | Date | null) => (v === null ? null : new Date(v));
  return { month: String(row.month).slice(0, 10), costMicro: num(row.cost_micro), questions: Number(row.questions), alerted80At: d(row.alerted_80_at), alerted100At: d(row.alerted_100_at) };
}

/** Marks the 80% or 100% alert as sent; true only for the first caller (the column was null). */
export async function markCeilingAlert(month: string, level: 80 | 100, now: Date): Promise<boolean> {
  const col = sql.raw(level === 80 ? 'alerted_80_at' : 'alerted_100_at');
  const r = await db.execute(sql`
    UPDATE ask_global_usage SET ${col} = ${now.toISOString()}::timestamptz
    WHERE month = ${month}::date AND ${col} IS NULL RETURNING month`);
  return r.rows.length > 0;
}

/**
 * Admin page: the sum of remaining allowances of accounts with access. Admin metering rows are
 * created with access = false (see ensureAccount), so `WHERE access = true` already excludes them
 * without any special-casing here — what this counts is any account explicitly granted access,
 * admin or not. Treats a stale period as fully remaining (the lazy reset has not run for them yet).
 */
export async function sumRemainingAllowances(now: Date): Promise<number> {
  const month = monthStartUtc(now);
  const r = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(CASE WHEN period_start < ${month}::date THEN monthly_allowance_micro ELSE GREATEST(0, monthly_allowance_micro - allowance_used_micro) END), 0)::text AS total
    FROM ask_accounts WHERE access = true`);
  return num(r.rows[0]?.total);
}

/**
 * Spec §11.2: zero → the page shows the "Admin preview" chip to admins. Excludes admin accounts
 * (`u.role <> 'admin'`) — an admin's own metering row exists to track their usage, but they never
 * count as a "real" member for this check.
 */
export async function countMemberAccountsWithAccess(): Promise<number> {
  const r = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM ask_accounts a JOIN users u ON u.id = a.user_id WHERE a.access = true AND u.role <> 'admin'`);
  return num(r.rows[0]?.n);
}

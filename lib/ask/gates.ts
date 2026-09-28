import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { dailyMessageLimit, globalMonthlyCeilingMicro } from './config';
import { askAiEligible } from './eligibility';
import { balanceMicro, ensureAccount, getAccount, globalUsageForMonth, monthStartUtc, resetPeriodIfDue, type AskAccount } from './ledger';

/** Spec §9.5 / §12. The refusal shape the chat route turns into JSON. */
export interface GateRefusal {
  status: 404 | 402 | 429 | 503;
  code: 'not_eligible' | 'daily_limit' | 'no_balance' | 'global_ceiling';
  message: string;
  retryAfterSeconds?: number;
}
export type GateOutcome = { ok: true; account: AskAccount } | { ok: false; refusal: GateRefusal };

export const NO_BALANCE_MESSAGE = "You've used this month's usage. Ask through the Feedback button to add more.";
export const GLOBAL_CEILING_MESSAGE = 'Ask AI is paused for the rest of the month.';

/**
 * `chat_day` is a RESERVED bucket channel: it lives in research_usage_buckets next to the
 * per-minute `mcp`/`chat` rows but deliberately sits outside `ResearchChannel` (contracts.ts) —
 * it is a per-member DAILY question guard (bucket_start = UTC day start), not a research call.
 * The hourly sweep deletes buckets older than a day, which never touches the current day's row.
 */
const DAILY_GUARD_CHANNEL = 'chat_day';

export function secondsToNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export function dailyLimitMessage(limit: number, seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const when = hours < 1 ? 'less than an hour' : hours === 1 ? '1 hour' : `${hours} hours`;
  return `You've reached today's limit of ${limit} questions. It resets in ${when}.`;
}

/** One atomic upsert on research_usage_buckets under channel `chat_day`, bucket = UTC day start; returns today's count including this call. */
export async function reserveDailyQuestion(userId: string, now: Date): Promise<{ requests: number }> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const r = await db.execute<{ requests: number }>(sql`
    INSERT INTO research_usage_buckets (user_id, channel, bucket_start, requests, "rows")
    VALUES (${userId}::uuid, ${sql.raw(`'${DAILY_GUARD_CHANNEL}'`)}, ${day.toISOString()}::timestamptz, 1, 0)
    ON CONFLICT (user_id, channel, bucket_start) DO UPDATE SET requests = research_usage_buckets.requests + 1
    RETURNING requests`);
  return { requests: Number(r.rows[0]?.requests ?? 0) };
}

/**
 * In order: eligibility (admin, or an accessible account) → period reset → daily guard → balance
 * (members only) → global ceiling (everyone). The kill switch and the API key are the route's
 * job, before auth. An ineligible caller gets a 404-shaped refusal so the feature's existence is
 * not confirmed to accounts that cannot use it.
 */
export async function runGates(input: { user: { id: string; role: 'admin' | 'standard_user' }; now: Date }): Promise<GateOutcome> {
  const { user, now } = input;
  let account = await getAccount(user.id);
  if (!askAiEligible(user.role, account)) return { ok: false, refusal: { status: 404, code: 'not_eligible', message: 'Not found' } };
  if (!account) account = await ensureAccount(user.id, now, { access: false, allowanceMicro: 0 });
  account = (await resetPeriodIfDue(user.id, now)) ?? account;

  const limit = dailyMessageLimit();
  const { requests } = await reserveDailyQuestion(user.id, now);
  if (requests > limit) {
    const retryAfterSeconds = secondsToNextUtcDay(now);
    return { ok: false, refusal: { status: 429, code: 'daily_limit', message: dailyLimitMessage(limit, retryAfterSeconds), retryAfterSeconds } };
  }
  if (user.role !== 'admin' && balanceMicro(account) <= 0) {
    return { ok: false, refusal: { status: 402, code: 'no_balance', message: NO_BALANCE_MESSAGE } };
  }
  const global = await globalUsageForMonth(monthStartUtc(now));
  if (global.costMicro >= globalMonthlyCeilingMicro()) {
    return { ok: false, refusal: { status: 503, code: 'global_ceiling', message: GLOBAL_CEILING_MESSAGE } };
  }
  return { ok: true, account };
}

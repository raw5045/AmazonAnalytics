import { env } from '@/lib/env';
import { sendAskAiCeilingEmail } from '@/lib/notifications/sendAskAiCeilingEmail';
import { errFields } from './logSafe';
import { globalMonthlyCeilingMicro } from './config';
import { markCeilingAlert, monthStartUtc } from './ledger';

/**
 * Spec §9.6: one email at 80% and one at 100% of the global ceiling per month. Called after every
 * settlement with the month's running total; the mark is set in the database first so concurrent
 * turns cannot both send.
 *
 * Deviates from the plan's fire-and-forget `void sendAskAiCeilingEmail(...)` (Task 10 implementer
 * delta A): this function AWAITS the send. The chat route's onEnd awaits `maybeAlertCeiling` as part
 * of the turn's `after()` lifetime (app/api/ask/chat/route.ts's file header; the turn's own
 * `finishTurn()` — which resolves that lifetime promise — runs in onEnd's `finally`, after this
 * call). A still-pending fire-and-forget send would be cut off when Vercel reclaims the function
 * once that lifetime promise resolves. This function must never itself call `after()`: on the cancel
 * path onEnd can run from the response's `close` event, outside a normal request scope, where
 * after() throws (plan, "Notes for later tasks" under Task 8) — the route's own after() call already
 * covers the whole turn's lifetime, so awaiting here is sufficient.
 *
 * Never throws: the route's caller already wraps its own call in try/catch and logs `alert_failed`,
 * but this stays fail-soft on its own too, so a Resend outage can never turn an already-billed turn
 * into an unhandled rejection.
 */
export async function maybeAlertCeiling(globalCostMicro: number, now: Date, questions = 0): Promise<void> {
  const ceiling = globalMonthlyCeilingMicro();
  const level: 80 | 100 | null = globalCostMicro >= ceiling ? 100 : globalCostMicro >= ceiling * 0.8 ? 80 : null;
  if (level === null) return;
  const month = monthStartUtc(now);
  const first = await markCeilingAlert(month, level, now);
  if (level === 100) await markCeilingAlert(month, 80, now).catch(() => false);
  if (!first) return;
  const to = env.INITIAL_ADMIN_EMAIL;
  if (!to) {
    console.warn(`[ask alerts] Ask AI at ${level}% of the monthly ceiling (${globalCostMicro} of ${ceiling} micro-dollars) — INITIAL_ADMIN_EMAIL unset, no email sent`);
    return;
  }
  try {
    await sendAskAiCeilingEmail({ to, level, month, costMicro: globalCostMicro, ceilingMicro: ceiling, questions });
  } catch (e) {
    console.error('[ask alerts]', JSON.stringify({ outcome: 'send_threw', level, month, ...errFields(e) }));
  }
}

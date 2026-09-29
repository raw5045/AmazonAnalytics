import { env } from '@/lib/env';
import { sendAskAiCeilingEmail } from '@/lib/notifications/sendAskAiCeilingEmail';
import { errFields } from './logSafe';
import { globalMonthlyCeilingMicro } from './config';
import { markCeilingAlert, monthStartUtc } from './ledger';

/**
 * Bounds the awaited email send (Task 10 review, S6): the chat route (app/api/ask/chat/route.ts,
 * C4) starts this call un-awaited in onEnd's `finally`, after the settle, save and lock release, and
 * chains the turn's `finishTurn()` to its completion — the route's own `after(() => turnFinished)`
 * keeps the function alive only until that settles. Since `resend` 6.12.3 has no built-in request
 * timeout, an unbounded await here could pin the function alive indefinitely on a stalled call; 10s
 * is generous for a single transactional email while still bounding the worst case.
 */
const ALERT_SEND_TIMEOUT_MS = 10_000;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RaceOutcome = { kind: 'settled'; result: { sent: boolean; reason?: string } } | { kind: 'error'; error: unknown } | { kind: 'timeout' };

/**
 * Spec §9.6 (amended, Task 10 review): one email at 80% and one at 100% of the global ceiling per
 * month, awaited by the caller (not fire-and-forget via `after()`) and bounded to 10s so a stalled
 * Resend call can only delay the turn's lifetime by that much. The mark is set in the database
 * first (its own single UPDATE statement — neon-http has no transactions, see lib/ask/ledger.ts's
 * header) so concurrent turns cannot both send; a caller that loses that race sees `first = false`
 * and returns without sending.
 *
 * Never throws (S6): every awaited step — both marks, and the send — is its own guarded path, logged
 * with an outcome code and `errFields`, never a raw error or an email address. Never calls `after()`
 * itself: on the cancel path `onEnd` can run outside a normal request scope, where `after()` throws
 * (plan, "Notes for later tasks" under Task 8) — the route's own `after()` call already covers this
 * function's lifetime.
 */
export async function maybeAlertCeiling(globalCostMicro: number, now: Date, questions: number): Promise<void> {
  const ceiling = globalMonthlyCeilingMicro();
  const level: 80 | 100 | null = globalCostMicro >= ceiling ? 100 : globalCostMicro >= ceiling * 0.8 ? 80 : null;
  if (level === null) return;
  const month = monthStartUtc(now);
  let first: boolean;
  try {
    first = await markCeilingAlert(month, level, now);
    // Best-effort only: at 100% this also marks 80% (if not already) so a later crossing this month
    // never sends a redundant "80%" email after "100%" already fired. A failure here just leaves
    // that column null for the rest of the month (a display-only quirk on the admin page, C-m3) —
    // never worth failing the primary mark or the send over.
    if (level === 100) await markCeilingAlert(month, 80, now).catch(() => false);
  } catch (e) {
    console.error('[ask alerts]', JSON.stringify({ outcome: 'alert_mark_failed', level, month, ...errFields(e) }));
    return;
  }
  if (!first) return;
  const to = env.INITIAL_ADMIN_EMAIL;
  if (!to) {
    console.warn(`[ask alerts] Ask AI at ${level}% of the monthly ceiling (${globalCostMicro} of ${ceiling} micro-dollars) — INITIAL_ADMIN_EMAIL unset, no email sent`);
    return;
  }
  const raced = await Promise.race<RaceOutcome>([
    sendAskAiCeilingEmail({ to, level, month, costMicro: globalCostMicro, ceilingMicro: ceiling, questions })
      .then((result): RaceOutcome => ({ kind: 'settled', result }))
      .catch((error: unknown): RaceOutcome => ({ kind: 'error', error })),
    sleep(ALERT_SEND_TIMEOUT_MS).then((): RaceOutcome => ({ kind: 'timeout' })),
  ]);
  if (raced.kind === 'timeout') {
    console.error('[ask alerts]', JSON.stringify({ outcome: 'alert_send_timeout', level, month }));
  } else if (raced.kind === 'error') {
    console.error('[ask alerts]', JSON.stringify({ outcome: 'send_threw', level, month, ...errFields(raced.error) }));
  }
  // raced.kind === 'settled': sendAskAiCeilingEmail is itself fail-soft (returns { sent: false,
  // reason } rather than throwing) and already logs its own failures — nothing more to do here.
}

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

type RaceOutcome = { kind: 'settled'; result: { sent: boolean; reason?: string } } | { kind: 'error'; error: unknown } | { kind: 'timeout' };

/**
 * Spec §9.6 (amended, Task 10 review): one email at 80% and one at 100% of the global ceiling per
 * month. The send is awaited INSIDE this function, bounded to 10s, so a stalled Resend call can
 * only delay this function's own return by that much (Task 10 nits, spec note 1 / N4: this used to
 * read as "awaited by the caller", which stopped being true once the chat route (C4) began starting
 * this call un-awaited). The CALLER does not await this function at all: the chat route starts it
 * un-awaited, after the answer is saved and the turn's lock is released, and the route's existing
 * `after(() => turnFinished)` keeps the function alive only until this call settles. The mark is set
 * in the database first (its own single UPDATE statement — neon-http has no transactions, see
 * lib/ask/ledger.ts's header) so concurrent turns cannot both send; a caller that loses that race
 * sees `first = false` and returns without sending.
 *
 * Never throws (S6): every awaited step — both marks, and the send — is its own guarded path, logged
 * with an outcome code and `errFields`'s `error`/`code` fields only (never `detail`, and never a raw
 * error or an email address — Task 10 nits, N3). Never calls `after()` itself: on the cancel path
 * `onEnd` can run outside a normal request scope, where `after()` throws (plan, "Notes for later
 * tasks" under Task 8) — the route's own `after()` call already covers this function's lifetime.
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
    // never sends a redundant "80%" email after "100%" already fired. A failure here is logged
    // (level: 80, same outcome code as the primary mark) but never fails the primary mark or the
    // send over it — it just leaves that column null for the rest of the month, a display-only
    // quirk on the admin page (Task 10 nits, N4: this used to fail silently despite this file's own
    // docblock claiming every step is logged).
    if (level === 100) {
      await markCeilingAlert(month, 80, now).catch((e: unknown) => {
        console.error('[ask alerts]', JSON.stringify({ outcome: 'alert_mark_failed', level: 80, month, ...errFields(e) }));
        return false;
      });
    }
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
  // The timer is scoped to this call (not module-level) and always cleared once the race settles —
  // whichever side wins — so a fast send never leaves a 10s timer pinning the process (Task 10
  // nits, spec note 7 / N2).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RaceOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), ALERT_SEND_TIMEOUT_MS);
  });
  try {
    const raced = await Promise.race<RaceOutcome>([
      sendAskAiCeilingEmail({ to, level, month, costMicro: globalCostMicro, ceilingMicro: ceiling, questions })
        .then((result): RaceOutcome => ({ kind: 'settled', result }))
        .catch((error: unknown): RaceOutcome => ({ kind: 'error', error })),
      timeout,
    ]);
    if (raced.kind === 'timeout') {
      console.error('[ask alerts]', JSON.stringify({ outcome: 'alert_send_timeout', level, month }));
    } else if (raced.kind === 'error') {
      // Mirrors sendAskAiCeilingEmail.ts's own catch: only the coded fields, never `detail` (a
      // generic thrown error's .message isn't Drizzle-scrubbed and could in principle echo request
      // data) — Task 10 nits, N3.
      const { error, code } = errFields(raced.error);
      console.error('[ask alerts]', JSON.stringify({ outcome: 'send_threw', level, month, error, code }));
    }
    // raced.kind === 'settled': sendAskAiCeilingEmail is itself fail-soft (returns { sent: false,
    // reason } rather than throwing) and already logs its own failures — nothing more to do here.
  } finally {
    clearTimeout(timer);
  }
}

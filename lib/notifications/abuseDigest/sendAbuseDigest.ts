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

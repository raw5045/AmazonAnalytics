// lib/notifications/digest/sendWeeklyDigest.ts
//
// IMPORTANT: do NOT add `import 'server-only'` here. This module runs on
// the Railway worker (plain Node via tsx — see worker/index.ts, which
// registers every Inngest function including sendWeeklyDigestFn). The
// 'server-only' package throws at import time outside a Next.js Server
// Component, which crash-loops the entire worker on boot (taking down ALL
// Inngest jobs, not just the digest). Same applies to ./loadDigestData.
import { Resend } from 'resend';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { weeklyDigestRuns, weeklyDigestSends } from '@/db/schema';
import { loadEligibleRecipients, loadWatchlistRowsByUser } from './loadDigestData';
import { buildDigestEmail } from './buildDigestEmail';
import { signUnsubToken } from './unsubToken';
import { variantFor, chunk, rollupRunStatus } from './recipients';
import type { DigestRecipient, DigestKeywordRow } from './types';

const CHUNK_SIZE = 100;        // Resend batch maximum
const STALE_SENDING_MS = 15 * 60 * 1000;

export interface SendDigestResult {
  skipped?: 'already_sent' | 'not_recoverable';
  weekEndDate: string;
  recipients: number;
  sent: number;
  failed: number;
  status: string;
}

/**
 * Send (or retry) the weekly digest for `weekEndDate`. Idempotent at the
 * (week, user) grain. See spec §8.
 */
export async function sendWeeklyDigest(opts: {
  weekEndDate: string;
  triggeredBy?: string | null;
  retry?: boolean;
}): Promise<SendDigestResult> {
  const { weekEndDate, triggeredBy = null, retry = false } = opts;

  // 1. Idempotency gate.
  if (!retry) {
    const inserted = await db
      .insert(weeklyDigestRuns)
      .values({ weekEndDate, status: 'sending', triggeredBy })
      .onConflictDoNothing()
      .returning({ weekEndDate: weeklyDigestRuns.weekEndDate });
    if (inserted.length === 0) {
      return { skipped: 'already_sent', weekEndDate, recipients: 0, sent: 0, failed: 0, status: 'already_sent' };
    }
  } else {
    // Retry mode: only proceed if the existing row is recoverable
    // (sent_with_failures, or a stale 'sending' run that crashed past
    // Inngest's own retries). Flip it back to 'sending'.
    const staleCutoff = new Date(Date.now() - STALE_SENDING_MS);
    const updated = await db
      .update(weeklyDigestRuns)
      .set({ status: 'sending', finishedAt: null })
      .where(
        and(
          eq(weeklyDigestRuns.weekEndDate, weekEndDate),
          sql`(${weeklyDigestRuns.status} IN ('sent_with_failures', 'failed')
               OR (${weeklyDigestRuns.status} = 'sending' AND ${weeklyDigestRuns.startedAt} < ${staleCutoff}))`,
        ),
      )
      .returning({ weekEndDate: weeklyDigestRuns.weekEndDate });
    if (updated.length === 0) {
      return { skipped: 'not_recoverable', weekEndDate, recipients: 0, sent: 0, failed: 0, status: 'not_recoverable' };
    }
  }

  // 2. Load recipients. On retry/resume, restrict to not-yet-sent users
  //    (failed OR never-attempted 'pending'), so a resumed crash picks
  //    up everyone who still needs the email without re-blasting 'sent'.
  const recipients = await loadEligibleRecipients(
    retry ? { onlyUnsentForWeek: weekEndDate } : undefined,
  );

  // 3. Seed pending send rows (idempotent — skips users already sent).
  if (recipients.length > 0) {
    await db
      .insert(weeklyDigestSends)
      .values(
        recipients.map((r) => ({
          weekEndDate,
          userId: r.userId,
          variant: variantFor(r.watchlistCount),
          status: 'pending' as const,
        })),
      )
      .onConflictDoNothing();
  }

  // 4. Load watchlist rows for watchlist-variant users.
  const watchlistUserIds = recipients.filter((r) => r.watchlistCount > 0).map((r) => r.userId);
  const rowsByUser = await loadWatchlistRowsByUser(watchlistUserIds);

  // 5. Fan out in chunks.
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'onboarding@resend.dev';
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://amazon-analytics-beta.vercel.app';

  let sent = 0;
  let failed = 0;

  if (!apiKey) {
    // Fail-soft: local dev without Resend. Leave rows 'pending', finish.
    console.warn(`[sendWeeklyDigest] RESEND_API_KEY not set — skipping send for ${weekEndDate}.`);
  } else {
    const resend = new Resend(apiKey);
    for (const group of chunk(recipients, CHUNK_SIZE)) {
      const payloads = group.map((r) => buildEmailPayload(r, weekEndDate, appUrl, from, rowsByUser));
      try {
        const { data, error } = await resend.batch.send(payloads);
        if (error) {
          await markChunk(group, weekEndDate, 'failed', null, error.message ?? 'batch error');
          failed += group.length;
        } else {
          const ids = data?.data ?? [];
          for (let idx = 0; idx < group.length; idx++) {
            await markOne(group[idx], weekEndDate, 'sent', ids[idx]?.id ?? null, null);
          }
          sent += group.length;
        }
      } catch (e) {
        await markChunk(group, weekEndDate, 'failed', null, e instanceof Error ? e.message : 'send threw');
        failed += group.length;
      }
    }
  }

  // 6. Roll up the run row.
  const status = apiKey ? rollupRunStatus({ sent, failed }) : 'sent';
  await db
    .update(weeklyDigestRuns)
    .set({
      status,
      finishedAt: new Date(),
      recipientsCount: recipients.length,
      sentCount: sent,
      failedCount: failed,
    })
    .where(eq(weeklyDigestRuns.weekEndDate, weekEndDate));

  return { weekEndDate, recipients: recipients.length, sent, failed, status };
}

/** Build one Resend batch entry (email object) for a recipient. */
function buildEmailPayload(
  r: DigestRecipient,
  weekEndDate: string,
  appUrl: string,
  from: string,
  rowsByUser: Map<string, DigestKeywordRow[]>,
) {
  const unsubscribeUrl = `${appUrl}/api/notifications/unsubscribe?token=${signUnsubToken(r.userId)}`;
  const built =
    r.watchlistCount > 0
      ? buildDigestEmail({
          variant: 'watchlist',
          weekEndDate,
          appUrl,
          unsubscribeUrl,
          rows: rowsByUser.get(r.userId) ?? [],
        })
      : buildDigestEmail({ variant: 'broadcast', weekEndDate, appUrl, unsubscribeUrl });

  return {
    from,
    to: [r.email],
    subject: built.subject,
    html: built.html,
    text: built.text,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

async function markOne(
  r: DigestRecipient,
  weekEndDate: string,
  status: 'sent' | 'failed',
  resendId: string | null,
  error: string | null,
) {
  await db
    .update(weeklyDigestSends)
    .set({ status, resendId, error: error?.slice(0, 1000) ?? null, sentAt: status === 'sent' ? new Date() : null })
    .where(and(eq(weeklyDigestSends.weekEndDate, weekEndDate), eq(weeklyDigestSends.userId, r.userId)));
}

async function markChunk(
  group: DigestRecipient[],
  weekEndDate: string,
  status: 'sent' | 'failed',
  resendId: string | null,
  error: string | null,
) {
  for (const r of group) {
    await markOne(r, weekEndDate, status, resendId, error);
  }
}

/**
 * Admin endpoint: trigger a FULL Keepa enrichment for the current
 * kcs week. Fires `keepa.enrich-week-requested` with `mode: 'full'`.
 *
 * Full mode re-fetches every in-scope ASIN whose data was last fetched
 * more than 14 days ago and upserts over the week's existing rows — the
 * monthly freshener for prices / reviews / categories. The 14-day guard
 * skips what the recent weekly pull-ins fetched (keeps the run under
 * ~24h), makes a crashed run resumable, and makes an immediate re-fire
 * a loud no-op. ~106k ASINs ≈ 23 hours at current pacing; don't start
 * one within ~24h of the next weekly upload.
 *
 * Body: optional `{ weekEndDate?: string }`. Defaults to the current
 * kcs week if omitted.
 * Response: `{ ok: true, eventId, weekEndDate }`
 */
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { inngest } from '@/inngest/client';
import { db } from '@/db/client';
import { keywordCurrentSummaryMeta } from '@/db/schema';

export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json(
        { error: e.message },
        { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 },
      );
    }
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as { weekEndDate?: string };
  let weekEndDate = body.weekEndDate;

  if (!weekEndDate) {
    const [meta] = await db.select().from(keywordCurrentSummaryMeta).limit(1);
    if (!meta) {
      return NextResponse.json(
        { error: 'No current kcs week available — keyword_current_summary_meta is empty' },
        { status: 500 },
      );
    }
    weekEndDate = meta.currentWeekEndDate;
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEndDate)) {
    return NextResponse.json({ error: 'weekEndDate must be YYYY-MM-DD' }, { status: 400 });
  }

  const result = await inngest.send({
    name: 'keepa.enrich-week-requested',
    data: { weekEndDate, mode: 'full' },
  });

  return NextResponse.json({
    ok: true,
    eventId: result.ids?.[0] ?? null,
    weekEndDate,
    mode: 'full',
  });
}

export const runtime = 'nodejs';

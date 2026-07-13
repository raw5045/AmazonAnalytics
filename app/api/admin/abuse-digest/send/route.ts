// app/api/admin/abuse-digest/send/route.ts
/**
 * Admin endpoint: force-send the abuse digest for a given ET day (defaults
 * to yesterday). Runs the orchestrator inline (one email — fast), with
 * force=true so re-sends and today-so-far sends bypass the idempotency key.
 *
 * Body: { day?: 'YYYY-MM-DD' }
 * Response: SendAbuseDigestResult | { error } (4xx/5xx)
 */
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { sendAbuseDigest } from '@/lib/notifications/abuseDigest/sendAbuseDigest';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as { day?: unknown };
  let day: string | undefined;
  if (body.day !== undefined) {
    if (typeof body.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.day)) {
      return NextResponse.json({ error: 'day must be YYYY-MM-DD' }, { status: 400 });
    }
    day = body.day;
  }

  try {
    const result = await sendAbuseDigest({ day, force: true });
    return NextResponse.json(result);
  } catch (e) {
    console.error('[abuse-digest] force send failed:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'send failed' },
      { status: 500 },
    );
  }
}

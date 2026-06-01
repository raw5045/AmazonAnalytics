// app/api/admin/digests/send/route.ts
/**
 * Admin endpoint: fire the weekly digest for the CURRENT snapshot week.
 * Validates that the requested week equals the current kcs week (the
 * only sendable one), then fires the `digest.send-weekly` Inngest event.
 *
 * Body: { weekEndDate: string; retry?: boolean }
 * Response: { ok: true, eventId, weekEndDate } | { error } (4xx)
 */
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { inngest } from '@/inngest/client';
import { getCurrentDigestWeek } from '@/lib/notifications/digest/loadDigestData';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let user;
  try {
    await requireAdmin();
    user = await getCurrentUser();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as { weekEndDate?: unknown; retry?: unknown };
  if (typeof body.weekEndDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.weekEndDate)) {
    return NextResponse.json({ error: 'weekEndDate must be YYYY-MM-DD' }, { status: 400 });
  }

  // Enforce "current week only".
  const currentWeek = await getCurrentDigestWeek();
  if (!currentWeek) {
    return NextResponse.json({ error: 'no current week available' }, { status: 409 });
  }
  if (body.weekEndDate !== currentWeek) {
    return NextResponse.json(
      { error: `only the current week (${currentWeek}) can be sent` },
      { status: 409 },
    );
  }

  const result = await inngest.send({
    name: 'digest.send-weekly',
    data: {
      weekEndDate: body.weekEndDate,
      triggeredBy: user?.id ?? null,
      retry: body.retry === true,
    },
  });

  return NextResponse.json({
    ok: true,
    eventId: result.ids?.[0] ?? null,
    weekEndDate: body.weekEndDate,
  });
}

/**
 * POST /api/feedback — signed-in feedback modal → email to the support inbox.
 *
 * Auth required; no honeypot (the modal only renders inside the
 * authenticated app shell). No rate limiting beyond the app-wide deferral —
 * volume is visible through the feedback_submission activity counter.
 * See docs/superpowers/specs/2026-09-15-feedback-button-design.md.
 */
import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { validateFeedback } from '@/lib/feedback/validate';
import { sendFeedbackEmail } from '@/lib/notifications/sendFeedbackEmail';
import { bumpAppActivity } from '@/lib/activity/bump';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as unknown;
  const v = validateFeedback(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const result = await sendFeedbackEmail({
    message: v.input.message,
    page: v.input.page,
    user: { id: user.id, email: user.email, name: user.name },
    appUrl: process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com',
  });
  if (!result.sent) {
    return NextResponse.json(
      { error: "Couldn't send your feedback right now — please try again later." },
      { status: 503 },
    );
  }
  void bumpAppActivity('feedback_submission'); // abuse-digest counter (fire-and-forget)
  return NextResponse.json({ ok: true });
}

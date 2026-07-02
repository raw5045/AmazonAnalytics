/**
 * POST /api/contact — public contact form → email to all admins.
 * Spam guard: honeypot field `company` (hidden in the UI; bots fill it) →
 * pretend success without sending. Real rate-limiting is deferred with the
 * rest of the app's limiter work (see pre-launch roadmap).
 */
import { NextResponse } from 'next/server';
import { validateContact } from '@/lib/contact/validate';
import { sendContactEmail } from '@/lib/notifications/sendContactEmail';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (typeof body.company === 'string' && body.company.trim().length > 0) {
    return NextResponse.json({ ok: true }); // honeypot tripped — swallow silently
  }

  const v = validateContact(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const result = await sendContactEmail(v.input);
  if (!result.sent) {
    return NextResponse.json(
      { error: "Couldn't send your message right now — please try again later." },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
}

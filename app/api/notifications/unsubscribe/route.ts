// app/api/notifications/unsubscribe/route.ts
/**
 * One-click unsubscribe (GET) + re-subscribe (POST) for the weekly digest.
 *
 * GET ?token=…  → verify HMAC → set weekly_digest_subscribed=false →
 *                 return a confirmation HTML page with a re-subscribe form.
 * POST (token in body) → verify → set weekly_digest_subscribed=true →
 *                 return the same page reading "re-subscribed".
 *
 * Public (no auth) — recipients click straight from an email. The signed
 * token is the authorization. See spec §11.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { verifyUnsubToken } from '@/lib/notifications/digest/unsubToken';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  const verified = verifyUnsubToken(token);
  if (!verified) return htmlResponse(invalidPage(), 400);

  try {
    await db.update(users).set({ weeklyDigestSubscribed: false }).where(eq(users.id, verified.userId));
  } catch (e) {
    console.error('[unsubscribe] db update failed:', e);
    return htmlResponse(errorPage(), 500);
  }
  return htmlResponse(unsubscribedPage(token), 200);
}

export async function POST(req: Request) {
  // Token may arrive as form-encoded (from the re-subscribe form) or JSON.
  let token = '';
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as { token?: string };
    token = body.token ?? '';
  } else {
    const form = await req.formData().catch(() => null);
    token = (form?.get('token') as string) ?? '';
  }

  const verified = verifyUnsubToken(token);
  if (!verified) return htmlResponse(invalidPage(), 400);

  try {
    await db.update(users).set({ weeklyDigestSubscribed: true }).where(eq(users.id, verified.userId));
  } catch (e) {
    console.error('[resubscribe] db update failed:', e);
    return htmlResponse(errorPage(), 500);
  }
  return htmlResponse(resubscribedPage(), 200);
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function page(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:48px auto;padding:24px;color:#111;">
${inner}
</body></html>`;
}

function unsubscribedPage(token: string): string {
  return page(`
    <h1 style="font-size:20px;">You've been unsubscribed</h1>
    <p style="color:#444;">You'll no longer receive the weekly digest email.</p>
    <p style="color:#444;">Changed your mind?</p>
    <form method="post" action="/api/notifications/unsubscribe">
      <input type="hidden" name="token" value="${escapeAttr(token)}">
      <button type="submit" style="background:#2563eb;color:#fff;border:none;padding:10px 16px;border-radius:6px;font-size:14px;cursor:pointer;">Re-subscribe</button>
    </form>
  `);
}

function resubscribedPage(): string {
  return page(`
    <h1 style="font-size:20px;">You're re-subscribed</h1>
    <p style="color:#444;">You'll receive the weekly digest email again.</p>
  `);
}

function invalidPage(): string {
  return page(`
    <h1 style="font-size:20px;">Invalid link</h1>
    <p style="color:#444;">This unsubscribe link is invalid or malformed. If you keep getting emails you don't want, reply to one and we'll sort it out.</p>
  `);
}

function errorPage(): string {
  return page(`
    <h1 style="font-size:20px;">Something went wrong</h1>
    <p style="color:#444;">We couldn't update your preferences just now. Please try again in a minute.</p>
  `);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

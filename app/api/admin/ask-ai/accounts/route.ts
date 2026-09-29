/** POST /api/admin/ask-ai/accounts — grant / set_allowance / add_credit / revoke (spec §9.7, §11.5). Admin-only, same-origin. */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { defaultAllowanceMicro, usdToMicro } from '@/lib/ask/config';
import { isSameOrigin } from '@/lib/ask/sameOrigin';
import { CROSS_SITE_MESSAGE } from '@/lib/ask/messages';
import { addCredit, grantAccess, revokeAccess, setAllowance } from '@/lib/ask/ledger';
import { findUserIdByEmail } from '@/lib/ask/adminView';
import { errFields } from '@/lib/ask/logSafe';

export const runtime = 'nodejs';

// zod 4.3.6: .finite() on z.number() is a deprecated no-op (z.number() already rejects NaN/
// Infinity) — dropped (Task 10 review, C-m4).
const usd = z.number().min(0).max(10_000);
const bodySchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('grant'), userId: z.uuid().optional(), email: z.string().trim().min(3).max(320).optional(), amountUsd: usd.optional() }),
  z.strictObject({ action: z.literal('set_allowance'), userId: z.uuid(), amountUsd: usd }),
  // note has no .min(1): an empty note gets the specific "A note is required." message below
  // instead of the schema's generic "Invalid request." (Task 10 nits, spec note 6).
  z.strictObject({ action: z.literal('add_credit'), userId: z.uuid(), amountUsd: usd.gt(0), note: z.string().trim().max(200) }),
  z.strictObject({ action: z.literal('revoke'), userId: z.uuid() }),
]);
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json({ error: CROSS_SITE_MESSAGE }, 403);
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.code === 'UNAUTHENTICATED' ? 401 : 403);
    throw e;
  }
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: 'Invalid request.' }, 400);
  const b = body.data;
  const now = new Date();
  try {
    if (b.action === 'grant') {
      if (!b.userId && !b.email) return json({ error: 'Provide an email or a member id.' }, 400);
      // userId wins when both are given (Task 10 review, C-m4): re-granting a known account by its
      // id must not be second-guessed by a stale or mistyped email also present on the request.
      const userId = b.userId ?? (b.email ? await findUserIdByEmail(b.email) : null);
      if (!userId) return json({ error: 'No member with that email.' }, 404);
      const account = await grantAccess({ userId, allowanceMicro: b.amountUsd === undefined ? defaultAllowanceMicro() : usdToMicro(b.amountUsd), adminId: admin.id, now });
      return json({ account }, 200);
    }
    if (b.action === 'add_credit') {
      // A sub-micro dollar amount (e.g. $0.0000001) rounds to 0 micro-dollars under usdToMicro and
      // would otherwise reach addCredit's own throwing guard (Task 10 review, S5b) — caught here
      // first, before the write, with a message that explains why.
      const amountMicro = usdToMicro(b.amountUsd);
      if (amountMicro <= 0) return json({ error: 'Amount too small.' }, 400);
      // Client-checked too (AccountActions.tsx never opens its Confirm step without one), but
      // enforced here since the client is never trusted alone (Task 10 nits, spec note 6): a blank
      // note used to fail the schema's own .min(1) with the generic "Invalid request." after the
      // admin had already confirmed.
      if (!b.note) return json({ error: 'A note is required.' }, 400);
      const account = await addCredit({ userId: b.userId, amountMicro, adminId: admin.id, note: b.note, now });
      if (!account) return json({ error: 'No Ask AI account for that member. Grant access first.' }, 404);
      return json({ account }, 200);
    }
    const account =
      b.action === 'set_allowance' ? await setAllowance({ userId: b.userId, allowanceMicro: usdToMicro(b.amountUsd), adminId: admin.id, now })
      : await revokeAccess({ userId: b.userId, adminId: admin.id, now });
    if (!account) return json({ error: 'No Ask AI account for that member. Grant access first.' }, 404);
    return json({ account }, 200);
  } catch (e) {
    // Never let a DrizzleQueryError's own .message — which embeds the bound SQL params (the typed
    // email, the credit note) — reach a log line (Task 10 review, S5a); errFields reads its .cause
    // instead for exactly this reason.
    console.error('[ask admin]', JSON.stringify({ outcome: 'db_failed', action: b.action, adminId: admin.id, ...errFields(e) }));
    return json({ error: 'Something went wrong. Try again in a minute.' }, 503);
  }
}

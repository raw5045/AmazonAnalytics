/** POST /api/admin/ask-ai/accounts — grant / set_allowance / add_credit / revoke (spec §9.7, §11.5). Admin-only, same-origin. */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { defaultAllowanceMicro, usdToMicro } from '@/lib/ask/config';
import { isSameOrigin } from '@/lib/ask/sameOrigin';
import { CROSS_SITE_MESSAGE } from '@/lib/ask/messages';
import { addCredit, grantAccess, revokeAccess, setAllowance } from '@/lib/ask/ledger';
import { findUserIdByEmail } from '@/lib/ask/adminView';

export const runtime = 'nodejs';

const usd = z.number().finite().min(0).max(10_000);
const bodySchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('grant'), userId: z.uuid().optional(), email: z.string().trim().min(3).max(320).optional(), amountUsd: usd.optional() }),
  z.strictObject({ action: z.literal('set_allowance'), userId: z.uuid(), amountUsd: usd }),
  z.strictObject({ action: z.literal('add_credit'), userId: z.uuid(), amountUsd: usd.gt(0), note: z.string().trim().min(1).max(200) }),
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
  const now = new Date();
  const b = body.data;
  if (b.action === 'grant') {
    const userId = b.userId ?? (b.email ? await findUserIdByEmail(b.email) : null);
    if (!userId) return json({ error: 'No member with that email.' }, b.email ? 404 : 400);
    const account = await grantAccess({ userId, allowanceMicro: b.amountUsd === undefined ? defaultAllowanceMicro() : usdToMicro(b.amountUsd), adminId: admin.id, now });
    return json({ account }, 200);
  }
  const account =
    b.action === 'set_allowance' ? await setAllowance({ userId: b.userId, allowanceMicro: usdToMicro(b.amountUsd), adminId: admin.id, now })
    : b.action === 'add_credit' ? await addCredit({ userId: b.userId, amountMicro: usdToMicro(b.amountUsd), adminId: admin.id, note: b.note, now })
    : await revokeAccess({ userId: b.userId, adminId: admin.id, now });
  if (!account) return json({ error: 'No Ask AI account for that member. Grant access first.' }, 404);
  return json({ account }, 200);
}

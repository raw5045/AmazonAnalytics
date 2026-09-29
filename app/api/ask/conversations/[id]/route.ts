/**
 * DELETE /api/ask/conversations/[id] — the member deletes one of their chats (spec §7, §11.2; busy
 * while a turn is in flight). Order: kill switch → same-origin → session → uuid shape (before any
 * DB call — Task 8 review, M7) → eligibility → delete. `cache-control: no-store` on every response,
 * bodyless ones included.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/AuthError';
import { askAiEnabled } from '@/lib/ask/config';
import { askAiEligible } from '@/lib/ask/eligibility';
import { getAccount } from '@/lib/ask/ledger';
import { isSameOrigin } from '@/lib/ask/sameOrigin';
import { BAD_REQUEST_MESSAGE, BUSY_MESSAGE, CROSS_SITE_MESSAGE } from '@/lib/ask/messages';
import { deleteConversation } from '@/lib/ask/conversations';

export const runtime = 'nodejs';
const NO_STORE = { 'cache-control': 'no-store' };
function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!askAiEnabled()) return new NextResponse(null, { status: 404, headers: NO_STORE });
  if (!isSameOrigin(req)) return json({ error: CROSS_SITE_MESSAGE }, 403);
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.code === 'UNAUTHENTICATED' ? 401 : 403);
    throw e;
  }
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return json({ error: BAD_REQUEST_MESSAGE, code: 'bad_request' }, 400);
  if (!askAiEligible(user.role, await getAccount(user.id))) return new NextResponse(null, { status: 404, headers: NO_STORE });
  const outcome = await deleteConversation(user.id, id);
  if (outcome === 'busy') return json({ error: BUSY_MESSAGE, code: 'busy' }, 409);
  return new NextResponse(null, { status: outcome === 'deleted' ? 204 : 404, headers: NO_STORE });
}

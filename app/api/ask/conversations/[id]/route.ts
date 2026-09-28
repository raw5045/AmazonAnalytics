/** DELETE /api/ask/conversations/[id] — the member deletes one of their chats (spec §7, §11.2; busy while a turn is in flight). */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/AuthError';
import { askAiEnabled } from '@/lib/ask/config';
import { askAiEligible } from '@/lib/ask/eligibility';
import { getAccount } from '@/lib/ask/ledger';
import { isSameOrigin } from '@/lib/ask/sameOrigin';
import { deleteConversation } from '@/lib/ask/conversations';

export const runtime = 'nodejs';
const NO_STORE = { 'cache-control': 'no-store' };

export async function DELETE(req: Request, ctx: RouteContext<'/api/ask/conversations/[id]'>) {
  if (!askAiEnabled()) return new NextResponse(null, { status: 404 });
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Cross-site requests are not allowed.' }, { status: 403 });
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    throw e;
  }
  if (!askAiEligible(user.role, await getAccount(user.id))) return new NextResponse(null, { status: 404 });
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: 'Not a chat id.' }, { status: 400 });
  const outcome = await deleteConversation(user.id, id);
  if (outcome === 'busy') return NextResponse.json({ error: 'Wait for the current answer to finish.', code: 'busy' }, { status: 409, headers: NO_STORE });
  return new NextResponse(null, { status: outcome === 'deleted' ? 204 : 404, headers: NO_STORE });
}

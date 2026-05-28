/**
 * DELETE /api/watchlist/items/[keywordId]  → un-watch a keyword
 *
 * Idempotent — deleting a non-existent row (or another user's row)
 * returns 200 with `{ ok: true }`. We never leak existence; from the
 * client's perspective the desired end-state is "not watched", and
 * after this call it is.
 */
import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { watchlistItems } from '@/db/schema';
import { isValidUuid } from '@/lib/watchlist/validation';

export const runtime = 'nodejs';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ keywordId: string }> },
) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    return handleAuthError(e);
  }

  const { keywordId } = await params;
  if (!isValidUuid(keywordId)) {
    return NextResponse.json({ error: 'keywordId must be a UUID' }, { status: 400 });
  }

  // Scoped delete; if no row matches, no rows are affected, and we
  // still return ok:true. This is correct for an idempotent endpoint.
  await db
    .delete(watchlistItems)
    .where(and(
      eq(watchlistItems.userId, user.id),
      eq(watchlistItems.keywordId, keywordId),
    ));

  return NextResponse.json({ ok: true });
}

function handleAuthError(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json(
      { error: e.message },
      { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 },
    );
  }
  throw e;
}

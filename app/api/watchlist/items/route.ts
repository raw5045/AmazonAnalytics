/**
 * GET  /api/watchlist/items   → list current user's watched keywords
 * POST /api/watchlist/items   → add a keyword to the watchlist
 *
 * Both require an authenticated user. POST enforces the 100-keyword cap
 * and is idempotent (re-watching is a 200 no-op via ON CONFLICT DO NOTHING).
 */
import { NextResponse } from 'next/server';
import { eq, desc, sql } from 'drizzle-orm';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { watchlistItems, searchTerms } from '@/db/schema';
import { MAX_WATCHED_KEYWORDS, isValidUuid } from '@/lib/watchlist/validation';

export const runtime = 'nodejs';

export async function GET() {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    return handleAuthError(e);
  }

  const rows = await db
    .select({ keywordId: watchlistItems.keywordId, addedAt: watchlistItems.addedAt })
    .from(watchlistItems)
    .where(eq(watchlistItems.userId, user.id))
    .orderBy(desc(watchlistItems.addedAt));

  return NextResponse.json({
    items: rows.map((r) => ({
      keywordId: r.keywordId,
      addedAt: r.addedAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    return handleAuthError(e);
  }

  const body = (await req.json().catch(() => ({}))) as { keywordId?: unknown };
  if (!isValidUuid(body.keywordId)) {
    return NextResponse.json({ error: 'keywordId must be a UUID' }, { status: 400 });
  }
  const keywordId = body.keywordId;

  // Verify the keyword exists before we create a watchlist row pointing
  // at it. (FK would also catch this but the error is nicer.)
  const [kw] = await db
    .select({ id: searchTerms.id })
    .from(searchTerms)
    .where(eq(searchTerms.id, keywordId))
    .limit(1);
  if (!kw) {
    return NextResponse.json({ error: 'keyword not found' }, { status: 404 });
  }

  // Cap check. Race-safe enough — even if two requests both pass this
  // check, the second insert would land at 101 and the user can prune;
  // the goal is a clear UX error in the common case.
  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(watchlistItems)
    .where(eq(watchlistItems.userId, user.id));
  if (n >= MAX_WATCHED_KEYWORDS) {
    // Check if it's already watched first — if so, second add should be
    // a no-op success, not a cap error.
    const [existing] = await db
      .select({ k: watchlistItems.keywordId })
      .from(watchlistItems)
      .where(sql`${watchlistItems.userId} = ${user.id} AND ${watchlistItems.keywordId} = ${keywordId}`)
      .limit(1);
    if (existing) {
      return NextResponse.json({ ok: true, addedAt: null }); // already watching
    }
    return NextResponse.json(
      { error: 'watchlist_at_cap', message: `You've reached the ${MAX_WATCHED_KEYWORDS}-keyword limit. Remove one to add more.` },
      { status: 409 },
    );
  }

  // Idempotent insert. If the row already exists, no change; we still
  // return ok:true.
  const inserted = await db
    .insert(watchlistItems)
    .values({ userId: user.id, keywordId })
    .onConflictDoNothing()
    .returning({ addedAt: watchlistItems.addedAt });

  const addedAt = inserted[0]?.addedAt?.toISOString() ?? null;
  return NextResponse.json({ ok: true, addedAt });
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

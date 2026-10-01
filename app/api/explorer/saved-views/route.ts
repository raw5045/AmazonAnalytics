/**
 * GET  /api/explorer/saved-views        → list current user's views
 * POST /api/explorer/saved-views        → create a new view
 *
 * Both require an authenticated user. POST enforces the 5-view limit
 * + per-user-unique name constraint with clear error responses.
 */
import { NextResponse } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { savedViews } from '@/db/schema';
import { MAX_VIEWS_PER_USER } from '@/lib/savedViews/validation';
import { createSavedView } from '@/lib/savedViews/commands';
import { SAVED_VIEW_HTTP_STATUS } from '@/lib/savedViews/httpStatus';

export const runtime = 'nodejs';

export async function GET() {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    return handleAuthError(e);
  }

  const rows = await db
    .select()
    .from(savedViews)
    .where(eq(savedViews.userId, user.id))
    .orderBy(desc(savedViews.createdAt))
    .limit(MAX_VIEWS_PER_USER);

  return NextResponse.json({
    views: rows.map((r) => ({
      id: r.id,
      name: r.name,
      filters: r.filters,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
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
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; filters?: unknown } | null;
  const result = await createSavedView(user.id, { name: body?.name, filters: body?.filters });
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: SAVED_VIEW_HTTP_STATUS[result.code] });
  return NextResponse.json({ view: result.view });
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

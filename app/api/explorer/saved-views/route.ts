/**
 * GET  /api/explorer/saved-views        → list current user's views
 * POST /api/explorer/saved-views        → create a new view
 *
 * Both require an authenticated user. POST enforces the 5-view limit
 * + per-user-unique name constraint with clear error responses.
 */
import { NextResponse } from 'next/server';
import { eq, and, desc, sql } from 'drizzle-orm';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { savedViews } from '@/db/schema';
import {
  MAX_VIEWS_PER_USER,
  normalizeFilters,
  validateName,
} from '@/lib/savedViews/validation';

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

  const body = (await req.json().catch(() => ({}))) as { name?: unknown; filters?: unknown };
  const nameResult = validateName(body.name);
  if (!nameResult.ok) {
    return NextResponse.json({ error: nameResult.error }, { status: 400 });
  }
  const filters = normalizeFilters(body.filters);

  // 5-view limit check. Race-safe enough — even if two requests
  // dodge this, the user can clean up; we just want a clear UX error.
  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(savedViews)
    .where(eq(savedViews.userId, user.id));
  if (n >= MAX_VIEWS_PER_USER) {
    return NextResponse.json(
      { error: `You've reached the ${MAX_VIEWS_PER_USER}-view limit. Delete a saved view to add a new one.` },
      { status: 400 },
    );
  }

  // Name uniqueness — let the DB enforce via unique index; map the
  // 23505 error code to a clean 409.
  try {
    const [created] = await db
      .insert(savedViews)
      .values({ userId: user.id, name: nameResult.name, filters })
      .returning();
    return NextResponse.json({
      view: {
        id: created.id,
        name: created.name,
        filters: created.filters,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json(
        { error: `You already have a view named "${nameResult.name}". Choose a different name or update the existing one.` },
        { status: 409 },
      );
    }
    throw e;
  }
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

function isUniqueViolation(e: unknown): boolean {
  return Boolean(
    e &&
      typeof e === 'object' &&
      'code' in e &&
      (e as { code: string }).code === '23505',
  );
}

/**
 * PATCH  /api/explorer/saved-views/[id] → rename and/or update filters
 * DELETE /api/explorer/saved-views/[id] → delete
 *
 * Ownership: every operation checks that the row's user_id matches the
 * authenticated user. Non-owners get 404 (not 403) to avoid leaking
 * existence.
 */
import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { savedViews } from '@/db/schema';
import { normalizeFilters, validateName } from '@/lib/savedViews/validation';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    return handleAuthError(e);
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid view id' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    name?: unknown;
    filters?: unknown;
  };

  // Build an update payload from whichever fields are present.
  const updates: { name?: string; filters?: unknown; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) {
    const nameResult = validateName(body.name);
    if (!nameResult.ok) {
      return NextResponse.json({ error: nameResult.error }, { status: 400 });
    }
    updates.name = nameResult.name;
  }
  if (body.filters !== undefined) {
    updates.filters = normalizeFilters(body.filters);
  }

  if (updates.name === undefined && updates.filters === undefined) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  }

  try {
    const [updated] = await db
      .update(savedViews)
      .set(updates)
      .where(and(eq(savedViews.id, id), eq(savedViews.userId, user.id)))
      .returning();
    if (!updated) {
      return NextResponse.json({ error: 'view not found' }, { status: 404 });
    }
    return NextResponse.json({
      view: {
        id: updated.id,
        name: updated.name,
        filters: updated.filters,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json(
        { error: `You already have a view with that name.` },
        { status: 409 },
      );
    }
    throw e;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    return handleAuthError(e);
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid view id' }, { status: 400 });
  }

  const result = await db
    .delete(savedViews)
    .where(and(eq(savedViews.id, id), eq(savedViews.userId, user.id)))
    .returning({ id: savedViews.id });

  if (result.length === 0) {
    return NextResponse.json({ error: 'view not found' }, { status: 404 });
  }
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

function isUniqueViolation(e: unknown): boolean {
  return Boolean(
    e &&
      typeof e === 'object' &&
      'code' in e &&
      (e as { code: string }).code === '23505',
  );
}

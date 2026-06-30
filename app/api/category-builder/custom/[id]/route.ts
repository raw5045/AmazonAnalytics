/**
 * PATCH  /api/category-builder/custom/[id] → rename / replace leafPaths
 * DELETE /api/category-builder/custom/[id] → delete
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';
import { rowToDTO } from '@/lib/customCategories/loadServer';
import {
  validateName,
  normalizePaths,
  isValidUuid,
  isUniqueViolation,
  MAX_LEAF_PATHS_PER_CATEGORY,
} from '@/lib/customCategories/validation';

export const runtime = 'nodejs';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  const { id } = await params;
  if (!isValidUuid(id)) return NextResponse.json({ error: 'invalid category id' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; leafPaths?: unknown };
  const nameResult = validateName(body.name);
  if (!nameResult.ok) return NextResponse.json({ error: nameResult.error }, { status: 400 });
  const leafPaths = normalizePaths(body.leafPaths);
  if (leafPaths.length === 0) return NextResponse.json({ error: 'A category needs at least one leaf.' }, { status: 400 });
  if (leafPaths.length > MAX_LEAF_PATHS_PER_CATEGORY) {
    return NextResponse.json({ error: `A category can include at most ${MAX_LEAF_PATHS_PER_CATEGORY.toLocaleString()} leaves.` }, { status: 400 });
  }

  try {
    const [updated] = await db
      .update(customCategories)
      .set({ name: nameResult.name, leafPaths, updatedAt: new Date() })
      .where(and(eq(customCategories.id, id), eq(customCategories.userId, user.id)))
      .returning();
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ category: rowToDTO(updated) });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: `You already have a category named "${nameResult.name}".` }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  const { id } = await params;
  if (!isValidUuid(id)) return NextResponse.json({ error: 'invalid category id' }, { status: 400 });
  const deleted = await db
    .delete(customCategories)
    .where(and(eq(customCategories.id, id), eq(customCategories.userId, user.id)))
    .returning({ id: customCategories.id });
  if (deleted.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

function handleAuthError(e: unknown): NextResponse {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
  throw e;
}

/**
 * GET  /api/category-builder/custom → list current user's custom categories
 * POST /api/category-builder/custom → create one { name, leafNames }
 */
import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';
import { listCustomCategoriesForUser, rowToDTO } from '@/lib/customCategories/loadServer';
import {
  validateName,
  normalizeLeafNames,
  isUniqueViolation,
  MAX_CUSTOM_CATEGORIES,
} from '@/lib/customCategories/validation';

export const runtime = 'nodejs';

export async function GET() {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  return NextResponse.json({ categories: await listCustomCategoriesForUser(user.id) });
}

export async function POST(req: Request) {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }

  const body = (await req.json().catch(() => ({}))) as { name?: unknown; leafNames?: unknown };
  const nameResult = validateName(body.name);
  if (!nameResult.ok) return NextResponse.json({ error: nameResult.error }, { status: 400 });
  const leafNames = normalizeLeafNames(body.leafNames);
  if (leafNames.length === 0) return NextResponse.json({ error: 'Add at least one leaf category before saving.' }, { status: 400 });

  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(customCategories)
    .where(eq(customCategories.userId, user.id));
  if (n >= MAX_CUSTOM_CATEGORIES) {
    return NextResponse.json({ error: `You've reached the ${MAX_CUSTOM_CATEGORIES}-category limit. Delete one to add another.` }, { status: 400 });
  }

  try {
    const [created] = await db
      .insert(customCategories)
      .values({ userId: user.id, name: nameResult.name, leafNames })
      .returning();
    return NextResponse.json({ category: rowToDTO(created) });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: `You already have a category named "${nameResult.name}".` }, { status: 409 });
    }
    throw e;
  }
}

function handleAuthError(e: unknown): NextResponse {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
  throw e;
}

/**
 * GET  /api/category-builder/custom → list current user's custom categories
 * POST /api/category-builder/custom → create one { name, leafPaths }
 */
import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { createCustomCategory } from '@/lib/customCategories/commands';
import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';

export const runtime = 'nodejs';

export async function GET() {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  return NextResponse.json({ categories: await listCustomCategoriesForUser(user.id) });
}

export async function POST(req: Request) {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; leafPaths?: unknown } | null;
  const result = await createCustomCategory(user.id, { name: body?.name, leafPaths: body?.leafPaths });
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.code === 'duplicate_name' ? 409 : 400 });
  return NextResponse.json({ category: result.category });
}

function handleAuthError(e: unknown): NextResponse {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
  throw e;
}

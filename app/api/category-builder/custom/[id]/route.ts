/**
 * PATCH  /api/category-builder/custom/[id] → rename / replace leafPaths
 * DELETE /api/category-builder/custom/[id] → delete
 */
import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { deleteCustomCategory, updateCustomCategory } from '@/lib/customCategories/commands';
import { CUSTOM_CATEGORY_HTTP_STATUS } from '@/lib/customCategories/httpStatus';

export const runtime = 'nodejs';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; leafPaths?: unknown } | null;
  // Full replace, as always: both fields are required here even though the command accepts a partial.
  const result = await updateCustomCategory(user.id, id, { name: body?.name ?? null, leafPaths: body?.leafPaths ?? [] });
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: CUSTOM_CATEGORY_HTTP_STATUS[result.code] });
  return NextResponse.json({ category: result.category });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  const { id } = await params;
  const result = await deleteCustomCategory(user.id, id);
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: CUSTOM_CATEGORY_HTTP_STATUS[result.code] });
  return NextResponse.json({ ok: true });
}

function handleAuthError(e: unknown): NextResponse {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
  throw e;
}

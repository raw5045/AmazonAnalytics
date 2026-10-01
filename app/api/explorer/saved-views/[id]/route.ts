/**
 * PATCH  /api/explorer/saved-views/[id] → rename and/or update filters
 * DELETE /api/explorer/saved-views/[id] → delete
 *
 * Ownership: every operation checks that the row's user_id matches the
 * authenticated user. Non-owners get 404 (not 403) to avoid leaking
 * existence.
 */
import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { deleteSavedView, updateSavedView, type SavedViewCommandCode } from '@/lib/savedViews/commands';

export const runtime = 'nodejs';

const STATUS: Record<SavedViewCommandCode, number> = {
  invalid_id: 400, invalid_name: 400, nothing_to_update: 400, cap_reached: 400, duplicate_name: 409, not_found: 404,
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    return handleAuthError(e);
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; filters?: unknown } | null;
  const result = await updateSavedView(user.id, id, { name: body?.name, filters: body?.filters });
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: STATUS[result.code] });
  return NextResponse.json({ view: result.view });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    return handleAuthError(e);
  }
  const { id } = await params;
  const result = await deleteSavedView(user.id, id);
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: STATUS[result.code] });
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

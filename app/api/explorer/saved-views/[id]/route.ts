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
import { deleteSavedView, updateSavedView } from '@/lib/savedViews/commands';
import { SAVED_VIEW_HTTP_STATUS } from '@/lib/savedViews/httpStatus';

export const runtime = 'nodejs';

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
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: SAVED_VIEW_HTTP_STATUS[result.code] });
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
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: SAVED_VIEW_HTTP_STATUS[result.code] });
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

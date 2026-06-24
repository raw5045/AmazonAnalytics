import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { loadCategoryTree } from '@/lib/categoryBuilder/loadTree';
import { leavesAtPath, parsePathParam } from '@/lib/categoryBuilder/treeNav';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try { await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  const path = parsePathParam(req.nextUrl.searchParams.get('path'));
  const { tree } = await loadCategoryTree();
  return NextResponse.json({ leaves: leavesAtPath(tree, path) });
}

function handleAuthError(e: unknown): NextResponse {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
  throw e;
}

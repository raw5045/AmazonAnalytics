import { NextRequest, NextResponse } from 'next/server';
import { loadCategoryTree } from '@/lib/categoryBuilder/loadTree';
import { childrenAtPath, parsePathParam } from '@/lib/categoryBuilder/treeNav';

// Public, ungated: the category taxonomy is non-sensitive, and /category-builder
// is itself a public route (middleware protects only /admin, /app, /explorer).
// Keeping this open lets signed-out viewers drill the tree, exactly as they
// could when the whole tree was shipped client-side. (Contrast /custom, which
// is user-scoped and stays auth-gated.)
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const path = parsePathParam(req.nextUrl.searchParams.get('path'));
  const { tree } = await loadCategoryTree();
  return NextResponse.json({ children: childrenAtPath(tree, path) });
}

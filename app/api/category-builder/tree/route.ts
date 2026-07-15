import { NextRequest, NextResponse } from 'next/server';
import { loadChildrenAtPath } from '@/lib/categoryBuilder/loadTree';
import { parsePathParam } from '@/lib/categoryBuilder/treeNav';

// Public, ungated: the category taxonomy is non-sensitive. Middleware gates the
// app pages (/admin, /explorer, /watchlist, /category-builder), not this API
// path, so it stays open — harmless if reached signed-out. (Contrast /custom,
// which is user-scoped and stays auth-gated.)
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const path = parsePathParam(req.nextUrl.searchParams.get('path'));
  const res = NextResponse.json({ children: await loadChildrenAtPath(path) });
  // Non-sensitive taxonomy that changes only when a new snapshot imports. Let
  // Vercel's CDN serve repeated drill-downs of the same path so they don't
  // re-hit Neon. (A flood of DISTINCT paths still needs rate-limiting — deferred;
  // see docs/pre-launch-polishing.md Batch 3.)
  res.headers.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res;
}

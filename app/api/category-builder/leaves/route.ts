import { NextRequest, NextResponse } from 'next/server';
import { loadLeavesUnderPath } from '@/lib/categoryBuilder/loadTree';
import { parsePathParam } from '@/lib/categoryBuilder/treeNav';

// Public, ungated — see the note in ../tree/route.ts. Returns the leaf names
// under a path for "Add" / "Add all of X". Non-sensitive taxonomy.
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const path = parsePathParam(req.nextUrl.searchParams.get('path'));
  const res = NextResponse.json({ leaves: await loadLeavesUnderPath(path) });
  // CDN-cache repeated same-path requests (see ../tree/route.ts). A flood of
  // DISTINCT paths still needs rate-limiting — deferred (Batch 3).
  res.headers.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res;
}

import { NextRequest, NextResponse } from 'next/server';
import { loadLeavesUnderPath } from '@/lib/categoryBuilder/loadTree';
import { parsePathParam } from '@/lib/categoryBuilder/treeNav';

// Public, ungated — see the note in ../tree/route.ts. Returns the leaf names
// under a path for "Add" / "Add all of X". Non-sensitive taxonomy.
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const path = parsePathParam(req.nextUrl.searchParams.get('path'));
  return NextResponse.json({ leaves: await loadLeavesUnderPath(path) });
}

/**
 * GET /api/explorer/export — the current explorer result set as a CSV
 * download. Owner-chosen caps: 10,000 rows per export, 10 exports per user
 * per ET day; free during beta. Reuses the explorer's own filter parser and
 * query runner, so the file is exactly what the page shows, in the page's
 * sort. See docs/superpowers/specs/2026-09-16-explorer-csv-export-design.md.
 */
import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/AuthError';
import { parseExplorerFilters } from '@/lib/explorer/parseFilters';
import { runExplorerQuery } from '@/lib/explorer/runQuery';
import { expandCustomCategories } from '@/lib/customCategories/expand';
import { countUserActivityToday } from '@/lib/activity/readToday';
import { bumpUserActivity } from '@/lib/activity/bump';
import { etDay } from '@/lib/activity/etDay';
import { buildExplorerCsv, EXPORT_ROW_CAP, EXPORTS_PER_DAY } from '@/lib/explorer/export/buildCsv';
import { searchParamsToLike } from '@/lib/explorer/export/query';

export const runtime = 'nodejs';
export const maxDuration = 120; // same ceiling as the explorer page

export async function GET(req: Request) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  // Soft daily cap on the fire-and-forget counter (two simultaneous exports
  // at 9/10 may both pass — accepted; the cap exists to make bulk extraction
  // impractical, not to be a ledger).
  const usedToday = await countUserActivityToday(user.id, 'explorer_export');
  if (usedToday >= EXPORTS_PER_DAY) {
    return NextResponse.json(
      { error: `Daily export limit reached (${EXPORTS_PER_DAY} per day). Try again tomorrow.` },
      { status: 429 },
    );
  }

  // Same parsing and custom-category expansion as the explorer page, with the
  // export cap as the (only) page.
  const parsed = parseExplorerFilters(searchParamsToLike(new URL(req.url).searchParams));
  let filters = { ...parsed, page: 1, perPage: EXPORT_ROW_CAP };
  if (filters.customCategoryIds.length > 0) {
    const merged = await expandCustomCategories(user.id, filters.customCategoryIds, filters.leafPaths);
    filters = { ...filters, leafPaths: merged };
  }

  const result = await runExplorerQuery(filters);
  if (result.broadTimedOut) {
    return NextResponse.json(
      { error: 'That search is too broad to export — narrow the filters and try again.' },
      { status: 504 },
    );
  }

  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com';
  const csv = buildExplorerCsv(result.rows, { window: filters.window, matchMode: filters.matchMode, appUrl });
  const week = result.currentWeekEndDate ?? etDay(new Date());
  void bumpUserActivity(user.id, 'explorer_export'); // abuse-digest counter + daily cap (fire-and-forget)

  const headers: Record<string, string> = {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="keywordquarry-keywords-${week}.csv"`,
    'cache-control': 'no-store',
    'x-export-rows': String(result.rows.length),
  };
  if (result.hasNext) headers['x-export-truncated'] = 'true';
  return new Response(csv, { status: 200, headers });
}

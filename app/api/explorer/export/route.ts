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
import { csvHeaderLine, csvRowLine, EXPORT_ROW_CAP, EXPORTS_PER_DAY } from '@/lib/explorer/export/buildCsv';
import { searchParamsToLike } from '@/lib/explorer/export/query';

export const runtime = 'nodejs';
export const maxDuration = 120; // same ceiling as the explorer page

/** Rows per streamed chunk — keeps the response a stream (no 4.5 MB buffered-response limit). */
const STREAM_CHUNK_ROWS = 500;

export async function GET(req: Request) {
  // A GET with a side effect (quota) behind a cookie: refuse cross-site
  // fetches/navigations outright so another site can't burn a member's
  // daily exports. Same-origin and direct navigations ('none') pass.
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json({ error: 'Cross-site export requests are not allowed.' }, { status: 403 });
  }

  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  // Soft daily cap: read-then-run, so two simultaneous exports at 9/10 may
  // both pass — accepted; the cap exists to make bulk extraction impractical,
  // not to be a ledger.
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

  // Truncation: the N+1 probe on the covered/legacy paths, OR a capped count
  // on the search-term path (there `hasNext` is derived from a total already
  // clamped to 10,000, so at perPage = 10,000 it reads false exactly when the
  // real count is larger).
  const truncated = result.hasNext || (result.rows.length >= EXPORT_ROW_CAP && result.totalIsCapped);

  // The counter IS the cap's enforcement, so it is awaited (fail-soft by
  // contract, so it cannot fail the request). An empty export costs nothing.
  if (result.rows.length > 0) await bumpUserActivity(user.id, 'explorer_export');

  const opts = {
    window: filters.window,
    matchMode: filters.matchMode,
    appUrl: process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com',
  };
  const meta = result.currentWeekEndDate;
  const week = meta && /^\d{4}-\d{2}-\d{2}$/.test(meta) ? meta : etDay(new Date());

  const encoder = new TextEncoder();
  const rows = result.rows;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(csvHeaderLine(opts)));
      for (let i = 0; i < rows.length; i += STREAM_CHUNK_ROWS) {
        controller.enqueue(
          encoder.encode(rows.slice(i, i + STREAM_CHUNK_ROWS).map((r) => csvRowLine(r, opts)).join('')),
        );
      }
      controller.close();
    },
  });

  const headers: Record<string, string> = {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="keywordquarry-keywords-${week}.csv"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-export-rows': String(rows.length),
  };
  if (truncated) headers['x-export-truncated'] = 'true';
  return new Response(body, { status: 200, headers });
}

# Explorer CSV Export — Design Spec

**Date:** 2026-09-16
**Status:** Approved (owner picked the caps and beta scope in chat)
**Scope:** An "Export CSV" button on the explorer results that downloads the
current filtered result set, capped at 10,000 rows, at most 10 exports per user
per ET day, free during beta. Reuses the explorer's own filter parsing and query
runner; adds one activity metric and an "Exports" column to the daily digest.
No schema change, no worker change.

## Motivation

Beta feedback: after dialing in a filter, members want the whole result set in
a spreadsheet, not one page at a time. The explorer already runs one SQL per
page with `LIMIT/OFFSET`, so an export is the same query with a larger limit —
not a loop over pages.

## Decisions (owner-confirmed)

| Question | Decision |
|---|---|
| Rows per export | **10,000** — matches the explorer's existing paging ceiling (`MAX_EXPLORER_OFFSET` ≈ 10,000; counts already display "10,000+") |
| Exports per user per day | **10**, counted on the ET calendar day via the existing `user_activity_daily` counters (metric `explorer_export`) |
| Availability | Free during beta, like everything else; the counter makes a paid gate easy later |
| Scope of "results" | Exactly the effective filters of the page (saved view already resolved by the page; custom categories expanded server-side by the route from the user's own categories) |
| Row order | The page's current sort |
| Delivery | Streamed response (row chunks) with a download header — a full 10k-row file is ~5 MB, past Vercel's 4.5 MB limit for buffered responses |

## Part 1 — CSV builder (`lib/explorer/export/buildCsv.ts`, pure)

- `EXPORT_ROW_CAP = 10_000`, `EXPORTS_PER_DAY = 10`.
- `exportHeader({ window, matchMode })` → column labels, in order: Search term ·
  Current rank · Prior rank (<window>) · Rank movement · Est. monthly volume ·
  Volume prior (<window>) · Volume change (<window>) · Avg price USD (top-3) ·
  Avg reviews (top-3) · Fake volume · In title #1 · In title #2 · In title #3 ·
  Title matches (of 3) · Category · Leaf category · Top clicked ASIN · Top clicked
  title · Top clicked click share % · Top clicked conversion share % · Amazon
  search URL · KeywordQuarry URL.
- Title flags/count follow the page's match mode (strict = Amazon's, loose = ours).
- Price cents → dollars with two decimals; booleans → yes/no; null → empty.
- `csvEscape`: RFC 4180 quoting (comma, quote, CR/LF); string values starting
  with `=`, `+`, `-`, `@` get a leading apostrophe (spreadsheet formula
  injection; the apostrophe is visible in the sheet for a genuine keyword
  starting with one of those — accepted); numbers are never touched.
- `buildExplorerCsv(rows, opts)` → UTF-8 BOM + header + rows, CRLF line
  endings (Excel-friendly).

## Part 2 — Filter plumbing (`lib/explorer/export/query.ts`, pure)

- `searchParamsToLike(URLSearchParams)` → the `SearchParamsLike` shape
  `parseExplorerFilters` expects (repeated keys become arrays).
- `filtersToQueryString(filters)` → query string for the effective filters
  (via the saved-views serializer, now exported), pagination dropped. The page
  passes this to the button so a `?view=<id>` bookmark exports the view's
  filters without the route re-resolving saved views.

## Part 3 — Daily cap reader (`lib/activity/readToday.ts`)

`countUserActivityToday(userId, metric)` reads today's `user_activity_daily`
row (0 when absent). `UserActivityMetric` gains `'explorer_export'`.

## Part 4 — Route (`GET /api/explorer/export`)

1. `requireAuthenticatedUser` → 401/403 (AuthError codes).
2. Cap: `countUserActivityToday(user.id, 'explorer_export') >= 10` → 429
   `{ error: 'Daily export limit reached (10 per day). Try again tomorrow.' }`.
3. `parseExplorerFilters(searchParamsToLike(url.searchParams))`, then
   `{ ...filters, page: 1, perPage: EXPORT_ROW_CAP }`; expand
   `customCategoryIds` with `expandCustomCategories(user.id, …)` exactly like
   the page.
4. `runExplorerQuery` → `broadTimedOut` → 504 `{ error }`; otherwise build the
   CSV and respond `200 text/csv; charset=utf-8`,
   `Content-Disposition: attachment; filename="keywordquarry-keywords-<week>.csv"`
   (week = the data's `currentWeekEndDate`), `Cache-Control: no-store`,
   `X-Export-Rows: <n>`, and `X-Export-Truncated: true` when the query's N+1
   probe says more rows exist beyond the cap — or, on the search-term path
   (where `hasNext` derives from a count already clamped to 10,000), when the
   export hit the cap and the count was capped.
5. `await bumpUserActivity(user.id, 'explorer_export')` after a successful build
   (awaited — it is the cap's enforcement — but fail-soft, so it can never fail
   the request; skipped for an empty export). The cap stays soft: read-then-run.
   Cross-site requests (`sec-fetch-site` other than same-origin/none) are
   refused up front so another site cannot burn a member's quota.
6. `export const maxDuration = 120` (same as the explorer page); the query
   keeps its existing statement timeouts.

## Part 5 — Button (`app/(app)/explorer/ExportButton.tsx`, client)

Rendered in the results header next to "Reset filters" when the page has rows
and a signed-in user, with `query` = the effective filters' query string.
Click → `fetch('/api/explorer/export?' + query)`:
- 200 → object URL + anchor click with the server's filename; status line
  "Downloaded N rows" (+ "(first 10,000 of a larger result)" when truncated).
- 429 → the server's limit message inline.
- Anything else → "Export failed — please try again."
Disabled with "Exporting…" while in flight.

## Part 6 — Digest column

`PerUserActivity.exports` (from the `explorer_export` counter) rendered as an
"Exports" column in all three active-user tables (daily/weekly/monthly) and in
the text version. No new flag: the cap already bounds it.

## Testing

- `buildCsv.test.ts` — escaping/quoting/formula guard, BOM + CRLF, header order,
  window label, strict vs loose flags, price conversion, URLs, empty cells.
- `query.test.ts` — repeated keys → arrays; effective filters round-trip
  through `filtersToQueryString` → `parseExplorerFilters` with pagination reset.
- `readToday.test.ts` — count read / 0 when absent.
- `route.test.ts` — 401, 429 (no query, no bump), 200 headers/body/bump, custom
  category expansion + cap limit passed to the runner, truncated header, 504.
- `ExportButton.test.tsx` — fetch URL, success download + status, truncated
  note, 429 message, failure message.
- Digest: fixtures gain `exports`; `assembleStats` maps the metric; builder
  renders the column.

## Non-goals

- Streaming/chunked exports beyond 10k rows; XLSX; scheduled or emailed
  exports; export of detail-page history.
- A hard (transactional) daily cap — the check is read-then-run, so two
  simultaneous exports at 9/10 may both succeed.

## Ship checklist (owner-gated)

1. Typecheck + full suite green; one real export exercised on prod after deploy
   (owner), including the 10,001st-row truncation note on a broad filter.
2. Push authorization (`scripts/checkActiveJobs.ts` first).

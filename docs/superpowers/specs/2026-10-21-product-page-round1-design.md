# Product page feedback, round 1 — design

**Date:** 2026-10-21 · **Owner's feedback:** dates read wrong on the product pages; the facts card repeats what the history charts show; a "data last fetched" stamp; and on the keyword page swap the Leaf category column for Monthly sold and BSR. **Approved design** (this document) after one question: dates render as "Oct 17, 2026" everywhere, including the keyword page's "Latest" chip.

## 1. Goal

Product pages and the keyword page show dates one way ("Oct 17, 2026"), the facts card shows one value per fact with the history left to the charts, the card says when its data was last fetched, and the keyword page's top-clicked-products table shows each product's Monthly sold and BSR instead of its leaf category.

## 2. Dates

New pure helper `lib/format/date.ts` (no React, no I/O, no time zone):

- `formatDay(iso: string): string` — reads the first ten characters as `YYYY-MM-DD` and returns `"Oct 17, 2026"` (month abbreviations Jan–Dec, day without a leading zero). Any input that does not start with a valid `YYYY-MM-DD` (including a month outside 01–12) comes back unchanged.
- `formatFetchTime(iso: string): string` — an ISO timestamp (`2026-10-04T06:00:12.345Z`) becomes `"Oct 4, 2026 06:00 UTC"` (the day through `formatDay`, then characters 11–16 as the clock). When the input has no `T` clock part, it is just `formatDay(iso)`.

Call sites (output on the right):

| Where | Today | After |
|---|---|---|
| `app/(app)/products/ProductResultsTable.tsx` "Listed" column (private `formatDate`) | Aug 1, 2026 | unchanged output, now through `formatDay` (private copy deleted) |
| `app/(app)/explorer/page.tsx` data chip (private `formatWeekLabel`) | Data: week ending Oct 17, 2026 | unchanged output, now through `formatDay` (private copy deleted) |
| `app/(app)/products/[asin]/FactsCard.tsx` Listed since / Tracking since | 2026-08-01 · 2 months / 2025-04-19 | Aug 1, 2026 · 2 months / Apr 19, 2025 |
| `FactsCard.tsx` last-fetched stamp (§3) | fetched 2026-10-08 (12 fetches) under Status | Data last fetched Oct 8, 2026 (bottom-right) |
| `app/(app)/products/[asin]/HistoryCharts.tsx` summary | 37 snapshots, 2026-08-01 to 2026-10-08 | 37 snapshots, Aug 1, 2026 to Oct 8, 2026 (and "1 snapshot, Oct 4, 2026") |
| `HistoryCharts.tsx` tooltip (`formatFetchTime`) | 2026-10-04 06:00 UTC | Oct 4, 2026 06:00 UTC |
| `app/(app)/products/[asin]/ProductKeywordsTable.tsx` streak tooltip | since the week ending 2026-10-03 | since the week ending Oct 3, 2026 |
| `app/(app)/explorer/keyword/[id]/page.tsx` header chip | Latest 2026-10-17 | Latest Oct 17, 2026 (same chip, same styling) |

The chart axis tick labels (short "Oct 4" style, `HistoryCharts.tsx`'s own `MONTHS`) are unchanged. `listingAge` keeps its "2 months" wording.

## 3. Product facts card (`app/(app)/products/[asin]/FactsCard.tsx`)

| Fact | Today | After |
|---|---|---|
| Price | current price + "30d / 90d / 180d / 365d avg …" | current price only |
| BSR | "#1,234" + ratio chip + "30d / 90d avg …" | "#1,234" + the ratio chip ("−35% vs 30d avg"); the averages line goes |
| Reviews | "1,234 · ★ 4.5" + "rating updated 2026-10-01" | "1,234 · ★ 4.5" only |
| Monthly sold | "1,000+" + "as of 2026-10-07" | "1,000+" + a static line "Amazon's 'bought in past month' badge" |
| Status | badge + "fetched 2026-10-08 (12 fetches)" | badge only |
| (new) stamp | — | a muted line at the card's bottom-right: "Data last fetched Oct 8, 2026" (from `lastFetchedAt`; the fetch count is dropped). Rendered only on the fetched card; the "Not fetched yet" and "not in catalog" shapes are unchanged. |
| Brand, Leaf category, Broad category, Listed since, Tracking since, Offers, Amazon | — | unchanged apart from the date format (§2) |

Markup for the stamp: after the `<dl>`, inside the section, `<p className="mt-3 text-right text-xs text-gray-500">Data last fetched {formatDay(facts.lastFetchedAt)}</p>` (omitted when `lastFetchedAt` is null, which the fetched shape never is in practice).

The loader (`lib/products/loadProduct.ts`, `ProductPageFacts`) is unchanged: the averages, `lastRatingUpdate`, `keepaUpdatedAt` and `fetchCount` stay in the type because the MCP `get_product_details` answer still carries them; the card simply stops rendering them.

## 4. Keyword page, top clicked products (`app/(app)/explorer/keyword/[id]/TopProductsSection.tsx`)

Columns: `#` | `Product` | `Click %` | `Conv %` | `Price` | `Reviews` | `Monthly sold` | `BSR`. The `Leaf category` column is removed (the leaf path stays on the product page's facts card).

- `Product` cell: `max-w-md` → `max-w-xs`; still truncated with the full title in the hover title and the ASIN link beneath, unchanged otherwise.
- `Monthly sold` header title: `Amazon's "bought in past month" badge`; cell `formatBadge(enriched?.monthlySold ?? null)` from `lib/products/format` (`"1,000+"`, dash when null), right-aligned, tabular-nums.
- `BSR` header title: `Best Sellers Rank in the main category`; cell `#` + `toLocaleString('en-US')` (`"#1,234"`), dash when null, right-aligned, tabular-nums.
- Both values are the catalog's point-in-time facts the reader already returns (`EnrichedProduct.monthlySold` / `salesRank`, null for a delisted product by the existing rule), so no query or type change.
- The dash is the same grey `—` span the table already uses for a missing title or leaf.

## 5. Unchanged on purpose

The Products list's columns and widths; the MCP tools and their answers (`get_product_details` keeps every field); `lib/products/format.ts`; the BSR ratio chip; the history charts' data and axes; the keyword page's weekly history table and other chips; admin pages.

## 6. Tests

- New `lib/format/date.test.ts`: `formatDay` (a plain date, an ISO timestamp, no leading zero, December, invalid month, non-date input unchanged) and `formatFetchTime` (timestamp → clock, date-only input).
- `ProductResultsTable.test.tsx` and the explorer page tests: the "Listed" column and the data chip read exactly as before.
- `FactsCard.test.tsx`: the averages, "rating updated", "as of" and "fetched … fetches" expectations go; new expectations for the "bought in past month" line, the formatted Listed/Tracking dates, the stamp text, and the stamp's absence on the "Not fetched yet" shape.
- `HistoryCharts.test.tsx`: the summary and tooltip strings in the new format.
- `ProductKeywordsTable.test.tsx`: the streak tooltip in the new format.
- `app/(app)/explorer/keyword/[id]/page.test.tsx` (if the chip is pinned) and `TopProductsSection.test.tsx`: the eight column headers in order, the Monthly sold and BSR cells (a value, a dash, a delisted null), the leaf no longer rendered.

## 7. Ship

Gate (vitest, typecheck, eslint on touched files, build) → local commits → owner-gated push (`checkActiveJobs` first, outside 03:30–06:59 ET) → Vercel green → Chrome smoke: one product page (card lines, stamp, dates, history caption and tooltip) and one keyword page ("Latest" chip, the eight columns, a Monthly sold and a BSR value).

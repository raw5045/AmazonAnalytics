# Listing age on the keyword page — design

**Date:** 2026-10-23 · **Owner's ask:** on the keyword page's "Top clicked products" table, show each product's listing age on the second line of the product cell (after the ASIN); under a year show days, over a year show years and days. **Approved** with the three tweaks below (lowercase units, calendar years, the same rule everywhere an age is shown).

## 1. The age rule (`listingAge` in `lib/products/format.ts`, same signature)

Input: the listing date (`YYYY-MM-DD`) and `now`. Counted in UTC calendar days, as today.

- Under a year: `245 days` (`1 day`, `0 days`).
- A year or more: whole calendar years since the listing date, then the days since that anniversary: `1 year, 245 days`, `8 years, 204 days`, `1 year, 1 day`; on the anniversary itself just `2 years`.
- A listing date in the future (clock skew) reads `0 days`; a missing or unreadable date, or an invalid `now`, reads the dash.
- A Feb 29 listing date takes Mar 1 as its anniversary in non-leap years (what `Date.UTC` does; no special case).

The two existing call sites change output only: the facts card ("Mar 19, 2018 · 8 years, 204 days" instead of "… · 8.6 years") and the Products list's Listed column (the age line under the date).

## 2. The keyword page (`app/(app)/explorer/keyword/[id]/TopProductsSection.tsx`)

The product cell's second line becomes `B009SZXM4E · listed 245 days ago` (or `… · listed 1 year, 245 days ago`): the ASIN link as today (monospace), then a normal-font span with the age, carrying the exact date on hover (`title="Listed on Amazon Mar 19, 2018"`, via `formatDay`). No span when the product has no listing date (no catalog row, or Keepa has none). The date is `EnrichedProduct.listedSince`, which the reader already returns, so no query change.

`TopProductsSection` takes an optional `now?: Date` (default `new Date()`) and passes it to the table, so tests can pin the age; the page keeps calling it without one.

## 3. Unchanged

Column set and widths, the title link, the ASIN link, every other cell; the Products list and facts card markup; the MCP answers (`listedSince` is already a field there).

## 4. Tests

- `lib/products/format.test.ts`: the year cases move to the new wording (`1 year, 35 days`, `1 year`, `2 years`), plus `8 years, 204 days`, `1 year, 1 day`, and the Feb 29 case; the day, future, null, invalid and UTC-boundary cases stay.
- `TopProductsSection.test.tsx`: a product with `listedSince` renders "listed 245 days ago" for a fixed `now`, with the hover title; a product without it renders no age span.
- `FactsCard.test.tsx` and `ProductResultsTable.test.tsx` keep passing unchanged (their fixtures are under a year).

## 5. Ship

Gate → local commit → owner-gated push → Vercel → Chrome smoke on one keyword page (the age line) and one product page (the facts card's age).

# Product Page Round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dates read "Oct 17, 2026" on the product pages and the keyword page, the facts card shows one value per fact plus a "Data last fetched" stamp, and the keyword page's top-clicked-products table shows Monthly sold and BSR instead of Leaf category (spec `docs/superpowers/specs/2026-10-21-product-page-round1-design.md`).

**Architecture:** One pure helper (`lib/format/date.ts`) replaces the two private date formatters and is used by every date on the two pages. The facts card and the keyword table are presentational changes only: no loader, query, type or MCP change (the keyword table's reader already returns `monthlySold` and `salesRank`).

**Tech Stack:** Next 16 app router (server components), React 19, vitest + Testing Library, Tailwind classes, recharts (untouched).

**Conventions (every task):** read `node_modules/next/dist/docs/` before touching page code; TDD (failing test → code → green); `git add` named files only; commit trailer exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; local commits on main, never push; the tree mixes CRLF/LF, so edit with exact-match tools and never convert line endings; lint touched files only: `pnpm exec eslint <files>`; vitest never type-checks, so keep type-only pins; no DDL, nothing reaches `.env.local`'s DATABASE_URL.

---

### Task 1: The shared date formatter, and the two private copies replaced

**Files:**
- Create: `lib/format/date.ts`, `lib/format/date.test.ts`
- Modify: `app/(app)/products/ProductResultsTable.tsx` (lines 39–46 and 215), `app/(app)/explorer/page.tsx` (`DataWeekChip`, lines 299–311)
- Test (existing, must stay green): `app/(app)/products/ProductResultsTable.test.tsx`, `app/(app)/explorer/page.test.tsx` (if present)

- [ ] **Step 1: Write the failing test**

`lib/format/date.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatDay, formatFetchTime } from './date';

describe('formatDay', () => {
  it('reads a stored date as "Mon D, YYYY" without a leading zero on the day', () => {
    expect(formatDay('2026-10-17')).toBe('Oct 17, 2026');
    expect(formatDay('2026-08-01')).toBe('Aug 1, 2026');
    expect(formatDay('2025-12-25')).toBe('Dec 25, 2025');
    expect(formatDay('2026-01-09')).toBe('Jan 9, 2026');
  });

  it('takes the day off an ISO timestamp and ignores the clock', () => {
    expect(formatDay('2026-10-04T06:00:12.345Z')).toBe('Oct 4, 2026');
  });

  it('returns anything that is not a YYYY-MM-DD unchanged, including an invalid month', () => {
    expect(formatDay('2026-13-01')).toBe('2026-13-01');
    expect(formatDay('2026-00-10')).toBe('2026-00-10');
    expect(formatDay('n/a')).toBe('n/a');
    expect(formatDay('')).toBe('');
  });
});

describe('formatFetchTime', () => {
  it('adds the UTC clock of an ISO timestamp', () => {
    expect(formatFetchTime('2026-10-04T06:00:12.345Z')).toBe('Oct 4, 2026 06:00 UTC');
    expect(formatFetchTime('2026-10-04T23:59:00Z')).toBe('Oct 4, 2026 23:59 UTC');
  });

  it('a date without a clock is just the day', () => {
    expect(formatFetchTime('2026-10-04')).toBe('Oct 4, 2026');
  });

  it('non-date input is unchanged', () => {
    expect(formatFetchTime('soon')).toBe('soon');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run lib/format/date.test.ts`
Expected: FAIL (module `./date` not found).

- [ ] **Step 3: Write the helper**

`lib/format/date.ts`:

```ts
// lib/format/date.ts
/**
 * Date display shared by the app's pages (spec 2026-10-21 product page round 1 §2): every stored
 * date (YYYY-MM-DD, or an ISO timestamp) reads as "Oct 17, 2026". Pure and clock-free: the text is
 * read off the string, so the server and the browser render the same thing and no time zone is
 * involved. Anything that does not start with a valid YYYY-MM-DD comes back unchanged.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "2026-10-17" or "2026-10-17T06:00:00.000Z" → "Oct 17, 2026"; other input unchanged. */
export function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[3])}, ${m[1]}` : iso;
}

/** "2026-10-04T06:00:12.345Z" → "Oct 4, 2026 06:00 UTC"; a date without a clock → formatDay(iso). */
export function formatFetchTime(iso: string): string {
  const day = formatDay(iso);
  const clock = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(iso);
  return clock ? `${day} ${clock[1]} UTC` : day;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run lib/format/date.test.ts` → Expected: 6 tests pass.

- [ ] **Step 5: Replace the two private copies (output unchanged)**

`app/(app)/products/ProductResultsTable.tsx`: delete the private `MONTHS` array and `formatDate` function (lines 39–46, the block headed by the comment `/** "2026-08-01" → "Aug 1, 2026", read off the string (no time zone involved). */`), add `import { formatDay } from '@/lib/format/date';` next to the other `@/lib` imports, and change line 215 `<div>{formatDate(row.listedSince)}</div>` to `<div>{formatDay(row.listedSince)}</div>`. Confirm nothing else in the file referenced `MONTHS` or `formatDate`.

`app/(app)/explorer/page.tsx`: add `import { formatDay } from '@/lib/format/date';` with the other `@/lib` imports; in `DataWeekChip` replace `{formatWeekLabel(week)}` with `{formatDay(week)}`; delete the `formatWeekLabel` function (lines 305–311).

- [ ] **Step 6: Run the existing tests for both files**

Run: `pnpm exec vitest run "app/(app)/products/ProductResultsTable.test.tsx" "app/(app)/explorer"`
Expected: all pass (the "Listed" column and the data chip read exactly as before).

- [ ] **Step 7: Lint and commit**

```bash
pnpm exec eslint lib/format/date.ts lib/format/date.test.ts "app/(app)/products/ProductResultsTable.tsx" "app/(app)/explorer/page.tsx"
git add lib/format/date.ts lib/format/date.test.ts "app/(app)/products/ProductResultsTable.tsx" "app/(app)/explorer/page.tsx"
git commit -F - <<'EOF'
feat(format): shared formatDay / formatFetchTime; the Products list and the data chip use it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 2: The facts card — one value per fact, formatted dates, the last-fetched stamp

**Files:**
- Modify: `app/(app)/products/[asin]/FactsCard.tsx`
- Test: `app/(app)/products/[asin]/FactsCard.test.tsx`

Context: the card is a pure server component; `facts` is `ProductFacts` from `lib/products/loadProduct.ts` (unchanged). The test file's `FULL` fixture has `listedSince: '2026-04-12'`, `trackingSince: '2026-04-15'`, `lastRatingUpdate: '2026-10-01'`, `keepaUpdatedAt: '2026-10-07'`, `lastFetchedAt: '2026-10-08T06:30:00.000Z'`, `fetchCount: 12`; `fact(label)` returns the `<dd>` for a label.

- [ ] **Step 1: Update the tests to the new card (they fail first)**

In `FactsCard.test.tsx`:
- The test `renders every label with its value and its "as of" dates` → rename to `renders every label with one value each, dates as "Mon D, YYYY", and the last-fetched stamp`; inside it:
  - `expect(fact('Listed since')).toHaveTextContent('2026-04-12 · 180 days')` → `'Apr 12, 2026 · 180 days'`
  - `expect(fact('Tracking since')).toHaveTextContent('2026-04-15')` → `'Apr 15, 2026'`
  - the Price averages expectation (`'30d / 90d / 180d / 365d avg …'`) → `expect(fact('Price')).not.toHaveTextContent('avg')` (keep the existing current-price expectation)
  - the BSR averages expectation (`'30d / 90d avg #1,900 / #2,500'`) → `expect(fact('BSR')).not.toHaveTextContent('30d / 90d avg')` (keep the rank and ratio-chip expectations)
  - `expect(fact('Reviews')).toHaveTextContent('rating updated 2026-10-01')` → `expect(fact('Reviews')).not.toHaveTextContent('rating updated')`
  - `expect(fact('Monthly sold')).toHaveTextContent('as of 2026-10-07')` → `expect(fact('Monthly sold')).toHaveTextContent("Amazon's 'bought in past month' badge")` and `expect(fact('Monthly sold')).not.toHaveTextContent('as of')`
  - `expect(fact('Status')).toHaveTextContent('fetched 2026-10-08 (12 fetches)')` → `expect(fact('Status')).not.toHaveTextContent('fetched')` and `expect(screen.getByText('Data last fetched Oct 8, 2026')).toBeInTheDocument()`
- The test `the ratio chip and the averages lines are left out when Keepa has none` → rename to `the ratio chip is left out when Keepa has no 30-day average`; keep only its chip assertion(s) and drop the averages assertions.
- The test `one fetch reads "1 fetch"` → replace with:

```tsx
  it('the stamp is omitted when there is no last fetch time', () => {
    render(<FactsCard facts={{ ...FULL, lastFetchedAt: null }} now={NOW} />);
    expect(screen.queryByText(/Data last fetched/)).toBeNull();
  });
```

- In the delisted-row test: `'2026-04-12 · 180 days'` → `'Apr 12, 2026 · 180 days'`, and its Status line expectation `'fetched 2026-10-08 (12 fetches)'` → `expect(screen.getByText('Data last fetched Oct 8, 2026')).toBeInTheDocument()`.
- In the never-fetched test add `expect(screen.queryByText(/Data last fetched/)).toBeNull();`.

- [ ] **Step 2: Run to verify the new expectations fail**

Run: `pnpm exec vitest run "app/(app)/products/[asin]/FactsCard.test.tsx"` → Expected: the edited tests fail on the old card.

- [ ] **Step 3: Change the card**

In `FactsCard.tsx`:
- Add `import { formatDay } from '@/lib/format/date';` after the `@/lib/products/format` import.
- Add, after `const count = …`: `const MONTHLY_SOLD_NOTE = "Amazon's 'bought in past month' badge";`
- Delete the lines `const priceAvgs = [...]` and `const rankAvgs = [...]`.
- Replace the Listed since / Tracking since / Price / BSR / Reviews / Monthly sold / Status facts with:

```tsx
          <Fact label="Listed since">
            {facts.listedSince ? `${formatDay(facts.listedSince)} · ${listingAge(facts.listedSince, now)}` : DASH}
          </Fact>
          <Fact label="Tracking since">{facts.trackingSince ? formatDay(facts.trackingSince) : DASH}</Fact>
          <Fact label="Price">{formatPriceCents(facts.currentPriceCents)}</Fact>
          <Fact label="BSR">
            {rank(facts.salesRank)}
            {finite(facts.rankRatioX100) && <RatioChip ratioX100={facts.rankRatioX100} />}
          </Fact>
          <Fact label="Reviews">{reviews.length > 0 ? reviews.join(' · ') : DASH}</Fact>
          <Fact label="Monthly sold" sub={MONTHLY_SOLD_NOTE}>
            {formatBadge(facts.monthlySold)}
          </Fact>
```

  (Offers and Amazon stay as they are, then:)

```tsx
          <Fact label="Status">{facts.enrichmentStatus ? <StatusBadge status={facts.enrichmentStatus} /> : DASH}</Fact>
        </dl>
      </div>
      {facts.lastFetchedAt && (
        <p className="mt-3 text-right text-xs text-gray-500">Data last fetched {formatDay(facts.lastFetchedAt)}</p>
      )}
    </section>
```

- Delete the `fetchedLine` function and its doc comment.
- Rewrite the file's header comment: the card shows one value per fact (the history lives in the charts), dates read "Mon D, YYYY", and a "Data last fetched" stamp closes the card; keep the sentences about the loader's hiding rules and the three shapes.

- [ ] **Step 4: Run the tests** → `pnpm exec vitest run "app/(app)/products/[asin]/FactsCard.test.tsx"` → Expected: all pass.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec eslint "app/(app)/products/[asin]/FactsCard.tsx" "app/(app)/products/[asin]/FactsCard.test.tsx"
git add "app/(app)/products/[asin]/FactsCard.tsx" "app/(app)/products/[asin]/FactsCard.test.tsx"
git commit -F - <<'EOF'
feat(products): facts card shows one value per fact, "Mon D, YYYY" dates and a "Data last fetched" stamp

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 3: Dates in the history charts, the keyword-streak tooltip and the keyword page's "Latest" chip

**Files:**
- Modify: `app/(app)/products/[asin]/HistoryCharts.tsx` (`historySummary`, the local `formatFetchTime`), `app/(app)/products/[asin]/ProductKeywordsTable.tsx` (line 74), `app/(app)/explorer/keyword/[id]/page.tsx` (line 149)
- Test: `app/(app)/products/[asin]/HistoryCharts.test.tsx`, `app/(app)/products/[asin]/ProductKeywordsTable.test.tsx`, `app/(app)/explorer/keyword/[id]/page.test.tsx` (only if it renders the header chip)

- [ ] **Step 1: Update / add the tests (they fail first)**

`HistoryCharts.test.tsx`: `'3 snapshots, 2026-09-20 to 2026-10-04'` → `'3 snapshots, Sep 20, 2026 to Oct 4, 2026'`; `'3 snapshots, 2026-09-20 to 2026-10-04 (the newest 3; older ones are not shown)'` → `'3 snapshots, Sep 20, 2026 to Oct 4, 2026 (the newest 3; older ones are not shown)'`; `'1 snapshot, 2026-10-04'` → `'1 snapshot, Oct 4, 2026'`.

`ProductKeywordsTable.test.tsx`, inside the first test (`renders each keyword row …`), add:

```tsx
    expect(screen.getByTitle("In this keyword's top 3 since the week ending Jul 18, 2026")).toBeInTheDocument();
```

`app/(app)/explorer/keyword/[id]/page.test.tsx`: if it renders the header (look for the `Latest` chip or `currentWeekEndDate` in its fixture), add an assertion that the chip reads the fixture week as `Mon D, YYYY` (e.g. `expect(screen.getByText('Oct 17, 2026')).toBeInTheDocument()` for a `'2026-10-17'` fixture); if it does not render the header, leave it.

- [ ] **Step 2: Run them to verify they fail** → `pnpm exec vitest run "app/(app)/products/[asin]/HistoryCharts.test.tsx" "app/(app)/products/[asin]/ProductKeywordsTable.test.tsx"` → Expected: the edited expectations fail.

- [ ] **Step 3: Make the changes**

`HistoryCharts.tsx`: add `import { formatDay, formatFetchTime } from '@/lib/format/date';`; in `historySummary` use `const first = formatDay(rows[0].at); const last = formatDay(rows[n - 1].at);` and update its doc comment to `"37 snapshots, Aug 1, 2026 to Oct 8, 2026", "1 snapshot, Oct 4, 2026", plus a note when the cap was hit.`; delete the local `formatFetchTime` function and its `/** ISO timestamp → "2026-10-04 06:00 UTC". */` comment (the import replaces it; the chart's own `MONTHS` for axis ticks stays).

`ProductKeywordsTable.tsx`: add `import { formatDay } from '@/lib/format/date';`; line 74 → `title={`In this keyword's top 3 since the week ending ${formatDay(r.streakStartedWeek)}`}`.

`app/(app)/explorer/keyword/[id]/page.tsx`: add `import { formatDay } from '@/lib/format/date';`; line 149 → `<span className="font-mono font-semibold text-white">{formatDay(current.currentWeekEndDate)}</span>`.

- [ ] **Step 4: Run the tests** → the Step 2 command plus `"app/(app)/explorer/keyword/[id]"` → Expected: all pass.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec eslint "app/(app)/products/[asin]/HistoryCharts.tsx" "app/(app)/products/[asin]/HistoryCharts.test.tsx" "app/(app)/products/[asin]/ProductKeywordsTable.tsx" "app/(app)/products/[asin]/ProductKeywordsTable.test.tsx" "app/(app)/explorer/keyword/[id]/page.tsx"
git add "app/(app)/products/[asin]/HistoryCharts.tsx" "app/(app)/products/[asin]/HistoryCharts.test.tsx" "app/(app)/products/[asin]/ProductKeywordsTable.tsx" "app/(app)/products/[asin]/ProductKeywordsTable.test.tsx" "app/(app)/explorer/keyword/[id]/page.tsx"
# add "app/(app)/explorer/keyword/[id]/page.test.tsx" if it was edited
git commit -F - <<'EOF'
feat(dates): history caption/tooltip, streak tooltip and the keyword page's Latest chip read "Mon D, YYYY"

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 4: Keyword page — Monthly sold and BSR columns instead of Leaf category

**Files:**
- Modify: `app/(app)/explorer/keyword/[id]/TopProductsSection.tsx` (`TopProductsTable`: header, row cells, the `Product` cell width, two helpers)
- Test: `app/(app)/explorer/keyword/[id]/TopProductsSection.test.tsx`

Context: `EnrichedProduct` (lib/explorer/fetchKeywordDetail.ts) carries `salesRank: number | null` and `monthlySold?: number | null` (optional), both null for a delisted product by the reader's rule; `formatBadge` from `@/lib/products/format` renders `1000` as `"1,000+"` and null as `"—"`. The test file's `enriched()` fixture builds an `EnrichedProduct`; `mockProducts()` mocks the reader; `renderSection(linkProducts)` renders the section; `screen` and `render` are imported from Testing Library (add `within`).

- [ ] **Step 1: Write the failing tests**

Append to `TopProductsSection.test.tsx`:

```tsx
describe('TopProductsSection columns (spec 2026-10-21 round 1 §4)', () => {
  beforeEach(() => fetchKeywordProducts.mockReset());

  function cellsOf(title: string): string[] {
    const row = screen.getByText(title).closest('tr');
    if (!row) throw new Error(`no row for ${title}`);
    return within(row).getAllByRole('cell').map((c) => c.textContent ?? '');
  }

  it('shows Monthly sold and BSR after Reviews, and no Leaf category column', async () => {
    mockProducts({
      enrichedProductsByAsin: {
        B000000001: enriched('B000000001', { title: TITLES[0].title, monthlySold: 1000, salesRank: 1234, categoryLeaf: 'Desk Lamps' }),
        B000000002: enriched('B000000002', { title: TITLES[1].title, monthlySold: null, salesRank: null }),
      },
    });
    await renderSection(false);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      '#', 'Product', 'Click %', 'Conv %', 'Price', 'Reviews', 'Monthly sold', 'BSR',
    ]);
    expect(cellsOf(TITLES[0].title).slice(6)).toEqual(['1,000+', '#1,234']);
    expect(cellsOf(TITLES[1].title).slice(6)).toEqual(['—', '—']);
    expect(screen.queryByText('Desk Lamps')).toBeNull();
  });

  it('a product with no catalog row reads dashes in both new columns', async () => {
    mockProducts();
    await renderSection(false);
    expect(cellsOf(TITLES[2].title).slice(6)).toEqual(['—', '—']);
  });

  it('the two headers explain their numbers on hover', async () => {
    mockProducts();
    await renderSection(false);
    expect(screen.getByRole('columnheader', { name: 'Monthly sold' })).toHaveAttribute('title', 'Amazon’s “bought in past month” badge');
    expect(screen.getByRole('columnheader', { name: 'BSR' })).toHaveAttribute('title', 'Best Sellers Rank in the main category');
  });
});
```

Add `within` to the Testing Library import: `import { render, screen, within } from '@testing-library/react';`.

- [ ] **Step 2: Run to verify they fail** → `pnpm exec vitest run "app/(app)/explorer/keyword/[id]/TopProductsSection.test.tsx"` → Expected: the three new tests fail (old headers, no such cells).

- [ ] **Step 3: Change the table**

In `TopProductsSection.tsx`:
- Add `import { formatBadge } from '@/lib/products/format';` next to the `@/lib/products/asin` import.
- Header: replace `<th className="p-2">Leaf category</th>` with

```tsx
            <th className="p-2 text-right" title="Amazon’s “bought in past month” badge">Monthly sold</th>
            <th className="p-2 text-right" title="Best Sellers Rank in the main category">BSR</th>
```

- Product cell: `<td className="p-2 max-w-md">` → `<td className="p-2 max-w-xs">` (the truncate wrapper and hover title stay).
- Row: replace the leaf cell (`<td className="p-2 text-xs text-gray-700">{enriched?.categoryLeaf ?? enriched?.categoryPath ?? …}</td>`) with

```tsx
                <td className="p-2 text-right tabular-nums whitespace-nowrap">{formatSold(enriched?.monthlySold)}</td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap">{formatRank(enriched?.salesRank)}</td>
```

- Helpers, next to `formatPrice`:

```tsx
/** Amazon's "bought in past month" floor, "1,000+"; a grey dash when the catalog has none. */
function formatSold(n: number | null | undefined): React.ReactNode {
  if (n === null || n === undefined || !Number.isFinite(n)) return <span className="text-gray-400">—</span>;
  return formatBadge(n);
}

/** Best Sellers Rank, "#1,234"; a grey dash when unknown (a delisted product reads null). */
function formatRank(n: number | null | undefined): React.ReactNode {
  if (n === null || n === undefined || !Number.isFinite(n)) return <span className="text-gray-400">—</span>;
  return `#${n.toLocaleString('en-US')}`;
}
```

- Update the `TopProductsTable` doc comment (the "Compact table replacing the old image-heavy ProductCard layout" paragraph) to list the eight columns and say the leaf category moved to the product page.

- [ ] **Step 4: Run the tests** → the Step 2 command → Expected: the whole file passes (the title-link tests included).

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec eslint "app/(app)/explorer/keyword/[id]/TopProductsSection.tsx" "app/(app)/explorer/keyword/[id]/TopProductsSection.test.tsx"
git add "app/(app)/explorer/keyword/[id]/TopProductsSection.tsx" "app/(app)/explorer/keyword/[id]/TopProductsSection.test.tsx"
git commit -F - <<'EOF'
feat(keyword): top clicked products show Monthly sold and BSR instead of Leaf category

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 5: Final review, gate, docs (controller)

- [ ] Dispatch the final whole-diff code review (spec compliance + quality) over Tasks 1–4; nits back to the implementers.
- [ ] Gate: `pnpm exec vitest run` (all green), `pnpm typecheck` (0), `pnpm build` ("Compiled successfully"), `pnpm exec eslint` on every touched file.
- [ ] Fill the Results table below; commit the docs.

### Task 6: Ship (owner-gated)

- [ ] `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` → no live runs; the clock is outside 03:30–06:59 ET.
- [ ] On the owner's go: `git push origin main` (bare, its own call); watch `gh api repos/raw5045/AmazonAnalytics/commits/<sha>/status --jq '"overall: \(.state)", (.statuses[] | "\(.context): \(.state) @ \(.updated_at)")'` → Vercel success.
- [ ] Chrome smoke: a product page (Listed since "Mon D, YYYY", Price without the averages line, BSR with the chip only, Reviews without "rating updated", Monthly sold with the badge note, Status badge only, the bottom-right "Data last fetched Mon D, YYYY", the history caption in the new format, a chart tooltip "Mon D, YYYY HH:MM UTC"); a keyword page ("Latest Mon D, YYYY", eight columns, a Monthly sold "1,000+" and a BSR "#…" value, a dash on a product without them).

## Results

| Step | Result |
|---|---|
| Task 1 | |
| Task 2 | |
| Task 3 | |
| Task 4 | |
| Final review + gate | |
| Push / deploys | |
| Smoke | |

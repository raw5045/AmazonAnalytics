# Listing Age Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The keyword page's top-clicked products show "listed 245 days ago" / "listed 1 year, 245 days ago" after the ASIN, and every listing age in the app uses that calendar rule (spec `docs/superpowers/specs/2026-10-23-listing-age-design.md`).

**Architecture:** One pure helper change (`listingAge`) plus one presentational change in the keyword table with a `now` prop for testability. No query, type or MCP change.

**Tech Stack:** TypeScript, React 19 server components, vitest + Testing Library.

**Conventions:** TDD; `git add` named files; trailer exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; local commits on main, push owner-gated; EOL-preserving edits; lint touched files with `pnpm exec eslint`.

---

### Task 1: The calendar age rule

**Files:** modify `lib/products/format.ts` (`listingAge`), `lib/products/format.test.ts`.

- [ ] **Step 1: Update the tests first.** In the `listingAge` describe (NOW is 2026-10-09): `['2025-09-04', '1 year, 35 days']`, `['2025-10-09', '1 year']`, `['2024-10-09', '2 years']`, and add `['2018-03-19', '8 years, 204 days']`, `['2025-10-08', '1 year, 1 day']`, `['2024-02-29', '2 years, 222 days']`. Keep the day, future, null, invalid, UTC-boundary and invalid-now cases.
- [ ] **Step 2:** `pnpm exec vitest run lib/products/format.test.ts` → the changed cases fail.
- [ ] **Step 3: Implement** in `lib/products/format.ts`:

```ts
export function listingAge(date: string | null, now: Date): string {
  const m = date === null ? null : /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return DASH;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const listed = Date.UTC(y, mo, d);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!Number.isFinite(listed) || !Number.isFinite(today)) return DASH;
  if (today <= listed) return '0 days';
  // Whole calendar years since the listing date, then the days since that anniversary.
  let years = now.getUTCFullYear() - y;
  let anniversary = Date.UTC(y + years, mo, d);
  if (anniversary > today) {
    years -= 1;
    anniversary = Date.UTC(y + years, mo, d);
  }
  const days = Math.round((today - anniversary) / DAY_MS);
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (years <= 0) return unit(days, 'day');
  return days === 0 ? unit(years, 'year') : `${unit(years, 'year')}, ${unit(days, 'day')}`;
}
```

  and update its doc comment ("245 days" under a year; "1 year, 245 days" from a year on, calendar years then days since the anniversary; "2 years" on the anniversary; never negative).
- [ ] **Step 4:** the test file passes; also `pnpm exec vitest run "app/(app)/products"` stays green (fixtures under a year).
- [ ] **Step 5:** `pnpm exec eslint lib/products/format.ts lib/products/format.test.ts`; commit `feat(products): listing age reads calendar years and days`.

### Task 2: The keyword page's age line

**Files:** modify `app/(app)/explorer/keyword/[id]/TopProductsSection.tsx`, `app/(app)/explorer/keyword/[id]/TopProductsSection.test.tsx`.

- [ ] **Step 1: Failing tests.** In the columns describe, add:

```tsx
  it('shows the listing age after the ASIN, with the exact date on hover; none without a listing date', async () => {
    mockProducts({
      enrichedProductsByAsin: {
        B000000001: enriched('B000000001', { title: TITLES[0].title, listedSince: '2026-02-06' }),
        B000000002: enriched('B000000002', { title: TITLES[1].title, listedSince: null }),
      },
    });
    render(await TopProductsSection({ id: KW, currentWeekEndDate: WEEK, linkProducts: false, now: new Date('2026-10-09T12:00:00Z') }));
    const age = screen.getByText('· listed 245 days ago');
    expect(age).toHaveAttribute('title', 'Listed on Amazon Feb 6, 2026');
    expect(age.closest('tr')).toBe(screen.getByText(TITLES[0].title).closest('tr'));
    expect(screen.getAllByText(/listed .* ago/)).toHaveLength(1);
  });
```

- [ ] **Step 2:** run the file → the new test fails (no age span, `now` prop unknown).
- [ ] **Step 3: Implement.** `TopProductsSection` gains `now = new Date()` in its props (`now?: Date`) and passes `now={now}` to `TopProductsTable`, which takes `now: Date`. Imports: `listingAge` from `@/lib/products/format`, `formatDay` from `@/lib/format/date`. The product cell's second line becomes:

```tsx
                  <div className="text-xs text-gray-500">
                    <a
                      href={`https://www.amazon.com/dp/${s.asin}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono hover:underline"
                    >
                      {s.asin}
                    </a>
                    {enriched?.listedSince && (
                      <span title={`Listed on Amazon ${formatDay(enriched.listedSince)}`}>
                        {' '}· listed {listingAge(enriched.listedSince, now)} ago
                      </span>
                    )}
                  </div>
```

  (the `font-mono` moves from the div to the ASIN link so the age reads in the normal font). Update the table's doc comment (the product cell: title, ASIN, listing age).
- [ ] **Step 4:** the whole test file passes (the title-link tests included).
- [ ] **Step 5:** lint both files; commit `feat(keyword): top clicked products show the listing age after the ASIN`.

### Task 3: Review, gate, ship

- [ ] Read-only review of both commits (spec compliance + quality).
- [ ] Gate: `pnpm exec vitest run`, `pnpm typecheck`, `pnpm build`, eslint on touched files.
- [ ] Owner-gated push (checkActiveJobs first) → Vercel → Chrome smoke: a keyword page ("· listed … ago" after an ASIN, hover date) and a product page (facts card "Mon D, YYYY · N years, M days").

## Results

| Step | Result |
|---|---|
| Task 1 | ac09d8e: calendar rule in `listingAge`; 54 formatter tests + the Products pages' 167 green |
| Task 2 | 26458e8: the age line after the ASIN with the hover date, `now` prop; 18 table tests |
| Review + gate | Read-only opus review: both stages pass (an 8M-pair probe against an independent day-count reference found 0 mismatches); nits taken in 17dac43 (real font assertion, order/separator pin, UTC-anniversary / year-crossing / Feb 29 pins, doc comment). Gate at 26458e8: 244 files / 3,036 tests, build compiled, typecheck 0; 17dac43 (tests + a comment) re-ran its two files, 73 green |
| Push / smoke | |

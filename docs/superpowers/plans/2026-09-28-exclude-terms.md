# Exclude Terms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Explorer users and MCP clients exclude keywords that contain given whole words or phrases, applied inside the SQL WHERE so pages, footer totals, CSV exports and saved views all agree.

**Architecture:** A new `qExclude: string[]` filter on `ExplorerFilters` (URL `qx=floor,ceiling fan`) becomes one `NOT (kcs.search_term_normalized ~ '\m…\M')` predicate per term inside `pushKcsPredicates`, which both classic query paths share (rows and the capped count); the 0046 covered path and the precomputed totals treat it as a narrowing filter and stand down, while the avg-count steering deliberately stays on because a NOT offers the planner no alternative index (settled in the Task 2 review). The MCP research contract gains `filters.excludeTerms` (same rule, same `wordPattern` helper) so Claude/ChatGPT can say "lamps but not floor lamps" and still get honest pages and totals. Whole-word only, up to 5 terms of 3+ characters, allowed without an include term. Design settled with the owner in chat on 2026-09-28.

**Tech Stack:** Next.js 16 App Router (client sidebar component), TypeScript, Postgres via `pg` (trigram-indexed `search_term_normalized`), zod 4 (research contract), Vitest 4 + Testing Library.

---

## Design decisions (owner, 2026-09-28)

| Decision | Choice |
|---|---|
| Matching | Whole word only (`\m<term>\M` regex, the include's default helper), regardless of the include's Whole word / Broad toggle. Phrases allowed ("floor lamp"). |
| Several terms | Up to 5, comma-separated in the Explorer, an array in MCP; at least 3 characters each; case-insensitive de-duplication. A keyword is dropped if it contains ANY of them. |
| Without an include | Allowed: a category-only search can still say "nothing with led". |
| Placement | A "But not" input directly under "Search term contains"; the Word count card moves to the bottom of the sidebar. |
| MCP | `filters.excludeTerms` on `search_keywords`, documented in the guide's population rules and the tool description; shipped in the same change so the guide keeps saying the tools follow the Explorer's rules. |
| Performance | A NOT cannot use an index; it is a per-row filter applied after the other predicates and the sort pick their path. Bounded by the term cap; the worst shapes are probed on production (Task 7) before the push. |

## File map

| File | Responsibility in this change |
|---|---|
| `lib/explorer/types.ts` | `qExclude: string[]` on `ExplorerFilters`. |
| `lib/explorer/parseFilters.ts` | `parseExcludeTerms()`, the `qx` URL param, `EXPLORER_DEFAULTS.qExclude`, the caps. |
| `lib/explorer/buildQuery.ts` | The NOT predicates in `pushKcsPredicates`; `categoryPathIsCovered` stands down when terms are set; `countSteersOntoSortIndex` stays on (a NOT offers no alternative index). |
| `lib/explorer/queryTotals.ts` | The three precomputed-total guards treat terms as narrowing. |
| `lib/savedViews/validation.ts` | Blob normalisation and `filtersToSearchParams` (also feeds the CSV export via `lib/explorer/export/query.ts`). |
| `app/(app)/explorer/FilterSidebar.tsx` | The "But not" input, pending-state round trip, the Word count move. |
| `lib/research/contracts.ts`, `lib/research/query.ts`, `lib/research/catalog.ts`, `lib/mcp/tools/registerResearchTools.ts` | `excludeTerms` on the research filters, its predicate, the guide rule, the tool description. |

## Conventions (same as arc 1)

- TDD: write the failing test, run it, implement, run it green, commit. Every commit message ends with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (exactly; verify with `git log -1 --format='%(trailers)'`).
- Local commits only. Pushes are owner-gated: `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` first, then `git push origin main` only when the owner says so in chat.
- No DDL. Nothing in this plan touches the database schema.
- `git add` only the named files; untracked throwaway scripts stay untracked.
- Read `node_modules/next/dist/docs/` before touching route or page code (Task 5 touches a client component only; no routes change).
- Regex patterns in TypeScript string literals need doubled backslashes: `'\\mfloor\\M'` is the JS source for the SQL pattern `\mfloor\M`.

---

### Task 1: Parse the `qx` URL parameter into `qExclude`

**Files:**
- Modify: `lib/explorer/types.ts` (the `ExplorerFilters` interface, after `qMode`)
- Modify: `lib/explorer/parseFilters.ts` (`EXPLORER_DEFAULTS`, new constants + `parseExcludeTerms`, the return object of `parseExplorerFilters`)
- Test: `lib/explorer/parseFilters.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/explorer/parseFilters.test.ts` (the file already imports `parseExplorerFilters` and `EXPLORER_DEFAULTS`; add `parseExcludeTerms` to that import):

```ts
describe('exclude terms (qx)', () => {
  it('defaults to an empty list', () => {
    expect(EXPLORER_DEFAULTS.qExclude).toEqual([]);
    expect(parseExplorerFilters({}).qExclude).toEqual([]);
  });

  it('splits on commas, trims, collapses inner whitespace, drops short chunks, de-duplicates case-insensitively, caps at 5', () => {
    expect(parseExcludeTerms(' floor , ceiling   fan, ab, FLOOR ,,')).toEqual(['floor', 'ceiling fan']);
    expect(parseExcludeTerms(['floor', 'led,bulb'])).toEqual(['floor', 'led', 'bulb']);
    expect(parseExcludeTerms('one1,two2,three3,four4,five5,six6')).toEqual(['one1', 'two2', 'three3', 'four4', 'five5']);
    expect(parseExcludeTerms('x'.repeat(201))).toEqual([]);
    expect(parseExcludeTerms(undefined)).toEqual([]);
  });

  it('reads qx from the URL and keeps the include term independent', () => {
    const f = parseExplorerFilters({ q: 'lamp', qx: 'floor,ceiling fan' });
    expect(f.q).toBe('lamp');
    expect(f.qExclude).toEqual(['floor', 'ceiling fan']);
    expect(parseExplorerFilters({ qx: 'led' }).q).toBeNull();
    expect(parseExplorerFilters({ qx: 'led' }).qExclude).toEqual(['led']);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run lib/explorer/parseFilters.test.ts`
Expected: FAIL — `parseExcludeTerms` is not exported and `qExclude` is undefined.

- [ ] **Step 3: Add the field and the parser**

In `lib/explorer/types.ts`, inside `ExplorerFilters` right after `qMode`:

```ts
  /**
   * Whole words or phrases a keyword must NOT contain (URL `qx`, comma-separated).
   * Each becomes `NOT (search_term_normalized ~ '\m<term>\M')`, so a keyword is
   * dropped if it contains ANY of them. Independent of `q`/`qMode`: works with or
   * without an include term and always matches whole words. Empty array = none.
   * Up to MAX_EXCLUDE_TERMS terms of MIN_EXCLUDE_TERM_LENGTH+ characters.
   */
  qExclude: string[];
```

In `lib/explorer/parseFilters.ts`: add `qExclude: []` to `EXPLORER_DEFAULTS` right after `qMode: 'word',`; add the constants next to `MAX_LEAF_PATHS`; add the parser next to `parseLeafPaths`; and add `qExclude: parseExcludeTerms(searchParams.qx),` to the object returned by `parseExplorerFilters`, right after `qMode,`.

```ts
export const MAX_EXCLUDE_TERMS = 5;
export const MIN_EXCLUDE_TERM_LENGTH = 3;
export const MAX_EXCLUDE_TERM_LENGTH = 200;

/**
 * Comma-separated exclude terms (`qx`) → up to MAX_EXCLUDE_TERMS distinct
 * whole-word terms/phrases. Chunks are trimmed and inner whitespace collapsed;
 * chunks shorter than MIN_EXCLUDE_TERM_LENGTH or longer than
 * MAX_EXCLUDE_TERM_LENGTH are ignored (never truncated); duplicates are dropped
 * case-insensitively, keeping the first spelling (wordPattern lowercases anyway).
 * Accepts a repeated param (string[]) as well as one comma-joined value.
 */
export function parseExcludeTerms(value: string | string[] | undefined): string[] {
  const chunks = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    for (const part of chunk.split(',')) {
      const term = part.trim().replace(/\s+/g, ' ');
      if (term.length < MIN_EXCLUDE_TERM_LENGTH || term.length > MAX_EXCLUDE_TERM_LENGTH) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(term);
      if (out.length === MAX_EXCLUDE_TERMS) return out;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run lib/explorer/parseFilters.test.ts && pnpm typecheck`
Expected: the new tests PASS. The typecheck will now FAIL wherever an `ExplorerFilters` literal is built without `qExclude` (at least `normalizeFiltersBlob` in `lib/savedViews/validation.ts`, possibly test fixtures). Fix each by adding `qExclude: []` for now (Task 4 replaces the saved-view one with the real mapping). Re-run until `pnpm typecheck` is clean and `pnpm vitest run` is green.

- [ ] **Step 5: Commit**

```bash
git add lib/explorer/types.ts lib/explorer/parseFilters.ts lib/explorer/parseFilters.test.ts lib/savedViews/validation.ts
git commit -m "feat(explorer): parse qx exclude terms into ExplorerFilters.qExclude

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
(Add any other file you had to touch for the typecheck to the `git add` line.)

---

### Task 2: The NOT predicates in the query builder

**Files:**
- Modify: `lib/explorer/buildQuery.ts` (`categoryPathIsCovered`, `countSteersOntoSortIndex`, `pushKcsPredicates`)
- Test: `lib/explorer/buildQuery.test.ts`

Background: `pushKcsPredicates` builds the WHERE for the legacy path (q null) and the q path; both paths snapshot `countArgs` after it, so a predicate that binds its args there is present in rows AND count with the prefix invariant intact. The covered (0046) path builds its own WHERE from the covering index and cannot evaluate text predicates, so it must stand down.

> **Amended after the Task 2 review (landed as b99ba2a):** `countSteersOntoSortIndex` does NOT stand down for exclude terms. Every other narrowing filter has its own index the steering ORDER BY could displace, but a NOT offers the planner no alternative, so the steered avg-index walk with a per-row NOT filter is strictly better than the seq scan it would otherwise fall back to. Step 3 item 2 below is therefore not applied, and the steering test asserts the opposite (steering stays on; a `reviewsMax` still turns it off). HEAD is authoritative over the snippets.

- [ ] **Step 1: Write the failing tests**

Append to `lib/explorer/buildQuery.test.ts` (the file already imports `buildExplorerQuery` and `categoryPathIsCovered` and defines `baseFilters` and `norm`; add `countSteersOntoSortIndex` to the import from `./buildQuery`):

```ts
describe('exclude terms (qExclude)', () => {
  const NOT_PREDICATE = /NOT \(kcs\.search_term_normalized ~ \$\d+\)/g;

  it('legacy path: one whole-word NOT predicate per term, in rows AND count, binding shared args', () => {
    const { sql, countSql, args, countArgs } = buildExplorerQuery({ ...baseFilters, qExclude: ['floor', 'ceiling fan'] });
    expect(norm(sql).match(NOT_PREDICATE)).toHaveLength(2);
    expect(norm(countSql).match(NOT_PREDICATE)).toHaveLength(2);
    expect(args).toContain('\\mfloor\\M');
    expect(args).toContain('\\mceiling fan\\M');
    expect(countArgs).toEqual(args.slice(0, countArgs.length));
  });

  it('q path: the excludes sit next to the include match and the count comes from the rows window', () => {
    const r = buildExplorerQuery({ ...baseFilters, q: 'lamp', qExclude: ['floor'] });
    expect(norm(r.sql)).toContain('kcs.search_term_normalized ~ $');
    expect(norm(r.sql).match(NOT_PREDICATE)).toHaveLength(1);
    expect(r.args).toContain('\\mlamp\\M');
    expect(r.args).toContain('\\mfloor\\M');
    expect(r.countFromRows).toBe(true);
  });

  it('stays whole-word even when the include is broad', () => {
    const { args } = buildExplorerQuery({ ...baseFilters, q: 'lamp', qMode: 'broad', qExclude: ['floor'] });
    expect(args).toContain('%lamp%');
    expect(args).toContain('\\mfloor\\M');
    expect(args).not.toContain('%floor%');
  });

  it('takes the covered category path out of play (the covering index cannot evaluate text)', () => {
    const scoped = { ...baseFilters, leafPaths: ['Tools › Lighting › Lamps'], sort: 'rank' as const };
    expect(categoryPathIsCovered(scoped)).toBe(true);
    expect(categoryPathIsCovered({ ...scoped, qExclude: ['floor'] })).toBe(false);
    const { sql } = buildExplorerQuery({ ...scoped, qExclude: ['floor'] });
    expect(norm(sql).match(NOT_PREDICATE)).toHaveLength(1);
  });

  it('switches off the avg-sort count steering, like every other narrowing filter', () => {
    expect(countSteersOntoSortIndex({ ...baseFilters, sort: 'avg_price_desc' })).toBe(true);
    expect(countSteersOntoSortIndex({ ...baseFilters, sort: 'avg_price_desc', qExclude: ['floor'] })).toBe(false);
    const { countSql } = buildExplorerQuery({ ...baseFilters, sort: 'avg_price_desc', qExclude: ['floor'] });
    expect(norm(countSql)).not.toContain('ORDER BY');
  });

  it('binds nothing when the list is empty (existing shapes are byte-for-byte unchanged)', () => {
    const before = buildExplorerQuery(baseFilters);
    const after = buildExplorerQuery({ ...baseFilters, qExclude: [] });
    expect(after.sql).toBe(before.sql);
    expect(after.countSql).toBe(before.countSql);
    expect(after.args).toEqual(before.args);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run lib/explorer/buildQuery.test.ts`
Expected: FAIL — no NOT predicates are emitted, the covered path still claims the scoped shape, steering stays on.

- [ ] **Step 3: Implement**

In `lib/explorer/buildQuery.ts`:

1. In `categoryPathIsCovered`, add one condition after `&& filters.q === null`:

```ts
    && filters.qExclude.length === 0
```

2. In `countSteersOntoSortIndex`, add one condition after `f.q === null &&`:

```ts
    f.qExclude.length === 0 &&
```

3. In `pushKcsPredicates`, right after the `if (filters.category) { … }` block and before `const leafPath = leafPathPredicate(filters, next);`:

```ts
  // Exclude terms (owner decision 2026-09-28): one whole-word NOT per term, so a
  // keyword is dropped if it contains ANY of them. Always whole-word regardless
  // of qMode (the include's Broad toggle does not apply). Pushed here so both
  // classic paths carry it in rows AND the capped count; a NOT cannot use the
  // trigram index, it is a per-row filter after the other predicates. The
  // covered path stands down (categoryPathIsCovered) and so does the avg-count
  // steering (countSteersOntoSortIndex) — a narrowing filter like any other.
  for (const term of filters.qExclude) {
    where.push(`NOT (kcs.search_term_normalized ~ ${next(wordPattern(term))})`);
  }
```

`wordPattern` is already imported in this file.

- [ ] **Step 4: Run the tests, the typecheck and the lint**

Run: `pnpm vitest run lib/explorer/buildQuery.test.ts && pnpm typecheck && pnpm eslint lib/explorer/buildQuery.ts lib/explorer/buildQuery.test.ts`
Expected: all new tests PASS, the older `countSql vs sql` and null-key tests still PASS, typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add lib/explorer/buildQuery.ts lib/explorer/buildQuery.test.ts
git commit -m "feat(explorer): exclude terms become whole-word NOT predicates on both classic query paths

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Precomputed totals stand down when terms are set

**Files:**
- Modify: `lib/explorer/queryTotals.ts` (`canUseDefaultTotal`, `canUseCategoryFacet`, `canUseLeafCategoryFacet`)
- Test: `lib/explorer/queryTotals.test.ts`

Background: the meta and facet totals were computed without the exclusion, so any of the three shortcuts would overcount once terms are set. The guards already list every narrowing filter by hand (`f.q === null && …`); the exclude joins that list.

- [ ] **Step 1: Write the failing tests**

Append to `lib/explorer/queryTotals.test.ts` (it already imports the three guards and `EXPLORER_DEFAULTS`; mirror the file's existing style for building filters):

```ts
describe('exclude terms bypass every precomputed total', () => {
  it('default landing', () => {
    expect(canUseDefaultTotal({ ...EXPLORER_DEFAULTS, qExclude: [] })).toBe(true);
    expect(canUseDefaultTotal({ ...EXPLORER_DEFAULTS, qExclude: ['floor'] })).toBe(false);
  });
  it('broad-category facet', () => {
    expect(canUseCategoryFacet({ ...EXPLORER_DEFAULTS, category: 'Beauty' })).toBe(true);
    expect(canUseCategoryFacet({ ...EXPLORER_DEFAULTS, category: 'Beauty', qExclude: ['floor'] })).toBe(false);
  });
  it('single leaf facet', () => {
    expect(canUseLeafCategoryFacet({ ...EXPLORER_DEFAULTS, leafPaths: ['A › B'] })).toBe(true);
    expect(canUseLeafCategoryFacet({ ...EXPLORER_DEFAULTS, leafPaths: ['A › B'], qExclude: ['floor'] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run lib/explorer/queryTotals.test.ts`
Expected: the three `toBe(false)` assertions FAIL (guards still return true).

- [ ] **Step 3: Implement**

In each of the three guards in `lib/explorer/queryTotals.ts`, add one line directly after `&& f.q === null`:

```ts
    && f.qExclude.length === 0
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run lib/explorer && pnpm typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add lib/explorer/queryTotals.ts lib/explorer/queryTotals.test.ts
git commit -m "feat(explorer): precomputed totals stand down when exclude terms are set

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

> **Follow-up from the Task 3 review (landed as b903ee1):** a guard-drift test in `lib/explorer/queryTotals.test.ts` perturbs every `ExplorerFilters` field from the defaults and asserts `canUseDefaultTotal(f)` is false exactly when the perturbation changes the count SQL, so a future predicate cannot be added to `pushKcsPredicates` without its guard line. The same commit fixed two stale steering comments in `buildQuery.ts` and gave `lib/savedViews/validation.ts` an `excludeTermsInput()` helper shared by both directions (Task 4 review nits).

---

### Task 4: Saved views and the CSV export carry the terms

**Files:**
- Modify: `lib/savedViews/validation.ts` (`normalizeFiltersBlob`, `filtersToSearchParams`)
- Test: `lib/savedViews/validation.test.ts`, `lib/explorer/export/query.test.ts`

Background: a saved view stores the whole `ExplorerFilters` object as a JSON blob and is rehydrated by `normalizeFiltersBlob`; `filtersToSearchParams` turns filters back into the URL shape (the sidebar's reverse) and is what `filtersToQueryString` in `lib/explorer/export/query.ts` uses for the CSV export link. Views saved before this change have no `qExclude` and must load as "no exclusions".

- [ ] **Step 1: Write the failing tests**

Append to `lib/savedViews/validation.test.ts` (it already imports `normalizeFiltersBlob` and `filtersToSearchParams`):

```ts
describe('exclude terms in saved views', () => {
  it('rehydrates a stored list through the same parser as the URL (trim, min length, cap)', () => {
    expect(normalizeFiltersBlob({ qExclude: [' floor ', 'ab', 'ceiling fan'] }).qExclude).toEqual(['floor', 'ceiling fan']);
    expect(normalizeFiltersBlob({ qExclude: 'floor,led' }).qExclude).toEqual(['floor', 'led']);
  });
  it('treats a pre-existing view without the field as no exclusions', () => {
    expect(normalizeFiltersBlob({ q: 'lamp' }).qExclude).toEqual([]);
    expect(normalizeFiltersBlob({ qExclude: 42 }).qExclude).toEqual([]);
  });
  it('serialises the terms as one comma-joined qx param, and omits it when empty', () => {
    expect(filtersToSearchParams({ qExclude: ['floor', 'ceiling fan'] }).qx).toBe('floor,ceiling fan');
    expect(filtersToSearchParams({ qExclude: [] }).qx).toBeUndefined();
    expect(filtersToSearchParams({ q: 'lamp' }).qx).toBeUndefined();
  });
});
```

Append to `lib/explorer/export/query.test.ts` (it imports `filtersToQueryString`; import `EXPLORER_DEFAULTS` from `@/lib/explorer/parseFilters` if it does not already):

```ts
it('carries the exclude terms into the export query string', () => {
  const qs = new URLSearchParams(filtersToQueryString({ ...EXPLORER_DEFAULTS, q: 'lamp', qExclude: ['floor', 'ceiling fan'] }));
  expect(qs.get('q')).toBe('lamp');
  expect(qs.get('qx')).toBe('floor,ceiling fan');
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run lib/savedViews/validation.test.ts lib/explorer/export/query.test.ts`
Expected: FAIL — `qExclude` is `[]` regardless of the blob (Task 1's placeholder) and `qx` is never emitted.

- [ ] **Step 3: Implement**

In `lib/savedViews/validation.ts`, import `parseExcludeTerms` from `@/lib/explorer/parseFilters` (the file already imports `parseExplorerFilters` from there). In `normalizeFiltersBlob`, replace the placeholder `qExclude: []` from Task 1 with:

```ts
    // Stored as an array; run it through the URL parser so a hand-edited or
    // pre-cap blob still obeys the same trim / min-length / cap rules.
    qExclude: parseExcludeTerms(
      Array.isArray(f.qExclude)
        ? (f.qExclude as unknown[]).filter((t): t is string => typeof t === 'string')
        : typeof f.qExclude === 'string'
          ? f.qExclude
          : undefined,
    ),
```

In `filtersToSearchParams`, after the `if (f.qMode === 'broad') p.qmode = 'broad';` line:

```ts
  if (Array.isArray(f.qExclude) && f.qExclude.length > 0) p.qx = (f.qExclude as string[]).join(',');
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run lib/savedViews lib/explorer/export && pnpm typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add lib/savedViews/validation.ts lib/savedViews/validation.test.ts lib/explorer/export/query.test.ts
git commit -m "feat(explorer): saved views and the CSV export carry the exclude terms

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The "But not" input, and the Word count card moves to the bottom

**Files:**
- Modify: `app/(app)/explorer/FilterSidebar.tsx` (`PendingFilters`, `filtersToPending`, `pendingToParams`, the "Search term contains" `FieldGroup`, the "Word count" `FieldGroup`)
- Modify: `app/(app)/explorer/page.tsx` — `filtersAreCustomized` gains `f.qExclude.length > 0 ||` after its `f.q !== null ||` line (found in the Task 3 review: the Reset links must show for a qx-only URL; landed with Task 5 as 28f11b9)

> **Amended after the Task 5 review (landed as 07ed5f3):** the input is named by its visible "But not" label (no `aria-label`, which would have made assistive tech announce a different name), with `id="exclude-terms"` and `aria-describedby` pointing at whichever hint renders; the hint copy interpolates `MIN_EXCLUDE_TERM_LENGTH` / `MAX_EXCLUDE_TERMS` and says "Terms", not "Chunks"; a third hint warns when more than five terms are typed ("Only the first 5 terms are used."); and the sidebar's dirty signature normalises `q` (trimmed) and `qExclude` (parsed and re-joined) so an applied draft reads as "Filters applied". The test queries the textbox by the name "But not" and covers overflow, Reset and the applied state. HEAD is authoritative over the snippets below.
- Test: `app/(app)/explorer/FilterSidebar.test.tsx`

Background: the sidebar keeps a `PendingFilters` draft (strings for inputs), converts filters → pending on mount (`filtersToPending`) and pending → URL params on Apply (`pendingToParams`, then `router.replace`). The existing tests mock `next/navigation` with a hoisted `replace` spy and click the Apply button. `FieldGroup` renders its `label` prop as visible text.

- [ ] **Step 1: Write the failing tests**

Append to `app/(app)/explorer/FilterSidebar.test.tsx` (it already imports `render`, `screen`, `fireEvent`, `EXPLORER_DEFAULTS`, `FilterSidebar`, `filtersToPending`, `pendingToParams` and the hoisted `replace` mock):

```tsx
describe('exclude terms ("But not")', () => {
  beforeEach(() => {
    replace.mockClear();
  });

  it('round-trips through pending state as comma-separated text and emits one qx param', () => {
    expect(filtersToPending({ ...EXPLORER_DEFAULTS, qExclude: ['floor', 'ceiling fan'] }).qExclude).toBe('floor, ceiling fan');
    const params = pendingToParams({ ...filtersToPending(EXPLORER_DEFAULTS), qExclude: ' floor ,ceiling fan, ab, FLOOR ' });
    expect(params.get('qx')).toBe('floor,ceiling fan');
    expect(pendingToParams(filtersToPending(EXPLORER_DEFAULTS)).has('qx')).toBe(false);
  });

  it('renders under "Search term contains", applies without an include term, and warns about short chunks', () => {
    render(<FilterSidebar filters={EXPLORER_DEFAULTS} categories={[]} leafCategories={[]} />);
    const input = screen.getByRole('textbox', { name: 'Exclude terms' });
    fireEvent.change(input, { target: { value: 'led, ab' } });
    expect(screen.getByText(/shorter than 3 characters are ignored/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /apply filters/i }));
    const url = replace.mock.calls.at(-1)?.[0] as string;
    expect(new URLSearchParams(url.split('?')[1]).get('qx')).toBe('led');
  });

  it('keeps the Word count card at the bottom of the filter list', () => {
    render(<FilterSidebar filters={EXPLORER_DEFAULTS} categories={[]} leafCategories={[]} />);
    const wordCount = screen.getByText('Word count');
    const titleGap = screen.getByText('Title-gap filter');
    expect(titleGap.compareDocumentPosition(wordCount) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run "app/(app)/explorer/FilterSidebar.test.tsx"`
Expected: FAIL — no `qExclude` in pending state, no "Exclude terms" textbox, Word count still precedes Title-gap.

- [ ] **Step 3: Implement**

In `app/(app)/explorer/FilterSidebar.tsx`:

1. Extend the import from `@/lib/explorer/parseFilters` to `{ EXPLORER_DEFAULTS, MIN_EXCLUDE_TERM_LENGTH, parseExcludeTerms }`.

2. In `PendingFilters`, after `qMode: 'word' | 'broad';`:

```ts
  /** The "But not" text as typed (comma-separated); parsed on Apply. */
  qExclude: string;
```

3. In `filtersToPending`, after `qMode: f.qMode,`:

```ts
    qExclude: f.qExclude.join(', '),
```

4. In `pendingToParams`, after the `qmode` line:

```ts
  const qx = parseExcludeTerms(p.qExclude);
  if (qx.length > 0) params.set('qx', qx.join(','));
```

5. Add a module-level helper next to `sortHint`:

```ts
/** True when the "But not" text has a non-empty chunk under the minimum length (it will be ignored). */
function excludeHasShortChunk(text: string): boolean {
  return text.split(',').some((c) => {
    const t = c.trim();
    return t.length > 0 && t.length < MIN_EXCLUDE_TERM_LENGTH;
  });
}
```

6. Inside the `<FieldGroup label="Search term contains">`, directly after the Whole word / Broad hint block (the `{pending.qMode === 'broad' ? (…) : (…)}` expression) and before the `</FieldGroup>`:

```tsx
        <label className="mt-3 block">
          <span className="text-xs font-medium text-gray-700">But not</span>
          <input
            type="text"
            value={pending.qExclude}
            onChange={(e) => set('qExclude', e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply();
            }}
            placeholder="e.g. floor, ceiling fan"
            className="filter-input mt-1"
            aria-label="Exclude terms"
          />
        </label>
        {excludeHasShortChunk(pending.qExclude) ? (
          <p className="text-xs text-amber-700 mt-1">Chunks shorter than 3 characters are ignored.</p>
        ) : (
          <p className="text-xs text-gray-500 mt-1">
            Drops keywords containing any of these whole words or phrases. Up to 5, comma-separated, 3+ characters
            each; works with or without a search term.
          </p>
        )}
```

7. Move the whole `<FieldGroup label="Word count">…</FieldGroup>` block (currently between "Avg reviews (top-3)" and the Movement/Window groups) to directly after the `<FieldGroup label="Title-gap filter">…</FieldGroup>` block, before the `</div>{/* close scrollable area */}` line. Keep its contents unchanged.

8. If the sidebar's `dirty` flag compares pending fields one by one rather than through `pendingToParams`, add `qExclude` to that comparison; the Apply test above fails with a disabled "Filters applied" button if `dirty` does not flip.

- [ ] **Step 4: Run the tests, the typecheck and the lint**

Run: `pnpm vitest run "app/(app)/explorer" && pnpm typecheck && pnpm eslint "app/(app)/explorer/FilterSidebar.tsx" "app/(app)/explorer/FilterSidebar.test.tsx"`
Expected: PASS, typecheck and lint clean (the existing sort-hint tests still pass).

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/explorer/FilterSidebar.tsx" "app/(app)/explorer/FilterSidebar.test.tsx"
git commit -m "feat(explorer): \"But not\" exclude-terms input under the text filter; Word count card moves to the bottom

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `excludeTerms` on the MCP research search

**Files:**
- Modify: `lib/research/contracts.ts` (`filtersSchema`), `lib/research/query.ts` (`compileSearch`), `lib/research/catalog.ts` (`populationRules`), `lib/mcp/tools/registerResearchTools.ts` (`searchDescription`)
- Test: `lib/research/contracts.test.ts`, `lib/research/query.test.ts`, `lib/research/catalog.test.ts`

Background: `filtersSchema` is a strict zod object with per-field defaults; `searchToolInputSchema` derives its `filters` shape from it, so a new field with a `.describe()` reaches the published tool schema on its own. Cursors embed the validated request (`cursorPayloadSchema` → `searchRequestSchema`), so a field with a default keeps every cursor issued before this change valid. `compileSearch` already imports `wordPattern` and `broadPattern` from the Explorer's `matchPattern.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/research/contracts.test.ts` (import `filtersSchema` and `searchRequestSchema` from `./contracts` if the file does not already):

```ts
describe('filters.excludeTerms', () => {
  it('defaults to an empty list and keeps trimmed distinct terms', () => {
    expect(filtersSchema.parse({}).excludeTerms).toEqual([]);
    expect(filtersSchema.parse({ excludeTerms: [' floor ', 'ceiling fan'] }).excludeTerms).toEqual(['floor', 'ceiling fan']);
  });

  it('rejects a sixth term, a term under 3 characters, and case-insensitive duplicates', () => {
    expect(filtersSchema.safeParse({ excludeTerms: ['a1a', 'b2b', 'c3c', 'd4d', 'e5e', 'f6f'] }).success).toBe(false);
    expect(filtersSchema.safeParse({ excludeTerms: ['ab'] }).success).toBe(false);
    expect(filtersSchema.safeParse({ excludeTerms: ['Floor', 'floor'] }).success).toBe(false);
  });

  it('works without a text filter, and a request from before the field existed still parses', () => {
    const parsed = searchRequestSchema.parse({ schemaVersion: 1, filters: { excludeTerms: ['led'] } });
    expect(parsed.filters.text).toBeNull();
    expect(parsed.filters.excludeTerms).toEqual(['led']);
    const legacy = searchRequestSchema.parse({ schemaVersion: 1, filters: { text: { value: 'lamp' } } });
    expect(legacy.filters.excludeTerms).toEqual([]);
  });
});
```

Append to `lib/research/query.test.ts`, building the `compileSearch` input the same way the file's existing tests do (a parsed `filtersSchema` object plus sort / window / leaves / currentWeekEndDate / paging):

```ts
describe('excludeTerms', () => {
  const F = (p: Record<string, unknown>) => filtersSchema.parse(p);
  const NOT_PREDICATE = /NOT \(kcs\.search_term_normalized ~ \$\d+\)/g;

  it('adds one whole-word NOT per term to rows and count, whatever text.mode says', () => {
    const c = compileSearch({ ...baseInput, filters: F({ text: { value: 'lamp', mode: 'broad' }, excludeTerms: ['floor', 'ceiling fan'] }) });
    expect(c.sql.match(NOT_PREDICATE)).toHaveLength(2);
    expect(c.countSql.match(NOT_PREDICATE)).toHaveLength(2);
    expect(c.args).toContain('\\mfloor\\M');
    expect(c.args).toContain('\\mceiling fan\\M');
    expect(c.args).toContain('%lamp%');
    expect(c.args).not.toContain('%floor%');
  });

  it('works without text and keeps the volume-delta count steering on (a NOT offers no other index)', () => {
    const c = compileSearch({
      ...baseInput,
      sort: { field: 'volumeDelta', direction: 'desc' },
      filters: F({ movement: { window: '4w', metric: 'volume', delta: { gt: 0 } }, excludeTerms: ['led'] }),
    });
    expect(c.sql).toContain('NOT (kcs.search_term_normalized ~ $');
    expect(c.countSql).toContain('NOT (kcs.search_term_normalized ~ $');
    expect(c.countSql).toContain('ORDER BY');
  });
});
```

(`baseInput` = whatever the file already uses for a default unscoped `compileSearch` input; if it has no shared one, declare `const baseInput = { sort: DEFAULT_SORT, window: '4w' as const, leaves: [] as string[], currentWeekEndDate: '2026-09-19', offset: 0, limit: 51 };` matching the input type of `compileSearch`.)

Append to `lib/research/catalog.test.ts`, using the file's existing guide accessor:

```ts
it('documents excludeTerms in the population rules', () => {
  expect(guide.populationRules.some((r) => r.includes('excludeTerms'))).toBe(true);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run lib/research/contracts.test.ts lib/research/query.test.ts lib/research/catalog.test.ts`
Expected: FAIL — unknown key `excludeTerms` (strict object), no NOT predicates, no guide rule.

- [ ] **Step 3: Implement**

In `lib/research/contracts.ts`, inside `filtersSchema`, directly after the `text:` line:

```ts
  excludeTerms: z
    .array(z.string().trim().min(3, 'each exclude term needs at least 3 characters').max(200))
    .max(5, 'excludeTerms allows at most 5 terms')
    .refine((t) => new Set(t.map((s) => s.toLowerCase())).size === t.length, 'excludeTerms must be distinct')
    .default([])
    .describe(
      'Whole words or phrases a keyword must NOT contain (up to 5, 3+ characters each); a keyword is dropped if it contains any of them. Works with or without text and combines with every other filter (AND).',
    ),
```

In `lib/research/query.ts`, in `compileSearch`, directly after the `if (f.text) { … }` block:

```ts
  // Exclude terms: whole-word NOTs regardless of text.mode (owner decision
  // 2026-09-28; the same rule as the Explorer's qExclude). A NOT cannot use the
  // trigram index — it is a per-row filter after the other predicates — and it
  // does NOT turn off the volume-delta count steering: a NOT offers the planner
  // no alternative index (same reasoning as buildQuery's countSteersOntoSortIndex).
  for (const term of f.excludeTerms) {
    where.push(`NOT (kcs.search_term_normalized ~ ${next(wordPattern(term))})`);
  }
```

Leave the volume-delta count steering line (`steerCount`) unchanged: exclude terms must NOT turn it off, for the same reason as the Explorer's `countSteersOntoSortIndex` (a NOT offers the planner no alternative index; the text filter's trigram index is why `f.text === null` stays in the condition).

In `lib/research/catalog.ts`, in `populationRules`, directly after the `'Any bound on a metric excludes rows where that metric is null.',` entry:

```ts
      'excludeTerms drops any keyword containing one of the listed whole words or phrases (up to 5, at least 3 characters each); it works with or without text and combines with every other filter.',
```

In `lib/mcp/tools/registerResearchTools.ts`, in `searchDescription`, directly after the `'Resolve category words with resolve_categories first …'` entry:

```ts
    'filters.excludeTerms drops keywords containing any of up to five whole words or phrases (3+ characters each) — use it for "lamps but not floor lamps"; it works with or without filters.text.',
```

- [ ] **Step 4: Run the tests, the typecheck and the lint**

Run: `pnpm vitest run lib/research lib/mcp "app/api/mcp" && pnpm typecheck && pnpm eslint lib/research lib/mcp/tools`
Expected: PASS (including the existing cursor, service and route tests), typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add lib/research/contracts.ts lib/research/contracts.test.ts lib/research/query.ts lib/research/query.test.ts lib/research/catalog.ts lib/research/catalog.test.ts lib/mcp/tools/registerResearchTools.ts
git commit -m "feat(research): excludeTerms on search_keywords — whole-word NOTs, guide rule, tool description

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Verification, review, production probe, and the owner-gated ship

**Files:**
- Create (UNTRACKED, do not commit): `scripts/probeExcludeTerms0928.ts`
- Modify: this plan (append a "Results" section with the probe numbers)

- [ ] **Step 1: Full local verification**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run && pnpm build`
Expected: typecheck clean; lint clean for every tracked file (the two known errors live in untracked throwaway scripts); every test green; `next build` succeeds.

- [ ] **Step 2: Independent review**

Dispatch the `superpowers:code-reviewer` subagent over `git diff <first commit of this plan>^..HEAD` with this plan as the spec. Ask it to verify: the NOT predicate is present in rows AND count on both classic paths and absent nowhere it should be; the covered path stands down; the three precomputed-total guards bypass; saved views and the CSV export round-trip; the sidebar pending state round-trips and the Word count card is last; the research contract, compiler, guide and description agree with the Explorer; every user string reaches SQL only through a bound parameter (`next(...)`), never by interpolation; a cursor issued before the change still parses. Fix what it finds, re-review to APPROVED.

- [ ] **Step 3: Production probe (read-only)**

Write the untracked script below, then run `node --env-file=.env.local --import tsx scripts/probeExcludeTerms0928.ts > <scratchpad>/probe-exclude.txt 2>&1` and read the `===` header lines plus the scan/buffer lines under each.

```ts
// scripts/probeExcludeTerms0928.ts (UNTRACKED) — read-only production probe of the exclude-terms
// shapes. Every statement runs in a REPEATABLE READ READ ONLY tx with a 60 s statement_timeout;
// only EXPLAIN (ANALYZE, BUFFERS) output is printed. Two passes: cold, then warm.
import { Pool } from 'pg';
import { buildExplorerQuery } from '@/lib/explorer/buildQuery';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';
import type { ExplorerFilters } from '@/lib/explorer/types';

type Target = 'rows' | 'count';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    const meta = (await client.query(
      'SELECT current_week_end_date::text AS week, snapshot_version::text AS sv FROM keyword_current_summary_meta WHERE singleton = true',
    )).rows[0];
    const week = meta.week as string;
    const leaf = (await client.query(
      `SELECT category_path FROM keyword_current_summary_leaf_category_facets
       WHERE snapshot_version = $1::uuid AND category_path ILIKE '%lighting%' ORDER BY all_count DESC LIMIT 1`,
      [meta.sv],
    )).rows[0]?.category_path as string | undefined;
    console.log(`week ${week}; lighting leaf: ${leaf ?? '(none)'}`);

    const shapes: Array<{ name: string; filters: ExplorerFilters; targets: Target[] }> = [
      { name: 'landing + 5 excludes (legacy path, rank walk)', filters: { ...EXPLORER_DEFAULTS, qExclude: ['light', 'lamp', 'led', 'bulb', 'solar'] }, targets: ['rows', 'count'] },
      { name: 'q=lamp + exclude floor,table (q path, window count)', filters: { ...EXPLORER_DEFAULTS, q: 'lamp', qExclude: ['floor', 'table'] }, targets: ['rows'] },
      ...(leaf
        ? [{ name: 'lighting leaf + exclude led (leaf bitmap; covered path stood down)', filters: { ...EXPLORER_DEFAULTS, leafPaths: [leaf], qExclude: ['led'] } as ExplorerFilters, targets: ['rows', 'count'] as Target[] }]
        : []),
      { name: 'avg_reviews_desc + exclude led (steering stays on)', filters: { ...EXPLORER_DEFAULTS, sort: 'avg_reviews_desc', qExclude: ['led'] }, targets: ['rows', 'count'] },
    ];

    for (const pass of ['cold', 'warm'] as const) {
      for (const s of shapes) {
        const built = buildExplorerQuery(s.filters, week);
        for (const target of s.targets) {
          const [sql, args] = target === 'rows' ? [built.sql, built.args] : [built.countSql, built.countArgs];
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          await client.query('SET LOCAL statement_timeout = 60000');
          const t = Date.now();
          try {
            const plan = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, args as unknown[]);
            const lines = plan.rows.map((r) => String(r['QUERY PLAN']));
            console.log(`\n=== [${pass}] ${s.name} [${target}] ${Date.now() - t} ms ===`);
            console.log(lines.filter((l) => /Scan|Sort|Buffers: shared|Execution Time/.test(l)).slice(0, 8).join('\n'));
            await client.query('COMMIT');
          } catch (e) {
            console.log(`\n=== [${pass}] ${s.name} [${target}] FAILED after ${Date.now() - t} ms: ${(e as Error).message} ===`);
            await client.query('ROLLBACK').catch(() => {});
          }
        }
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Acceptance: every rows query ≤ 3 s warm and every count ≤ 3 s warm; no `Seq Scan on keyword_current_summary` under a shape that used an index before the change (compare against the same shape without `qExclude` if in doubt). Cold numbers are recorded, not gated: the first touch after a weekly refresh pays hint-bit writes regardless of this change. If a shape is pathological, stop and report before pushing.

- [ ] **Step 4: Record the results**

Append a `## Results` section to this plan with the probe table (shape × cold/warm × rows/count) and the review verdict; commit it:

```bash
git add docs/superpowers/plans/2026-09-28-exclude-terms.md
git commit -m "docs(explorer): exclude-terms plan — production probe results and review verdict

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Ship (OWNER-GATED)**

On the owner's go: `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` (no running Keepa run, no importing batch), `git push origin main`, watch Vercel and the Railway worker until green. Smoke: the owner opens the Explorer, types a term into "But not", applies, and sees the total and rows change; then asks Claude one exclusion question ("Show me lamp keywords that aren't floor lamps") and checks the reported total differs from the plain "lamp" search. Record the outcome in the Results section.

---

## Not in scope

- Broad (substring) exclusion, or per-term modes: whole word only, by decision.
- Excluding whole categories (already possible by not selecting them) or per-slot title exclusions.
- A "Try asking" example on the Connect AI page for exclusions; the owner curates that list.
- Any schema change: the normalized text column and its trigram index already exist.

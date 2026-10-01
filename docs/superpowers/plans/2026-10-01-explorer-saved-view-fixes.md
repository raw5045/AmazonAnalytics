# Explorer Saved-View Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A saved view keeps its filters when a member sorts or pages it in the Explorer, and every saved view stays visible (and deletable) even when the create race leaves a sixth one.

**Architecture:** One pure function, `resolveExplorerFilters(sp, activeView)` in `lib/explorer/resolveFilters.ts`, decides whether the Explorer shows a view's stored filters (with `sort`, `page`, `per_page` overlaid from the URL) or the URL's own filters; `app/(app)/explorer/page.tsx` calls it instead of its inline `urlHasFilters` test. The saved-view list loader and the GET route drop their display cap (`.limit(MAX_VIEWS_PER_USER)`); the cap stays on create. Both items came out of the arc-3 final review (spec 2026-09-30 §14, 2026-10-01).

**Tech Stack:** Next.js 16 App Router (async server component), vitest 4.1.4, drizzle-orm 0.45, TypeScript 5.9.

**Conventions (binding, as in arcs 1–3):** TDD per task; `git add` named files only; commit trailer exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; never push without the owner's explicit go, and run `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` first (the Railway worker restarts on push; keep the push a bare `git push origin main` — a compound command is refused by the permission classifier); no DDL; lint touched files only (`pnpm exec eslint <files>`); preserve each file's line endings (mixed CRLF/LF); never log a DB error's `.message`; never print member emails. Read `node_modules/next/dist/docs/01-app/` before touching `app/` (genuine vendored Next.js 16 docs, as `AGENTS.md` asks).

---

## Background (what is broken and why)

- **Sort / page on a saved view.** A view opens as `/explorer?view=<id>`. `SortableHeader.tsx` and `Pagination.tsx` keep the current URL and set `sort` / `page`, giving `?view=<id>&sort=imp`. `page.tsx` (lines ~110–127) computes `urlHasFilters` = "any key other than `view`, `page`, `per_page`", so a `sort` key makes it ignore the stored filters and parse the URL instead: the member sees the whole catalogue sorted, while the picker still shows the view's name. Paging is also broken, the other way round: `page` is excluded from `urlHasFilters`, so `?view=<id>&page=2` hydrates the stored filters — which carry `page: 1` — and shows page 1 again. Pre-existing; AI-made views (arc 3) expose it more.
- **A sixth view is invisible.** `createSavedView` counts then inserts (no lock; neon-http has no transactions), so two creates in the same instant can both pass the count. `listSavedViewsForUser` and the GET route list `.limit(MAX_VIEWS_PER_USER)` newest-first, so the oldest view disappears from the picker and from `list_saved_views`, `count` says 5, and nothing can delete it because its id is never shown. Making the insert atomic needs a schema change (a slot column with a unique index) — not this plan; the race stays accepted (arc-3 spec §8.7) but becomes self-healing: the sixth view shows, the Save button says "6 of 5 views saved — delete 2 to save another" (the count is computed; "delete one" at exactly five), and create keeps refusing until the member is back under the cap.

---

### Task 1: `resolveExplorerFilters` — a view keeps its filters under sort and page overlays

**Files:**
- Create: `lib/explorer/resolveFilters.ts`
- Test: `lib/explorer/resolveFilters.test.ts`
- Modify: `app/(app)/explorer/page.tsx` (the block that starts `// Two URL shapes are supported:` and ends `: parseExplorerFilters(sp);`, lines ~110–127, plus one import)

- [ ] **Step 1: Failing test — `lib/explorer/resolveFilters.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { EXPLORER_DEFAULTS } from './parseFilters';
import { resolveExplorerFilters, VIEW_OVERLAY_KEYS } from './resolveFilters';
import type { SavedView } from '@/lib/savedViews/types';

// A view whose stored sort is NOT the Explorer default, so "kept" and "defaulted" are distinguishable.
const stored = { ...EXPLORER_DEFAULTS, q: 'lamp', rankMax: 5000, sort: 'imp' as const, leafPaths: ['Home & Kitchen › Lighting › Lamps'] };
const view: SavedView = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Lamps',
  filters: stored,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('resolveExplorerFilters (saved view vs URL, 2026-10-01)', () => {
  it('names exactly the keys the column headers and the pager write', () => {
    expect([...VIEW_OVERLAY_KEYS]).toEqual(['sort', 'page', 'per_page']);
  });

  it('bookmark form: the view alone → its stored filters, untouched (stored sort kept, not defaulted)', () => {
    expect(resolveExplorerFilters({ view: view.id }, view)).toEqual({ filters: stored, fromView: true });
  });

  it('a column-header sort on a view keeps the view and changes only the sort', () => {
    expect(resolveExplorerFilters({ view: view.id, sort: 'avg_reviews_desc' }, view)).toEqual({
      filters: { ...stored, sort: 'avg_reviews_desc' },
      fromView: true,
    });
  });

  it('paging a view keeps the view and changes only page / perPage', () => {
    expect(resolveExplorerFilters({ view: view.id, page: '3' }, view).filters).toEqual({ ...stored, page: 3 });
    expect(resolveExplorerFilters({ view: view.id, page: '2', per_page: '50' }, view).filters).toEqual({ ...stored, page: 2, perPage: 50 });
  });

  it('an invalid overlay value falls back the way parseExplorerFilters does, never to losing the view', () => {
    expect(resolveExplorerFilters({ view: view.id, sort: 'bogus' }, view).filters).toEqual({ ...stored, sort: EXPLORER_DEFAULTS.sort });
    expect(resolveExplorerFilters({ view: view.id, page: '0' }, view).filters).toEqual({ ...stored, page: EXPLORER_DEFAULTS.page });
  });

  it('a real filter param next to the view tag means the URL is the source of truth', () => {
    const r = resolveExplorerFilters({ view: view.id, sort: 'imp', q: 'desk' }, view);
    expect(r.fromView).toBe(false);
    expect(r.filters).toEqual({ ...EXPLORER_DEFAULTS, sort: 'imp', q: 'desk' });
  });

  it('without a loaded view the URL is parsed as before', () => {
    expect(resolveExplorerFilters({ sort: 'imp' }, null)).toEqual({ filters: { ...EXPLORER_DEFAULTS, sort: 'imp' }, fromView: false });
    expect(resolveExplorerFilters({ view: view.id, sort: 'imp' }, null).fromView).toBe(false);
  });

  it('ignores undefined params (Next passes them for absent keys) and array-valued ones take the first value', () => {
    expect(resolveExplorerFilters({ view: view.id, sort: undefined }, view)).toEqual({ filters: stored, fromView: true });
    expect(resolveExplorerFilters({ view: view.id, page: ['2', '9'] }, view).filters.page).toBe(2);
  });
});
```

If `EXPLORER_DEFAULTS.page` / the `page: '0'` fallback is not what `parseExplorerFilters` actually does for `0` (read `parsePositiveInt` in `lib/explorer/parseFilters.ts`), pin what it really does and say so in your report; the point is that a bad overlay never discards the view.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/explorer/resolveFilters.test.ts`
Expected: FAIL — `Cannot find module './resolveFilters'`.

- [ ] **Step 3: Implement `lib/explorer/resolveFilters.ts`**

```ts
import { parseExplorerFilters, type SearchParamsLike } from './parseFilters';
import type { ExplorerFilters } from './types';
import type { SavedView } from '@/lib/savedViews/types';

/**
 * URL keys that OVERLAY a saved view instead of replacing it. SortableHeader and
 * PaginationControls keep the current URL and set one of these, so
 * `/explorer?view=<id>&sort=imp` must still mean "the view, sorted" and
 * `?view=<id>&page=2` "the view, page 2". Any other key is a filter param: the
 * member changed the view's criteria (FilterSidebar's Apply drops the view tag),
 * or a hybrid URL arrived from elsewhere — in both cases the URL is the source of
 * truth and the view tag is metadata only. (Until 2026-10-01 the page read `sort`
 * as a filter — the whole catalogue, sorted, under the view's name — and dropped
 * `page` in favour of the stored `page: 1`.)
 */
export const VIEW_OVERLAY_KEYS = ['sort', 'page', 'per_page'] as const;

export interface ResolvedExplorerFilters {
  filters: ExplorerFilters;
  /** True when `filters` came from the view's stored JSON (with overlays applied). */
  fromView: boolean;
}

/** Pure: no I/O. `activeView` is the already-loaded, owner-scoped view for `sp.view`, or null. */
export function resolveExplorerFilters(sp: SearchParamsLike, activeView: SavedView | null): ResolvedExplorerFilters {
  const extraKeys = Object.keys(sp).filter((k) => k !== 'view' && sp[k] !== undefined);
  const onlyOverlays = extraKeys.every((k) => (VIEW_OVERLAY_KEYS as readonly string[]).includes(k));
  if (!activeView || !onlyOverlays) return { filters: parseExplorerFilters(sp), fromView: false };
  // The overlays go through the same parser as a full URL, so they are validated and
  // clamped exactly as before (bad sort → default sort, page clamped to MAX_EXPLORER_OFFSET).
  const overlay = parseExplorerFilters(sp);
  return {
    filters: {
      ...activeView.filters,
      ...(sp.sort !== undefined ? { sort: overlay.sort } : {}),
      ...(sp.page !== undefined ? { page: overlay.page } : {}),
      ...(sp.per_page !== undefined ? { perPage: overlay.perPage } : {}),
    },
    fromView: true,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run lib/explorer/resolveFilters.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Wire `app/(app)/explorer/page.tsx`**

Add the import `import { resolveExplorerFilters } from '@/lib/explorer/resolveFilters';` next to the `parseFilters` import (keep `parseExplorerFilters` imported only if it is still referenced — `filtersAreCustomized` uses it in a type position; if you switch that signature to `ExplorerFilters`, which is already imported as a type, drop the value import and let eslint confirm). Replace exactly this block:

```ts
  // Two URL shapes are supported:
  //   1. Bookmark form: `/explorer?view=<id>` (no other filter params)
  //      → hydrate filters from the view's stored JSON.
  //   2. Full form: `/explorer?<filter params>` (no view tag)
  //      → use the URL filters directly. The dropdown stays blank.
  //
  // Apply in FilterSidebar always drops the view tag, so the moment a
  // user modifies a loaded view the URL becomes shape (2), the chip
  // blanks out, and the URL is the single source of truth. The hybrid
  // shape `?view=<id>&<filters>` is no longer produced by the UI but
  // is still accepted (URL filters win, view tag = metadata only).
  const urlHasFilters = Object.keys(sp).some(
    (k) => k !== 'view' && k !== 'page' && k !== 'per_page',
  );
  const filters = activeView && !urlHasFilters
    ? activeView.filters
    : parseExplorerFilters(sp);
```

with:

```ts
  // Three URL shapes are supported (lib/explorer/resolveFilters.ts):
  //   1. Bookmark form: `/explorer?view=<id>` → the view's stored JSON.
  //   2. View + overlay: `?view=<id>&sort=…` / `&page=…` / `&per_page=…` → the
  //      view's stored JSON with that sort / page applied. The column headers and
  //      the pager keep the current URL and set one of these, so sorting or
  //      paging a view must not throw its filters away (until 2026-10-01 it did).
  //   3. Full form: `/explorer?<filter params>` (no view tag) → the URL filters.
  //      Apply in FilterSidebar always drops the view tag, so the moment a member
  //      changes a loaded view's criteria the URL becomes this shape and the chip
  //      blanks out. A hybrid `?view=<id>&<filter params>` from elsewhere is read
  //      as shape 3 (URL wins, view tag = metadata only).
  const { filters } = resolveExplorerFilters(sp, activeView);
```

Nothing else in the page changes: `backUrl` and `pageOneHref` re-serialise `sp` (so a detail page returns to `?view=<id>&sort=…`, which now resolves correctly), `exportQuery` is built from the resolved `filters`, and the sidebar's `key={activeView?.id}` is unchanged.

- [ ] **Step 6: Typecheck, lint, the explorer tests**

Run: `pnpm typecheck && pnpm exec eslint lib/explorer/resolveFilters.ts lib/explorer/resolveFilters.test.ts "app/(app)/explorer/page.tsx" && pnpm vitest run lib/explorer "app/(app)/explorer"`
Expected: clean; PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/explorer/resolveFilters.ts lib/explorer/resolveFilters.test.ts "app/(app)/explorer/page.tsx"
git commit -F - <<'MSG'
fix(explorer): a saved view keeps its filters when sorted or paged — sort/page/per_page overlay the stored filters instead of replacing them (resolveExplorerFilters)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 2: Saved-view listings without the display cap

**Files:**
- Modify: `lib/savedViews/loadServer.ts` (`listSavedViewsForUser`), `app/api/explorer/saved-views/route.ts` (the GET query)
- Create: `lib/savedViews/loadServer.test.ts`
- Modify: `app/api/explorer/saved-views/route.test.ts` (the list helper + one new test)

- [ ] **Step 1: Failing tests**

Create `lib/savedViews/loadServer.test.ts` (same mocking pattern as `lib/customCategories/loadServer.test.ts`):

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn() } }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/db/client', () => ({ db: mockDb }));

import { PgDialect } from 'drizzle-orm/pg-core';
import { listSavedViewsForUser, loadSavedViewForUser } from './loadServer';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const at = (i: number) => new Date(`2026-10-0${i}T10:00:00Z`);
const row = (i: number) => ({ id: `${i}${i}${i}${i}${i}${i}${i}${i}-${i}${i}${i}${i}-4${i}${i}${i}-8${i}${i}${i}-${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}`, userId: USER_ID, name: `View ${i}`, filters: { q: `kw${i}` }, createdAt: at(i), updatedAt: at(i) });

/** Next `db.select().from().where().orderBy()` resolves to `rows` — no `.limit` in the chain: the list is never capped. */
function selectList(rows: unknown[]) {
  const where = vi.fn().mockReturnValueOnce({ orderBy: vi.fn().mockResolvedValueOnce(rows) });
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where }) } as never);
  return { where };
}
/** Next `db.select().from().where().limit()` resolves to `rows` (the single-view load). */
function selectOne(rows: unknown[]) {
  const where = vi.fn().mockReturnValueOnce({ limit: vi.fn().mockResolvedValueOnce(rows) });
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where }) } as never);
  return { where };
}

beforeEach(() => vi.clearAllMocks());

describe('listSavedViewsForUser', () => {
  it('returns every view, newest first as the query orders them, with normalised filters — six included (the create race can leave one over the cap; it must stay visible so it can be deleted)', async () => {
    const { where } = selectList([6, 5, 4, 3, 2, 1].map(row));
    const views = await listSavedViewsForUser(USER_ID);
    expect(views.map((v) => v.name)).toEqual(['View 6', 'View 5', 'View 4', 'View 3', 'View 2', 'View 1']);
    expect(views[0].filters).toEqual({ ...EXPLORER_DEFAULTS, q: 'kw6' });
    expect(views[0].createdAt).toBe('2026-10-06T10:00:00.000Z');
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0])).toMatchObject({ sql: '"saved_views"."user_id" = $1', params: [USER_ID] });
  });
});

describe('loadSavedViewForUser', () => {
  it('returns null for a malformed id without querying', async () => {
    await expect(loadSavedViewForUser(USER_ID, 'nope')).resolves.toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it('is owner-scoped and returns the normalised view', async () => {
    const r = row(1);
    const { where } = selectOne([r]);
    await expect(loadSavedViewForUser(USER_ID, r.id)).resolves.toMatchObject({ id: r.id, name: 'View 1', filters: { ...EXPLORER_DEFAULTS, q: 'kw1' } });
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0])).toMatchObject({ sql: '("saved_views"."id" = $1 and "saved_views"."user_id" = $2)', params: [r.id, USER_ID] });
  });
  it('returns null when no row matches', async () => {
    selectOne([]);
    await expect(loadSavedViewForUser(USER_ID, row(1).id)).resolves.toBeNull();
  });
});
```

(If `normalizeFiltersBlob` fills more than `EXPLORER_DEFAULTS` — e.g. derived fields — use `toMatchObject` on `filters` and say so. If the stored-blob normaliser rejects `{ q: 'kw6' }` as too sparse, read `lib/savedViews/validation.ts` and use the smallest blob it accepts.)

In `app/api/explorer/saved-views/route.test.ts`: change the list helper so the chain ends at `orderBy` (no `limit`):

```ts
/** Next `db.select().from().where().orderBy()` resolves to `rows` (the list query — never capped). */
function selectList(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: vi.fn().mockResolvedValueOnce(rows) }) }) } as never);
}
```

(keep the helper's real name) and add to the GET describe:

```ts
  it('lists all six views when the create race left one over the cap (nothing is hidden from the picker)', async () => {
    selectList([6, 5, 4, 3, 2, 1].map((i) => ({ ...viewRow, id: `${viewRow.id.slice(0, -1)}${i}`, name: `View ${i}` })));
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).views.map((v: { name: string }) => v.name)).toEqual(['View 6', 'View 5', 'View 4', 'View 3', 'View 2', 'View 1']);
  });
```

(`viewRow` is whatever the file calls its row fixture — read it first and adapt.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run lib/savedViews/loadServer.test.ts app/api/explorer/saved-views/route.test.ts`
Expected: FAIL — `limit is not a function` from both list queries (the code still calls `.limit`).

- [ ] **Step 3: Implement**

`lib/savedViews/loadServer.ts`: in `listSavedViewsForUser` delete the `.limit(MAX_VIEWS_PER_USER)` line; drop `MAX_VIEWS_PER_USER` from the import if nothing else in the file uses it; replace the function's doc comment with:

```ts
/**
 * Every one of the user's saved views, newest first — deliberately NOT capped at
 * MAX_VIEWS_PER_USER. The cap is enforced on create (lib/savedViews/commands.ts);
 * two creates in the same instant can both pass its count-then-insert check and
 * leave a sixth view, which must stay visible to the picker and to the MCP's
 * list_saved_views so it can be deleted (arc-3 final review, 2026-10-01). Stored
 * `filters` JSON is normalised so callers get a fully-populated typed object even
 * if the blob predates newer fields.
 */
```

`app/api/explorer/saved-views/route.ts`: in `GET` delete the `.limit(MAX_VIEWS_PER_USER)` line and add a one-line comment above the query (`// Never capped: a sixth view from the create race must stay listable (see listSavedViewsForUser).`); drop the `MAX_VIEWS_PER_USER` import if `POST` no longer uses it (it delegates to the command since arc 3 — check).

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run lib/savedViews app/api/explorer/saved-views lib/workspace "app/(app)/explorer"`
Expected: PASS (the workspace service injects its own `list`, so `list_saved_views` with six views reports `count: 6, limit: 5` without any change there).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint lib/savedViews/loadServer.ts lib/savedViews/loadServer.test.ts app/api/explorer/saved-views/route.ts app/api/explorer/saved-views/route.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/savedViews/loadServer.ts lib/savedViews/loadServer.test.ts app/api/explorer/saved-views/route.ts app/api/explorer/saved-views/route.test.ts
git commit -F - <<'MSG'
fix(saved-views): list every view, never capped — a sixth view from the create race stays visible and deletable (cap stays on create)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 3: Offline checks, docs, ship (owner-gated push)

- [ ] **Step 1: The whole offline suite** — `pnpm typecheck && pnpm vitest run && pnpm build`. Expected: clean; 81 routes, unchanged. (`pnpm lint` whole-project exits 1 on pre-existing problems in untracked scripts and untouched files; eslint the files these tasks changed instead.)
- [ ] **Step 2: Docs** — in `docs/superpowers/specs/2026-09-30-mcp-write-access-design.md` §14 mark the two Explorer follow-ups "fixed 2026-10-01 (plan 2026-10-01-explorer-saved-view-fixes)"; fill the Results table below; commit the two docs with the trailer.
- [ ] **Step 3 (owner-gated): push** — `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` (no Keepa run, no importing batch), then, on the owner's explicit go, a bare `git push origin main`; watch `gh api repos/raw5045/AmazonAnalytics/commits/<sha>/status --jq '"overall: \(.state)", (.statuses[] | "\(.context): \(.state) @ \(.updated_at)")'` to both `success`.
- [ ] **Step 4 (owner): smoke** — open a saved view in the Explorer, click a column header: the rows stay the view's, now sorted, and the picker still names the view; click Next: page 2 of the view; change a sidebar filter and Apply: the chip blanks as before. Ask Claude for `list_saved_views`: unchanged shape.

### Task 4 (added 2026-10-01, owner request): the picker reflects a pick immediately and shows the loading circle

**Why:** picking a saved view calls `router.push('/explorer?view=<id>')` with nothing wrapped; the picker derives its label from the URL, which only changes when the server render (view load + Explorer query) commits, so for a few seconds the box stays on "Saved views" (or the old name) with no spinner — it looks like the pick failed. The filter sidebar, the pager and the column headers all drive `LoadingOverlay` from a `useTransition` around their `router.replace`; the pick gets the same treatment, plus an optimistic label. Delete and rename are NOT wrapped: `SavedViewsDropdown.tsx`'s own comment records that a transition around `router.refresh()` after a delete got stuck pending in Next 16, and nothing changes there.

**Files:**
- Modify: `app/(app)/explorer/SavedViewsDropdown.tsx`
- Test: `app/(app)/explorer/SavedViewsControls.test.tsx` (the picker is exercised through it) or a new `SavedViewsDropdown.test.tsx` with the same `next/navigation` mocks

**Design (exact):**
- `const [isPending, startTransition] = useTransition();` and `const [pendingId, setPendingId] = useState<string | null>(null);`.
- `applyView(view)`: `setOpen(false); setPendingId(view.id); startTransition(() => { router.push(buildViewHref(view)); });` — the push stays synchronous inside the transition (as `FilterSidebar` does), never after an `await`.
- Optimistic label: the active id is `pendingId` while the URL has not caught up, else as today: `const urlViewId = searchParams?.get('view') ?? null; const viewId = pendingId ?? activeIdOverride ?? urlViewId;` with `pendingId` cleared by the "adjust state when a prop changes" pattern already used in `SavedViewsControls`: remember the search string at the pick (`pendingSearch`); on the first render where `searchParams.toString()` differs from it (the navigation committed, or the member went elsewhere), `setPendingId(null)`. Once committed the URL carries the same id, so the label is continuous; if the member navigates elsewhere first, the URL wins.
- `<LoadingOverlay show={isPending} />` rendered by the dropdown (the overlay is `fixed inset-0`, so where it sits in the tree does not matter), and `aria-busy={isPending}` on the picker button.
- Update the comment block above `applyView` to say: only the pick is wrapped (a `router.push` transition resolves when the navigation commits, like the sidebar's); delete/rename stay unwrapped for the recorded reason.

**Tests (TDD):**
1. Picking a view shows its name in the picker button immediately, while `useSearchParams` still returns the old URL (mock stays static), and `router.push` was called with `buildViewHref(view)`.
2. When the URL then changes to `?view=<that id>` (re-render with the mocked search params updated), the label stays on that view and `pendingId` no longer matters; when the URL instead changes to something else (e.g. a full-form filter URL), the label follows the URL (placeholder or the other view).
3. The overlay: with `react`'s `useTransition` mocked to `[true, (fn) => fn()]` for one test, the dropdown renders the `role="status"` loading overlay and the button has `aria-busy="true"`; with the real hook it does not render after the click settles.
4. Existing delete/rename tests unchanged and green.

**Run:** `pnpm vitest run "app/(app)/explorer" && pnpm typecheck && pnpm exec eslint <files>`.

**Commit:** `feat(explorer): picking a saved view shows it immediately and spins the loading overlay (transition around the pick only)` + the trailer.

## Results

| Check | Outcome |
|---|---|
| Commits | 1d3a56d Task 1 (resolver + page), 9e06ed1 Task 2 (uncapped listings), b1649ce Save button resolves like the page (implementer-flagged gap: saving a sorted view would have posted the whole catalogue), c7c570d six-view copy + dropdown comment, 4a1fcf9 clamp against the view's page size + GET owner-scoping pin + comment/title fixes |
| `pnpm vitest run` | 186 files / 1,895 tests passed at 4a1fcf9 (2026-10-01) |
| `pnpm typecheck` | clean |
| `pnpm build` | passed; no route, page or layout added or removed |
| Reviews | Task 2 spec: compliant (four cosmetic notes → c7c570d). Task 1 spec (three commits): compliant, every Explorer flow walked (header sort, Next/Prev, detail-and-back, Apply blanks the chip, Save on a sorted view, Save on a hybrid URL); pre-existing note: after a header sort the sidebar is not remounted, so its Sort select still shows the stored sort and Apply re-sorts by it — true for every URL today. Combined code-quality review (19bd65c..c7c570d): approve; four of six minors taken in 4a1fcf9, left: `fromView` (kept for the tests and a future picker use), the MCP "(up to 5)" wording and the create refusal sentence (spec-pinned), and a follow-up that the GET route duplicates `listSavedViewsForUser` (delegating would normalise `filters` in the response) |
| Push / deploy | pending the owner's go |
| Smoke | pending the owner: open a saved view, sort by a column (rows stay the view's, picker still names it), Next page, change a sidebar filter and Apply (chip blanks); the AI's `list_saved_views` shape unchanged |

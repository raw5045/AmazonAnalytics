# Watchlist — Design Spec

Date: 2026-05-27
Owner: Reese
Status: Ready for implementation planning (Plan 3.4.2)
Predecessor: Plan 3.4.1 (Saved Views)

## 1. Summary

Users can hand-pick a set of specific keywords they want to track over time. A ⭐ Watch toggle on the keyword detail page and a ⭐ column in the explorer results table add/remove keywords. A new `/watchlist` page reuses the explorer's `ResultsTable` to render the watched set with all the same columns and clickable-header sort.

Watchlists are distinct from saved views: saved views are *filter rules*; watchlists are *enumerated keyword IDs*. The product-level master plan originally bundled them via an `is_watchlist` flag on `saved_views`; Plan 3.4.1 split them, and this spec implements the watchlist half as a separate concern.

## 2. Decisions locked

| Area | Decision |
|---|---|
| Granularity | One global watchlist per user (no named lists in v1) |
| Per-user cap | 100 keywords |
| Privacy | Private only (matching saved-views model) |
| Add/remove surfaces | ⭐ toggle on detail page + ⭐ column in explorer results |
| Watchlist page | Reuses explorer `ResultsTable`, no filter sidebar, window selector only |
| Navigation | "Explorer | Watchlist" tab nav in a new shared route-group layout |
| Sort | Same clickable-header sort the explorer uses; plus a new "Added" column sortable by `added_at` |
| Pagination | None — 100 cap fits on one page |
| Notifications | Out of scope; schema designed so they slot in later |

## 3. Data model

### 3.1 `watchlist_items` table

```sql
CREATE TABLE watchlist_items (
  user_id      uuid        NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  keyword_id   uuid        NOT NULL REFERENCES search_terms(id) ON DELETE CASCADE,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, keyword_id)
);

CREATE INDEX watchlist_items_user_added_idx
  ON watchlist_items (user_id, added_at DESC);
```

Rationale:
- Composite PK `(user_id, keyword_id)` gives uniqueness for free; a double-click can't create dupes.
- `ON DELETE CASCADE` on both FKs prevents dangling rows if a user or (theoretically) a search_term is removed.
- No surrogate `id`, no `list_id`, no `notes` — v1 carries exactly what it needs. Adding named lists later is a single nullable `list_id` column + a sibling `watchlist_lists` table.
- 100-cap is **not** a SQL constraint; enforced in the POST handler. Matches how saved views' 5-cap works and keeps the cap tunable without a migration.

### 3.2 Index choices

The `(user_id, added_at DESC)` covering index supports the watchlist page's "newest first by default" listing without a table sort. Lookup by `(user_id, keyword_id)` is the PK so already indexed.

## 4. API routes

All endpoints under `/api/watchlist/`, all auth-gated, all scoped to the current user.

### 4.1 `GET /api/watchlist/items`

Returns the full list:
```json
{ "items": [{ "keywordId": "uuid", "addedAt": "2026-05-27T12:34:56Z" }, ...] }
```

Used by: explorer page (to mark stars), detail page (to set initial isWatched), watchlist page (the main list query, joined with keyword data).

At cap (100 rows) the response is ~3KB — small enough to send the whole list to the client unpaginated. This avoids a per-row "is this watched?" query in the explorer.

### 4.2 `POST /api/watchlist/items`

Request body: `{ "keywordId": "uuid" }`

- Validates UUID format
- Validates the keyword_id exists in `search_terms` (so we don't create dangling references silently)
- Counts existing rows for this user; returns **409 Conflict** with `{ "error": "watchlist_at_cap" }` if already at 100
- Inserts; ignores conflict (idempotent — already-watching is a no-op success)
- Returns `{ "ok": true, "addedAt": "..." }`

### 4.3 `DELETE /api/watchlist/items/[keywordId]`

- Validates UUID format
- Deletes the row scoped to `(current_user.id, keywordId)`
- Idempotent — deleting nothing returns 200, not 404 (this matches what optimistic UI expects)
- Returns `{ "ok": true }`

### 4.4 What's intentionally absent

- **No PATCH** — there are no editable fields on a watchlist item.
- **No bulk endpoint** — deferred (see §10). CSV upload from the watchlist page is a planned future enhancement that will introduce `POST /api/watchlist/items/bulk`.
- **No public read** — same as saved views.

## 5. UI surfaces

### 5.1 Route-group layout `app/(app)/layout.tsx`

A new route group wraps both `/explorer/*` and `/watchlist/*` to share the top-level tab nav:

```
┌────────────────────────────────────────────────────────────────────┐
│  Explorer | Watchlist (12)                  raw5045@…    Admin     │
└────────────────────────────────────────────────────────────────────┘
```

The current `app/explorer/layout.tsx` shrinks to render only the saved-views row (which is explorer-specific). The new `(app)` layout owns:
- Auth check (`requireAuthenticatedUser`, redirect to /sign-in on failure)
- Tab nav with active-tab styling via `usePathname()`
- User email + Admin link

Data fetching responsibilities:
- The `(app)` layout calls `watchlistCountForUser(user.id)` to render the tab-nav count badge (`Watchlist (12)`). This is a single `SELECT count(*)` — cheap.
- `/explorer/page.tsx` and `/watchlist/page.tsx` each call `listWatchlistForUser(user.id)` independently for the per-row star state. Pages can't read layout-computed values without Context (and Context across the server/client boundary requires explicit wiring that isn't worth it for two cheap queries).

### 5.2 Detail-page toggle

Next to the keyword title on `/explorer/keyword/[id]`:

- Unwatched: outlined-star icon + text "Watch"
- Watched: filled gold star + text "Watching"
- Click triggers optimistic UI flip → POST or DELETE → revert + inline error on failure
- At cap, the 409 from POST surfaces as an inline error: "You've watched 100 keywords. Remove one to add more." with a link to `/watchlist`

Component: `app/(app)/_components/WatchToggle.tsx` — client component, takes `keywordId` and `initialIsWatched` props.

### 5.3 Explorer ⭐ column

A new leftmost column in `app/explorer/ResultsTable.tsx`:

- Header: star icon only (no text — saves horizontal space). Tooltip: "Click to add/remove from watchlist".
- Cells: `<WatchStar>` client component, `★` if watched else `☆`. Click toggles via POST/DELETE with optimistic UI.
- The star is the only interactive element in that cell; clicking the rest of the row still navigates to the detail page as today.
- **Not sortable in v1.** Sort-by-watched would push the watched set into the SQL `runExplorerQuery`, complicating the query for marginal value.

Component: `app/(app)/_components/WatchStar.tsx` — shared between the explorer table and the watchlist page (which also has stars-as-remove-buttons).

### 5.4 `/watchlist` page

Layout: same `(app)` route-group layout, no other chrome.

Body:
```
Watchlist
12 of 100 keywords watched

Window: [Week ▾]      ← only filter

[ResultsTable with ⭐, keyword, rank, Δ, est. volume, ..., Added]
```

- Reuses `ResultsTable` verbatim with the existing columns
- Plus one new column: **"Added"** showing relative time (`addedAt` formatted as "2d ago"). Sortable.
- ⭐ column on this page acts as a remove button; clicking flips to ☆ briefly then animates the row out
- Window selector at the top, URL-driven: `/watchlist?window=4w`
- Empty state: "You're not watching any keywords yet. ⭐ Star a keyword from the explorer or its detail page to start watching."
- Inactive keywords (watched, but fell out of weekly rankings) render with the same grayed-out treatment `ResultsTable` already gives inactive keywords in the explorer, plus a "Last seen: 3w ago" hint in the Δ column.

### 5.5 Tab-nav count badge

The watchlist tab in the shared layout shows the current count: `Watchlist (12)`. The count comes from the same `listWatchlistForUser` query that other surfaces need. Free signal, helps discoverability.

## 6. Data flow

### 6.1 Adding a keyword (explorer ⭐ click)

1. User clicks ☆ in a row
2. Client optimistically flips to ★
3. `fetch POST /api/watchlist/items { keywordId }`
4. On success: nothing further (UI already updated)
5. On 409 cap-reached: revert UI + show toast "You've watched 100 keywords. Remove one to add more." with a link to /watchlist
6. On other error: revert UI + show toast "Couldn't save — try again"
7. Optional: call `router.refresh()` in the background to update the tab-nav count badge (cheap, doesn't affect current view)

### 6.2 Removing a keyword from the watchlist page

1. User clicks ★ on a row
2. Client optimistically flips to ☆ and starts a brief fade-out
3. `fetch DELETE /api/watchlist/items/[keywordId]`
4. On success: remove row from local state, decrement count
5. On error: cancel animation, restore ★, show error toast

### 6.3 Initial page renders

Each of `/explorer`, `/explorer/keyword/[id]`, `/watchlist` independently calls `listWatchlistForUser(user.id)` in its server component. The query is small (≤100 IDs); the per-page-load cost is acceptable. No caching layer needed in v1.

## 7. Error handling

| Failure | Behavior |
|---|---|
| Unauthenticated request to API | 401, redirect to /sign-in via middleware |
| Invalid UUID in body or URL | 400 |
| keyword_id not found in `search_terms` | 404 |
| Cap reached on POST | 409 with `{ error: "watchlist_at_cap" }` |
| Duplicate POST (already watching) | 200, treated as success |
| DELETE of non-existent row | 200, treated as success |
| Other server error | 500, generic error toast |

Idempotency on both POST and DELETE means optimistic UI can never desync the server permanently — the next deliberate action resolves any drift.

## 8. Auth model

- All API routes use the same `requireAuthenticatedUser` helper that saved views use
- All UI surfaces are inside the `(app)` route group which auth-gates at the layout
- No watchlist UI is rendered for guests (no star icons, no tab in the nav)

## 9. Testing approach

- **API route tests** (Vitest):
  - Auth required (401 without session)
  - POST is idempotent (second call to same keyword returns 200)
  - DELETE is idempotent (deleting nothing returns 200)
  - 409 at cap
  - 404 when keyword_id doesn't exist
  - Ownership enforced on DELETE (user A can't delete user B's watchlist item — returns 200 with no-op since the row doesn't match `(B.id, keywordId)`, never 200 with confirmation of existence)
- **Unit tests:**
  - `listWatchlistForUser` returns the user's items, newest first
  - Cap-counting helper used by POST
- **Manual smoke test** through the toggle + page flows. Same approach saved views shipped with.

## 10. Out of scope (deferred, not blocked)

| Item | Future plan / note |
|---|---|
| Email notifications / weekly digest of watched-keyword changes | Separate plan. Schema is shaped so a future `notify_on_change boolean` column slots in cleanly. |
| **CSV bulk-upload of keywords to watchlist** | Future enhancement. Will add `POST /api/watchlist/items/bulk` and a paste/upload UI on `/watchlist`. Most likely Plan 3.4.3. |
| Named lists / multiple watchlists per user | Schema is shaped so adding `list_id` is a `+1 column` migration. |
| Bulk add from explorer (multi-select rows + "Watch 5 selected") | Per-row star covers the common case; defer until we see demand. |
| In-watchlist filtering | Explicit deferral from Plan 3.4.1. |
| Sharing watchlists across users | Out of scope; same private-only model as saved views. |
| Sort-by-watched in the explorer | Would require pushing watched-set into SQL query. Defer. |

## 11. File inventory (preview — full file list in implementation plan)

New files:
- `db/migrations/0032_watchlist_items.sql`
- `db/schema/watchlistItems.ts`
- `lib/watchlist/types.ts`
- `lib/watchlist/loadServer.ts` (server-only — `listWatchlistForUser`, `watchlistCountForUser`)
- `lib/watchlist/validation.ts` (`MAX_WATCHED_KEYWORDS = 100`)
- `app/api/watchlist/items/route.ts` (GET + POST)
- `app/api/watchlist/items/[keywordId]/route.ts` (DELETE)
- `app/(app)/layout.tsx` (new shared layout with tab nav)
- `app/(app)/_components/WatchToggle.tsx` (detail-page toggle)
- `app/(app)/_components/WatchStar.tsx` (table-cell star)
- `app/(app)/_components/TabNav.tsx` (Explorer | Watchlist tabs)
- `app/watchlist/page.tsx`
- `app/watchlist/AddedColumn.tsx` (or similar — the new "Added" column logic)

Modified files:
- `app/explorer/layout.tsx` — shrunk to render only saved-views row
- `app/explorer/page.tsx` — load watchlist set, pass to ResultsTable
- `app/explorer/ResultsTable.tsx` — add ⭐ column conditionally
- `app/explorer/keyword/[id]/page.tsx` — load isWatched, render `<WatchToggle>` in header
- `db/schema/index.ts` — export the new table

## 12. Acceptance criteria

- [ ] Authenticated user can click ⭐ on the detail page to add/remove a keyword; UI reflects state instantly
- [ ] Same toggle works from the ⭐ column on the explorer results table without leaving the explorer
- [ ] `/watchlist` page lists the user's watched keywords with all the explorer's columns plus "Added"
- [ ] Column sort works on `/watchlist` exactly as it does on the explorer
- [ ] Removing from `/watchlist` removes the row immediately
- [ ] Adding a 101st keyword shows a clear cap-reached error with a link to manage the list
- [ ] Tab nav shows `Watchlist (N)` and updates after toggles
- [ ] Inactive keywords are rendered grayed out, same as in the explorer
- [ ] Empty-state copy renders when the user has 0 watched keywords

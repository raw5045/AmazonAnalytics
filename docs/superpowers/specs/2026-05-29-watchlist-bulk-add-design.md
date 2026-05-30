# Watchlist Bulk Add — Design Spec

Date: 2026-05-29
Owner: Reese
Status: Ready for implementation planning (Plan 3.4.3)
Predecessor: Plan 3.4.2 (Watchlist)

## 1. Summary

Add a paste-and-go bulk-add affordance to `/watchlist` so users can drop in a newline-separated list of keywords and have all of them added to their watchlist in one action. Matched keywords are inserted; unmatched, already-watching, and cap-overrun cases are surfaced in a single-line result message. No file upload, no modal, no structured result sections — these were considered and explicitly cut as overkill for the 100-keyword cap.

This is the simplified replacement for the originally-proposed Plan 3.4.3 (CSV bulk upload). Substantively the same outcome at ~half the implementation effort.

## 2. Decisions locked

| Area | Decision |
|---|---|
| Matching strategy | Normalized — uses existing `normalizeForMatch()` against `search_terms.search_term_normalized` (already indexed) |
| Input format | Newline-separated only (no comma splitting) |
| Cap-overrun behavior | Best-effort — add what fits in input order, report the rest |
| Order of processing | First-in-input-order (predictable; user can paste in priority order) |
| Dedup | By normalized form, before processing |
| All-whitespace lines | Silently skipped |
| Hard max input size | 500 lines (server-side guard; 5x the watchlist cap) |
| UI surface | Inline `<details>` collapsible on `/watchlist` between header and table |
| Result format | Single line, middot separators, quoted inline list for unmatched |
| At-cap UX | Textarea disabled with inline message; `<details>` still renders |
| Schema change | None — reuses `watchlist_items` |
| Notifications hookup | Out of scope (still deferred from Plan 3.4.2) |

## 3. Matching strategy

The codebase already has the right primitive: `normalizeForMatch(s)` in `lib/analytics/derivedFields.ts`. The pipeline is NFC → NFKC → lowercase → drop apostrophes → keep only letters/numbers/whitespace → collapse whitespace → trim. The `search_terms` table stores the normalized form in `search_term_normalized` with a unique index, so a bulk `WHERE search_term_normalized IN (...)` lookup is fast.

The matching helper:

1. For each input line, compute `normalizeForMatch(line)`. Remember the original (display) form for each normalized key.
2. Drop empty normalized keys (handles all-whitespace lines).
3. Dedupe by normalized key. When deduping, keep the first display form encountered (so the user sees their first version of the spelling in any unmatched output).
4. Query `search_terms` once: `SELECT id, search_term_normalized FROM search_terms WHERE search_term_normalized = ANY($1::text[])`.
5. Map matched normalized keys → `keyword_id`. The unmatched bucket is everything not returned.

## 4. Data model

No new tables, no new columns. Reuses:

- `search_terms.search_term_normalized` (already indexed)
- `watchlist_items` (composite PK on `(user_id, keyword_id)` — already gives us idempotency for free)
- 100-keyword cap (`MAX_WATCHED_KEYWORDS`) — enforced at the API layer, same as the single POST endpoint

## 5. API

### `POST /api/watchlist/items/bulk`

**Auth:** required (same `requireAuthenticatedUser` + `handleAuthError` pattern as the existing watchlist routes).

**Request body:**
```ts
{ keywords: string[] }
```

**Response 200:**
```ts
{
  added: number;              // newly inserted rows
  alreadyWatching: number;    // input matched a keyword already in this user's watchlist
  unmatched: string[];        // input lines (display form) that didn't match any search_term
  skippedAtCap: number;       // matched but the cap was reached before insert
}
```

**Response 400 cases:**
- `keywords` missing or not an array → generic 400
- `keywords.length > 500` → `{ error: "too_many_keywords" }`

**Response 401:** auth failure (consistent with the existing watchlist endpoints).

**Server flow:**

1. Auth gate + body validation (≤ 500 entries).
2. Build the normalized-input pipeline (see §3): produces a `Map<normalizedKey, displayForm>` plus an `inputOrder: string[]` (the normalized keys in original input order).
3. Match query — one indexed lookup. Builds `Map<normalizedKey, keywordId>` for the matches; `unmatched` is `inputOrder` minus matches' keys, mapped back to display form.
4. Look up which matched keywordIds are already in `watchlist_items` for the current user. Split into `toInsert` (in input order) and `alreadyWatching`.
5. Cap check: load `currentCount = watchlistCountForUser(user.id)`. If `currentCount + toInsert.length > MAX_WATCHED_KEYWORDS`, slice `toInsert` to `MAX_WATCHED_KEYWORDS - currentCount` entries and move the rest into `skippedAtCap`.
6. `INSERT ... ON CONFLICT DO NOTHING` for the survivors. (`ON CONFLICT` handles a vanishingly rare race where a parallel single-add lands between step 4 and 6.)
7. Return the counts + unmatched display list.

**Race condition:** the non-transactional cap check matches the precedent set by the single POST endpoint in Plan 3.4.2 — acceptable for the single-user use case.

## 6. UI surface

### Layout on `/watchlist`

```
Watchlist
12 of 100 keywords watched         Window: [Week ▾]

▾ Add keywords — one per line
  ┌──────────────────────────────────────────────────┐
  │ wireless earbuds                                 │
  │ airpods case                                     │
  │                                                  │
  └──────────────────────────────────────────────────┘
  [ Add to watchlist ]
  ✓ 2 added                       ← result, if any

  [ResultsTable rows]
```

### Component

`app/(app)/watchlist/BulkAddSection.tsx` — `'use client'`.

Props:
```ts
{ currentCount: number }   // for the at-cap state
```

Internal state:
- `text: string` — textarea value
- `submitting: boolean` — disables the button during the in-flight POST
- `result: BulkAddResult | { error: string } | null` — last submission's outcome (or null on initial render)

Behavior:
- Renders a native `<details>` element. The `<summary>` contains the disclosure arrow and `Add keywords — one per line`. Closed by default.
- If `currentCount >= MAX_WATCHED_KEYWORDS`: textarea is disabled, inline message reads `You're at the 100-keyword limit. Remove some to add more.` Button is not rendered.
- Otherwise: textarea is enabled, button is enabled when `text.trim().length > 0` and not `submitting`.
- On submit: split `text` on `\n`, trim each line, drop empties. POST. On success: clear textarea, render result message, call `router.refresh()`. On error: render `× Couldn't save — try again.`, leave textarea content intact.

### Result message rendering

Built by composing parts, joined by ` · `:

- `✓ N added` (always present; N = `result.added`)
- `M already watching` (only if `result.alreadyWatching > 0`)
- `K didn't match: "foo", "bar"` (only if `result.unmatched.length > 0`; each entry wrapped in straight double quotes)
- `J skipped (at 100-keyword limit)` (only if `result.skippedAtCap > 0`)

Error variant (for HTTP failures): `× Couldn't save — try again.` Red text.

### Modifying `app/(app)/watchlist/page.tsx`

- Compute `currentCount = items.length` before rendering.
- Render `<BulkAddSection currentCount={currentCount} />` between the header row and the `<WatchlistTable>` block.

## 7. Server helper

`lib/watchlist/bulkAdd.ts` — server-only. Exports:

```ts
interface BulkAddResult {
  added: number;
  alreadyWatching: number;
  unmatched: string[];
  skippedAtCap: number;
}

export async function bulkAddToWatchlist(
  userId: string,
  inputKeywords: string[],
): Promise<BulkAddResult>;
```

This is the testable unit — `route.ts` is a thin wrapper around it. Tests cover §3's matching logic + §5 steps 4–6.

## 8. Error handling

| Failure | Server response | UI |
|---|---|---|
| Unauthenticated | 401 | (page would already be redirected; not user-visible) |
| Missing or wrong-shape body | 400 generic | `× Couldn't save — try again.` |
| `keywords.length > 500` | 400 `{ error: "too_many_keywords" }` | `× Too many keywords (max 500). Paste a smaller list.` |
| DB error during query/insert | 500 | `× Couldn't save — try again.` |
| Network error client-side | (no response) | `× Couldn't save — try again.` |

The size-limit error gets a distinct user-facing message since it's actionable; everything else collapses to the generic retry message.

## 9. Testing approach

**Unit tests on `lib/watchlist/bulkAdd.ts`** (Vitest, mock DB):
- All-match case returns correct counts
- Mixed match/unmatched → unmatched bucket contains the expected display strings (in input order)
- Cap overrun → `toInsert` is sliced in input order, surplus appears in `skippedAtCap`
- Duplicates in input deduped by normalized form before processing; first display form wins
- Already-watching keyword in input lands in `alreadyWatching`, not `added`
- Empty input → all-zero result, no DB calls (early return)
- 501 input → throws (route translates to 400)

**Manual smoke test** of the UI flow on `/watchlist`:
- Paste 5 fresh keywords → all added, message renders, rows appear after refresh
- Paste 5 same keywords again → `5 already watching`
- Paste 3 typos → all unmatched, quoted in the result
- Paste 5 keywords when at 98 watched → `2 added · 3 skipped (at limit)`
- Reach exactly 100 → textarea disabled, inline at-cap message visible

## 10. Out of scope (deferred or never)

| Item | Reason |
|---|---|
| File upload (`.csv`, `.txt`) | Explicitly cut; paste covers the 100-keyword workflow |
| Modal-based UX | Inline `<details>` is enough at this scale |
| Live preview of "X detected · Y duplicates · Z slots remaining" while typing | Adds state plumbing for marginal value |
| Structured multi-section result display (separate added / unmatched / skipped panels) | Single-line middot result is enough |
| "Did you mean…?" fuzzy suggestions for unmatched | Out of scope; the explorer typeahead is where users find spellings |
| Bulk REMOVE (the inverse) | Not requested; per-row ⭐ handles single removals |
| Audit log of bulk operations | YAGNI |
| Email notifications when a watched keyword changes | Separate plan (still deferred from Plan 3.4.2) |

## 11. File inventory

**New files:**
- `app/api/watchlist/items/bulk/route.ts` — POST endpoint
- `lib/watchlist/bulkAdd.ts` — server helper (matching + cap logic)
- `lib/watchlist/bulkAdd.test.ts` — Vitest unit tests
- `app/(app)/watchlist/BulkAddSection.tsx` — client component

**Modified files:**
- `app/(app)/watchlist/page.tsx` — render `<BulkAddSection currentCount={items.length} />` between header and `<WatchlistTable>`

## 12. Acceptance criteria

- [ ] User can paste N newline-separated keywords into the textarea and click Add
- [ ] Matched keywords appear in `/watchlist` table after refresh; tab-nav badge updates
- [ ] Result message renders correct counts for each category present
- [ ] Pasting 100 keywords starting from 0 watched → all added if all match
- [ ] Pasting 30 keywords when at 80 watched → 20 added, 10 in `skippedAtCap`
- [ ] Pasting `shoes / Shoes / SHOES` → deduped to one entry
- [ ] User at exactly 100 watched sees the disabled textarea + at-cap message
- [ ] Re-submitting the same paste is a clean no-op (`alreadyWatching` matches input count, `added` is 0)
- [ ] Pasting 501 lines returns the size-limit error message
- [ ] Generic server errors render the red "Couldn't save — try again" text without losing the textarea content

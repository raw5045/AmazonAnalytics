# Keywords Tab Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user-facing mention of the keyword table says "Keywords" (the tab) or "the Keywords tab" (prose); the `/explorer` URL, identifiers, keys, metrics and the MCP field `explorerUrl` stay (spec `docs/superpowers/specs/2026-10-21-keywords-tab-rename-design.md`).

**Architecture:** Copy-only change: exact-string edits in 14 source files and 6 test files, `GUIDE_VERSION` 6 → 7 so AI clients re-read the research guide. No route, schema, storage or env change. The tree mixes CRLF and LF, so edits are byte-exact and EOL-preserving (a Python script that reads and writes bytes, asserting each pattern's match count).

**Tech Stack:** Next 16 app router pages, vitest + RTL, zod `.describe` strings (MCP), Python 3 for the edit script (`python -I`).

---

### Task 1: The copy edits, their tests, the gate, one commit

**Files:**
- Modify: `app/(app)/TabNav.tsx` (CRLF), `app/(app)/explorer/page.tsx`, `app/not-found.tsx`, `app/(app)/ask/Thread.tsx` (CRLF), `app/(app)/products/ProductFilterPanel.tsx`, `app/(app)/explorer/keyword/[id]/BackToExplorer.tsx`, `app/(marketing)/help/page.tsx`, `app/(marketing)/page.tsx` (CRLF), `app/(marketing)/pricing/page.tsx` (CRLF), `lib/research/catalog.ts` (CRLF), `lib/research/contracts.ts` (CRLF), `lib/workspace/explorerFilters.ts`, `lib/workspace/tools.ts`, `docs/marketing/keywordquarry-product-profile.md`
- Test: `app/(app)/TabNav.test.tsx` (CRLF), `app/(app)/ask/Thread.test.tsx` (CRLF), `app/(app)/products/ProductFilterPanel.test.tsx`, `lib/workspace/explorerFilters.test.ts`, `lib/research/contracts.test.ts`, `lib/research/catalog.test.ts`, `app/(app)/explorer/keyword/[id]/BackToExplorer.test.tsx`, `lib/research/service.test.ts` (the last two surfaced by the full-suite gate: the lowercase back-link label and the search provenance's guideVersion pin)

- [ ] **Step 1: Update the tests first (they pin the old wording)**

Exact replacements (old → new), each occurring once unless noted:

| File | Old | New |
|---|---|---|
| `app/(app)/TabNav.test.tsx` | `{ name: 'Explorer' }` | `{ name: 'Keywords' }` |
| | `['Explorer', 'Watchlist', 'Category Builder', 'Ask AI', 'Connect AI', 'Tutorials']` | `['Keywords', 'Watchlist', 'Category Builder', 'Ask AI', 'Connect AI', 'Tutorials']` |
| | `['Explorer', 'Products', 'Watchlist', 'Category Builder', 'Ask AI', 'Connect AI', 'Tutorials']` | `['Keywords', 'Products', 'Watchlist', 'Category Builder', 'Ask AI', 'Connect AI', 'Tutorials']` |
| | `between Explorer and Watchlist` | `between Keywords and Watchlist` |
| | `and Explorer is not` | `and Keywords is not` |
| | `the Explorer tab` (×3) | `the Keywords tab` |
| | `the Explorer memory` | `the Keywords memory` |
| | `switching to the Explorer and back` | `switching to the Keywords tab and back` |
| `app/(app)/ask/Thread.test.tsx` | `Same data as the Explorer, answered in plain language.` | `Same data as the Keywords tab, answered in plain language.` |
| `app/(app)/products/ProductFilterPanel.test.tsx` | `as on the Explorer; one per product` | `as on the Keywords tab; one per product` |
| | `in the Explorer's order` | `in the Keywords tab's order` |
| `lib/workspace/explorerFilters.test.ts` | `than the Explorer can export or refine` | `than the Keywords tab can export or refine` |
| `lib/research/contracts.test.ts` | `(the Explorer's broad categories)` | `(the Keywords tab's broad categories)` |
| `lib/research/catalog.test.ts` | `expect(GUIDE_VERSION).toBe(6);` | `expect(GUIDE_VERSION).toBe(7);` |
| | `expect(off.guideVersion).toBe(6);` | `expect(off.guideVersion).toBe(7);` |
| `app/(app)/explorer/keyword/[id]/BackToExplorer.test.tsx` | `{ name: '← Back to explorer' }` (×6) | `{ name: '← Back to keywords' }` |
| `lib/research/service.test.ts` | `guideVersion: 6, queryVersion: 1` | `guideVersion: 7, queryVersion: 1` |

After this step `grep -nP "(?<![A-Za-z_])Explorer(?![A-Za-z_])" "app/(app)/TabNav.test.tsx"` prints nothing.

- [ ] **Step 2: Run the touched tests to verify they fail**

Run: `pnpm exec vitest run "app/(app)/TabNav.test.tsx" "app/(app)/ask/Thread.test.tsx" "app/(app)/products/ProductFilterPanel.test.tsx" lib/workspace/explorerFilters.test.ts lib/research/contracts.test.ts lib/research/catalog.test.ts`
Expected: failures in all six files (old wording still rendered / `GUIDE_VERSION` still 6).

- [ ] **Step 3: Make the source edits**

| File | Old | New |
|---|---|---|
| `app/(app)/TabNav.tsx` | ` * Top-level navigation: Explorer \| Products` | ` * Top-level navigation: Keywords \| Products` |
| | the label line after `className={tabClass(isExplorer)}>`: `        Explorer` | `        Keywords` |
| `app/(app)/explorer/page.tsx` | `  title: 'Keyword Explorer',` | `  title: 'Keywords',` |
| `app/not-found.tsx` | `            Go to Explorer` | `            Go to Keywords` |
| `app/(app)/ask/Thread.tsx` | `Same data as the Explorer, answered in plain language.` | `Same data as the Keywords tab, answered in plain language.` |
| `app/(app)/products/ProductFilterPanel.tsx` | `category, as on the Explorer; one per product` | `category, as on the Keywords tab; one per product` |
| `app/(app)/explorer/keyword/[id]/BackToExplorer.tsx` | `← Back to explorer` (the label and its two doc comments) | `← Back to keywords` |
| `app/(marketing)/help/page.tsx` | `<Section title="The Explorer">` | `<Section title="The Keywords tab">` |
| | `          The Explorer is the core tool: search and filter roughly a million` | `          The Keywords tab is the core tool: search and filter roughly a million` |
| | `          The Explorer also flags keywords where none of the top 3 products` | `          The Keywords tab also flags keywords where none of the top 3 products` |
| | `          the Explorer returns only keywords from the niches you care about.` | `          the Keywords tab returns only keywords from the niches you care about.` |
| `app/(marketing)/page.tsx` | `                    Keyword Explorer` (the hero card label) | `                    Keywords` |
| `app/(marketing)/pricing/page.tsx` | `'Full Keyword Explorer — every keyword, every filter'` | `'The full Keywords tab — every keyword, every filter'` |
| `lib/research/catalog.ts` | `(spec 2026-10-14 §10). */` | `(spec 2026-10-14 §10); 7: the Explorer is named the Keywords tab throughout (spec 2026-10-21 Keywords tab rename). */` |
| | `export const GUIDE_VERSION = 6;` | `export const GUIDE_VERSION = 7;` |
| | `explorerUrl: the Explorer opened with the same filters.` | `explorerUrl: the Keywords tab opened with the same filters.` |
| | `cannot be exported or refined in the Explorer.` | `cannot be exported or refined in the Keywords tab.` |
| `lib/research/contracts.ts` | `(the Explorer's broad categories)` | `(the Keywords tab's broad categories)` |
| `lib/workspace/explorerFilters.ts` | `'The Explorer ` (×7, the NOTE_* strings) | `'The Keywords tab ` |
| | `than the Explorer can export or refine` | `than the Keywords tab can export or refine` |
| `lib/workspace/tools.ts` | `This account's saved Explorer views (up to ${MAX_VIEWS_PER_USER}): id, name, Explorer link and the stored filters` | `This account's saved views of the Keywords tab (up to ${MAX_VIEWS_PER_USER}): id, name, link and the stored filters` |
| | `as a named Explorer view: pass the same presetIds` | `as a named view of the Keywords tab: pass the same presetIds` |
| | `and notes for anything the Explorer could not carry over` | `and notes for anything the Keywords tab could not carry over` |
| | `an Explorer link` (×2, the custom-category tools) | `a Keywords tab link` |
| `docs/marketing/keywordquarry-product-profile.md` | every standalone `Explorer` except `Product Opportunity Explorer` (Amazon's tool, 3 places) and the `/explorer` URLs | `Keywords tab` |

Do them with one byte-exact Python script (`python -I`, relative paths, `open(path, 'rb')` / `'wb'`), asserting each pattern's count before replacing so a drifted file aborts instead of half-applying. Unchanged on purpose: identifiers (`isExplorer`, `NOTE_EXPLORER_REREAD`, …), the help page's video title `How the Keyword Explorer works`, the landing page comment `mini keyword explorer`, admin labels, code comments, `explorerUrl`.

- [ ] **Step 4: Verify no user-facing "Explorer" remains and the EOLs survived**

Run: `grep -rnP "(?<![A-Za-z_])Explorer(?![A-Za-z_])" app lib --include=*.ts --include=*.tsx | grep -v "\.test\." | grep -vP "^[^:]+:\d+:\s*(\*|//|/\*)"`
Expected: only `app/(marketing)/help/page.tsx` (the video title), `app/admin/keepa-enrichment/ServiceStatusCard.tsx` (two admin labels) and `lib/research/catalog.ts` (the version doc comment, which starts with `/**` on its own line).
Run: `git diff --stat` and `git ls-files --eol <each edited file> | awk '{print $2, $NF}'`
Expected: the same `w/crlf` / `w/lf` per file as before the edit; `git diff` shows only the intended lines (no whole-file churn).

- [ ] **Step 5: Run the touched tests, then the gate**

Run: the Step 2 command. Expected: 6 files pass.
Run: `pnpm exec eslint "app/(app)/TabNav.tsx" "app/(app)/explorer/page.tsx" app/not-found.tsx "app/(app)/ask/Thread.tsx" "app/(app)/products/ProductFilterPanel.tsx" "app/(app)/explorer/keyword/[id]/BackToExplorer.tsx" "app/(marketing)/help/page.tsx" "app/(marketing)/page.tsx" "app/(marketing)/pricing/page.tsx" lib/research/catalog.ts lib/research/contracts.ts lib/workspace/explorerFilters.ts lib/workspace/tools.ts "app/(app)/TabNav.test.tsx" "app/(app)/ask/Thread.test.tsx" "app/(app)/products/ProductFilterPanel.test.tsx" lib/workspace/explorerFilters.test.ts lib/research/contracts.test.ts lib/research/catalog.test.ts`
Expected: no output (clean).
Run: `pnpm exec vitest run` → Expected: all files pass (3,022 tests at 66617bb; the count is unchanged by this task).
Run: `pnpm typecheck` → Expected: exit 0.
Run: `pnpm build` → Expected: "Compiled successfully".

- [ ] **Step 6: Commit (named files only)**

```bash
git add "app/(app)/TabNav.tsx" "app/(app)/explorer/page.tsx" app/not-found.tsx "app/(app)/ask/Thread.tsx" "app/(app)/products/ProductFilterPanel.tsx" "app/(app)/explorer/keyword/[id]/BackToExplorer.tsx" "app/(marketing)/help/page.tsx" "app/(marketing)/page.tsx" "app/(marketing)/pricing/page.tsx" lib/research/catalog.ts lib/research/contracts.ts lib/workspace/explorerFilters.ts lib/workspace/tools.ts docs/marketing/keywordquarry-product-profile.md "app/(app)/TabNav.test.tsx" "app/(app)/ask/Thread.test.tsx" "app/(app)/products/ProductFilterPanel.test.tsx" lib/workspace/explorerFilters.test.ts lib/research/contracts.test.ts lib/research/catalog.test.ts
git commit -F - <<'EOF'
feat(nav): rename the Explorer tab to Keywords (URL unchanged)

Tab label, page title, 404 button, keyword-page back link, Ask AI empty
state, Products hint, help/landing/pricing copy, the MCP research guide
(GUIDE_VERSION 7), view notes and tool descriptions, and the marketing
product profile. /explorer, identifiers, storage keys, metric names and
the explorerUrl field stay (spec 2026-10-21).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

### Task 2: Ship (owner-gated)

- [ ] **Step 1:** `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` → "no live runs"; the clock is outside 03:30–06:59 ET.
- [ ] **Step 2:** On the owner's go: `git push origin main` (bare, its own call).
- [ ] **Step 3:** Watch: `gh api repos/raw5045/AmazonAnalytics/commits/<sha>/status --jq '"overall: \(.state)", (.statuses[] | "\(.context): \(.state) @ \(.updated_at)")'` → Vercel success (the worker and Keepa deploys rebuild too; nothing of theirs changed).
- [ ] **Step 4:** Smoke on keywordquarry.com: the tab reads "Keywords" and stays active on `/explorer` and a keyword page; the browser tab says "Keywords · KeywordQuarry"; the keyword page's back link reads "← Back to keywords"; `/help` section "The Keywords tab"; the 404 button; Ask AI's empty state; the Products broad-category hint; `get_research_guide` reports guideVersion 7 (the owner's connector).

## Results

| Step | Result |
|---|---|
| Task 1 gate | e7065b8 (2026-10-21): 22 files, 70 lines; six touched test files failed on the old wording then passed; the full-suite gate surfaced two more pins (BackToExplorer.test.tsx, service.test.ts) and two more tool descriptions (custom-category tools); final: 243 files / 3,022 tests green, typecheck 0, build "Compiled successfully", eslint clean on all touched files; EOLs preserved (CRLF/LF per file unchanged) |
| Push | 2026-10-21 13:59 UTC, 66617bb..8ed9438 (checkActiveJobs: 0 live runs, 0 mid-phase imports, sync 390 min old) |
| Deploys | Vercel success 14:00:45 UTC; Keepa service success 13:59:57 UTC; the Railway worker posted no status for 8ed9438 (its health endpoint shows commit 66617bb, booted 2026-10-20T11:03:14.499Z); nothing of the worker's changed in this push |
| Smoke | PASS 2026-10-21 ~14:10 UTC — owner's Chrome: /explorer title "Keywords · KeywordQuarry" + nav link "Keywords" (href /explorer), rank-1 keyword page "← Back to keywords", /ask "Same data as the Keywords tab…", /products hint "as on the Keywords tab"; curl (signed-out): landing hero card "Keywords", pricing "The full Keywords tab — every keyword, every filter", help section "The Keywords tab" (video title unchanged by decision), 404 "Go to Keywords"; get_research_guide → guideVersion 7 with the new wording. The built-in browser pane was denied keywordquarry.com, hence Chrome + curl. |

# Keywords tab rename — design

**Date:** 2026-10-21 · **Owner decision:** rename the "Explorer" tab to "Keywords" now that a "Products" tab exists; keep the `/explorer` URL.

## 1. Goal

Every place a person reads the name of the keyword table says **Keywords** (the tab) or **the Keywords tab** (in prose). Nothing stored, linked or integrated changes.

## 2. What stays exactly as it is

- The URL `/explorer` and `/explorer/keyword/<id>`, the route folders, `app/api/explorer/*`, the sign-in landing (Clerk env), the marketing redirect, saved-view hrefs (`/explorer?view=<id>`), digest/calibration email links.
- Code identifiers (`isExplorer`, `explorerHref`, `ExplorerFilters`, `runExplorerQuery`, `NOTE_EXPLORER_REREAD`, …), the localStorage keys `kw-analytics.last-explorer-url` / `-products-url`, the usage-metric names `explorer_query` / `explorer_export`, the MCP result field `explorerUrl` and the input schema shape (`SCHEMA_VERSION` unchanged).
- Admin pages (the Keepa card's "Explorer week" / "Explorer sync last fired"), admin-only emails (calibration, import), code comments that describe routes or internals, and the help page's video title "How the Keyword Explorer works" (it is the video's real title on YouTube; the owner may retitle the video later).

## 3. What changes (before → after)

| Where | Before | After |
|---|---|---|
| `app/(app)/TabNav.tsx` tab label (and its header comment) | `Explorer` | `Keywords` |
| `app/(app)/explorer/page.tsx` metadata title | `Keyword Explorer` | `Keywords` (renders "Keywords · KeywordQuarry") |
| `app/not-found.tsx` button | `Go to Explorer` | `Go to Keywords` |
| `app/(app)/ask/Thread.tsx` empty state | `Same data as the Explorer, answered in plain language.` | `Same data as the Keywords tab, answered in plain language.` |
| `app/(app)/products/ProductFilterPanel.tsx` broad-category hint | `…, as on the Explorer; …` | `…, as on the Keywords tab; …` |
| `app/(app)/explorer/keyword/[id]/BackToExplorer.tsx` back link | `← Back to explorer` | `← Back to keywords` |
| `app/(marketing)/help/page.tsx` section | title `The Explorer`; "The Explorer is the core tool…", "The Explorer also flags…", "the Explorer returns only keywords…" | title `The Keywords tab`; "The Keywords tab is the core tool…", "The Keywords tab also flags…", "the Keywords tab returns only keywords…" |
| `app/(marketing)/page.tsx` hero card label | `Keyword Explorer` | `Keywords` |
| `app/(marketing)/pricing/page.tsx` first bullet | `Full Keyword Explorer — every keyword, every filter` | `The full Keywords tab — every keyword, every filter` |
| `lib/research/catalog.ts` WORKSPACE_RULES (two rules) | "the Explorer opened with the same filters", "refined in the Explorer" | "the Keywords tab opened with the same filters", "refined in the Keywords tab"; `GUIDE_VERSION` 6 → 7 with a doc-comment entry |
| `lib/research/contracts.ts` broadCategory `.describe` | "(the Explorer's broad categories)" | "(the Keywords tab's broad categories)" |
| `lib/workspace/explorerFilters.ts` NOTE_* strings (8) | "The Explorer …" / "than the Explorer can export or refine" | "The Keywords tab …" / "than the Keywords tab can export or refine" (constant names unchanged) |
| `lib/workspace/tools.ts` list_saved_views + create_saved_view descriptions | "saved Explorer views … Explorer link", "a named Explorer view" | "saved views of the Keywords tab … link", "a named view of the Keywords tab" |
| `docs/marketing/keywordquarry-product-profile.md` | "Explorer" rows/bullets | "Keywords tab (`/explorer`)" wording, URLs unchanged |

Tests that pin the old wording follow the new text: `TabNav.test.tsx` (link name + tab-order arrays + it-names), `Thread.test.tsx`, `ProductFilterPanel.test.tsx`, `explorerFilters.test.ts` (NOTE_VIEW_TOO_WIDE pin), `contracts.test.ts` (describe pin), plus any guide-version pin.

## 4. Risk

None to data, links or integrations: this is copy only. MCP clients see new descriptions on their next tool-list refresh and re-read the guide on the version bump; nothing breaks if they do not.

## 5. Ship

Local commits → owner-gated push (checkActiveJobs first, outside 03:30–06:59 ET) → Vercel deploy → smoke: tab label, browser-tab title, 404 button, help page, Ask AI empty state, the Products hint.

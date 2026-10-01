# MCP write access (workspace tools) — design

**Status:** approved in chat 2026-09-30 (brainstorm with the owner; sections 1–6 approved one at a time). Arc 3.
**Builds on:** arc 1 (`2026-09-18-keywordquarry-research-mcp-design.md`, the five read-only research tools, live for all accounts) and arc 2 (`2026-09-28-in-app-chat-design.md`, the shared tool list in `lib/research/tools.ts`, code complete on local `main`, unshipped, Ask AI dark behind `ASK_AI_ENABLED`).
**Ships:** together with arc 2's code, with Ask AI still dark (§13).

## 1. Goal

Beta members asked for the external MCP connection to *do* things, not only read: "create filters, saved views, and custom categories". This arc adds eleven **workspace tools** to the MCP server so a member's own Claude, ChatGPT or Cursor can, with the client's approval prompt on every write:

- hand back an Explorer link for any search it just ran (a one-off filtered view, nothing saved);
- create, rename, re-filter and delete **saved views**;
- create, rename, add leaves to, remove leaves from, replace the leaves of, and delete **custom categories**;
- add keywords to and remove keywords from the **watchlist**;
- list all three, so edits and deletes can name the right item by id.

Everything a member does through these tools shows up in the app on the next page load, because the tools write the same tables the Explorer, the Category Builder and the Watchlist page read.

### 1.1 Decisions made in the brainstorm (owner)

| Question | Decision |
|---|---|
| "Create filters" means | Both: a saved view from the chat **and** a one-off Explorer link with the filters applied. |
| Custom categories | Create, edit (rename, add/remove/replace leaves) **and delete**. "Easy to have the AI remake one if it deletes one." |
| Watchlist | Add **and** remove. |
| Where the write tools ship | External MCP only. The in-app Ask AI chat stays read-only this arc (it has no approval step yet). |
| Audience | All members at launch, behind a kill switch. Owner smoke-tests right after the deploy. |
| Scopes | **One scope** (the existing `keywordquarry:research:read`). No Clerk changes, nobody reconnects. A separate write scope can be added later if read-only connections are ever wanted, at the cost of a one-time reconnect then. |
| Confirmation model | The clients' own prompts. Claude asks before any tool that is not marked read-only (Allow once / Allow always / disable per tool); ChatGPT developer mode requires confirmation for write actions and auto-approves `readOnlyHint: true`; Cursor asks by default. So: correct annotations per tool, no extra handshake of ours. |
| Ship order | Arc 3 is built on top of arc 2 (the shared tool list arc 3 extends does not exist on `origin/main`). Both ship together with `ASK_AI_ENABLED` unset; migration 0048 is applied at push time; the owner finishes the Ask AI launch steps later. |

### 1.2 Non-goals

- No write tools in the in-app Ask AI chat (needs an approve/deny card in the thread and turn pause/resume; a later arc).
- No new OAuth scope; no per-connection read-only mode.
- No new tables, columns or indexes. **No DDL in this arc.**
- No bulk "plan"/batch tool; no preview/dry-run handshake of our own.
- No changes to the Explorer, Category Builder or Watchlist pages.
- No reverse translation of stored Explorer filters back into research filters (list tools return the stored Explorer filters, compacted).
- No admin UI; the abuse digest gains one counter, nothing more.

## 2. Surfaces and gating

- **Kill switch:** `MCP_WRITE_ENABLED` (Vercel env var). `mcpWriteEnabled()` in `lib/mcp/config.ts` returns `env.MCP_WRITE_ENABLED === '1'`, same pattern as `mcpEnabled()`. Declared in `lib/env.ts`'s `serverSchema` as `z.string().optional()`. Vercel applies an env change to the next deployment only, so switching the flag either way means redeploying (final review, 2026-10-01).
- With the flag **off**: the eleven tools are not registered (so `tools/list` does not show them), the guide omits its workspace section, the MCP `instructions` string omits its workspace sentence, `search_keywords` still returns `explorerUrl` (it is read-only and harmless), and the Connect AI page keeps its read-only wording and examples.
- With the flag **on**: all of the above turn on for every account the MCP already admits (`MCP_AUDIENCE`, connection status and the client allowlist are unchanged and still checked at the door in `lib/mcp/handler.ts`).
- **Ask AI** (`lib/ask/tools.ts`) keeps building from `RESEARCH_TOOLS` only. The workspace tools live in a separate list (`WORKSPACE_TOOLS`), so nothing leaks into the chat. Parity tests: MCP lists research + workspace (flag on) or research only (flag off); the chat always lists the five research tools.
- **Scope:** unchanged. `withMcpAuth` keeps `requiredScopes: [MCP_SCOPE]`; no per-tool scope check.

## 3. The tools

All names are snake_case like the research tools. "Read-only" tools carry `READ_ONLY_ANNOTATIONS` (`readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`) and `requiresConfirmation: false`. Every write tool carries `readOnlyHint: false`, `openWorldHint: false` and `requiresConfirmation: true` (the field arc 2 reserved for the in-app chat; nothing reads it yet, the MCP clients prompt from the annotations).

| Tool | Annotations beyond read-only | Input (zod, strict) | Returns |
|---|---|---|---|
| `list_saved_views` | read-only | `{}` | `{ views: [{ id, name, explorerUrl, filters, leafCount, previewComplete, createdAt, updatedAt }], count, limit: 5 }` — `filters` is the stored Explorer filter set, compacted (§5.5); its `leafPaths`, when present, is a preview of the first 20 of `leafCount` (added 2026-09-30 after the Task 8 code review: a department-wide view would otherwise echo up to 2,000 paths per view) |
| `list_custom_categories` | read-only | `{}` | `{ categories: [{ id, name, leafCount, previewPaths, previewComplete, explorerUrl, createdAt, updatedAt }], count, limit: 25 }` — `previewPaths` = first 20 stored paths, `previewComplete` = leafCount ≤ 20 |
| `list_watchlist` | read-only | `{}` | `{ items: [{ searchTermId, keyword, keywordUrl, addedAt }], count, limit: 100 }`, newest first |
| `create_saved_view` | `destructiveHint: false, idempotentHint: false` | `{ name, search }` | `{ view: { id, name, explorerUrl, filters, leafCount, previewComplete }, notes }` — `notes` are the converter's notes plus `NOTE_VIEW_TOO_WIDE` when the stored filters would exceed the link cap (§5.6) |
| `update_saved_view` | `destructiveHint: true, idempotentHint: true` (it replaces the stored filters wholesale; MCP defines `destructiveHint: false` as additive-only — changed 2026-09-30 after the Task 7 code review) | `{ id, name?, search? }` (at least one of `name`, `search`) | same as create |
| `delete_saved_view` | `destructiveHint: true, idempotentHint: true` | `{ id }` | `{ deleted: { id, name } }` |
| `create_custom_category` | `destructiveHint: false, idempotentHint: false` | `{ name, categories }` | `{ category: { id, name, leafCount, previewPaths, previewComplete, explorerUrl }, notes }` |
| `update_custom_category` | `destructiveHint: true, idempotentHint: true` (replace and remove drop leaves; same reasoning) | `{ id, name?, categories?, leafMode: 'replace' \| 'add' \| 'remove' (default 'replace') }` (at least one of `name`, `categories`) | same as create |
| `delete_custom_category` | `destructiveHint: true, idempotentHint: true` | `{ id }` | `{ deleted: { id, name, leafCount } }` |
| `add_to_watchlist` | `destructiveHint: false, idempotentHint: true` | `{ keywords?: string[], searchTermIds?: string[] }` (1–100 items combined) | `{ added, alreadyWatching, unmatched: string[], skippedAtCap, watching, limit: 100 }` |
| `remove_from_watchlist` | `destructiveHint: true, idempotentHint: true` | `{ keywords?: string[], searchTermIds?: string[] }` (1–100 items combined) | `{ removed, notWatching, unmatched: string[], watching, limit: 100 }` |

Field rules:

- `name`: string, trimmed, 1–80 characters (the app's `validateName` on both surfaces). Unique per account: saved-view names exactly, custom-category names ignoring case. Names are labels, never keys.
- `id`: UUID (`z.uuid().toLowerCase()` — clients may send uppercase, Postgres returns lowercase, so the schema lowercases; the research schema's custom-selection id gets the same treatment in Task 9), always the caller's own row. **Edits and deletes take ids only**; the AI gets them from the list tools, from a create result, or (watchlist) from search rows.
- `search`: the `search_keywords` input minus `cursor` — `{ schemaVersion?, presetIds?, filters?, sort?, comparisonWindow?, pageSize? }`, built as `z.strictObject(searchToolInputSchema.omit({ cursor: true }).shape)`; `pageSize` is accepted and ignored (a model that copies its search arguments verbatim must not be bounced with "Unrecognized key"; a saved view has no page size — nits pass 2026-09-30, from the Task 10 code review; the first design omitted it). The field's description and the create/update descriptions say "never a cursor; pageSize is accepted and ignored". A `cursor` key is rejected by the strict schema; the description says "pass the criteria you searched with, never a cursor".
- `categories`: exactly `filters.categories` from the research schema (`categoriesSchema`: `selections` ≤ 25 of `{ kind: 'taxonomy', path, includeDescendants }` or `{ kind: 'custom', id }`, plus `leafPaths` ≤ 2000 exact terminal paths). Refined: at least one selection or leaf path.
- `keywords`: plain keyword text, trimmed, 1–512 characters each, matched through the same normalized lookup the Watchlist page's paste box uses (`normalizeForMatch` + `search_terms.search_term_normalized`). `searchTermIds`: UUIDs from search rows. An unknown id or unmatched text goes into `unmatched` as the string the caller passed.
- `explorerUrl` values are absolute, built from `env.APP_PUBLIC_URL` like `keywordUrlFor`: a saved view is `${appUrl}/explorer?view=${id}`; a custom category is `${appUrl}/explorer?custom=${id}` (the Explorer expands `custom` ids itself); a search link is §5.6.
- `notes: string[]` is always present on create/update results (empty when nothing was dropped or approximated). The guide tells the AI to relay every note to the member.

### 3.1 Tool descriptions

One or two plain sentences each, in the style of the research tools: what it does, what it returns, and, for writes, "Clients normally ask the person before this runs." ("normally": a member can choose Always allow, and some clients auto-run) Descriptions are what Claude and ChatGPT show in the approval prompt, so no schema sketches and no jargon. Delete descriptions say the deletion is permanent; `remove_from_watchlist` says removal is not.

### 3.2 `search_keywords` gains a link

`SearchResponse` gains two fields, always present:

- `explorerUrl: string | null` — the Explorer opened with the same filters, sort and window (§5), or `null` when the link would be too long (§5.6);
- `explorerNotes: string[]` — what the link could not carry, or why it is null. Empty when the link is exact.

Computed once per `search()` call in `lib/research/service.ts` after `resolveScope` (the expanded `scope.leaves` are in hand there) and included in every `build()` attempt; it counts toward `maxPayloadBytes` like everything else. The in-app Ask AI chat receives the same field in its tool results and may show it as an internal link (`AnswerMarkdown` already allows same-origin links). No change to `search_keywords`'s input.

## 4. Module layout

New:

| File | Responsibility |
|---|---|
| `lib/workspace/contracts.ts` | zod input schemas (strict), TypeScript response types and the `WorkspaceService` interface for the eleven tools; `WORKSPACE_TOOL_NAMES`. (The interface lives here, not in service.ts, so tools.ts never imports the service's runtime.) |
| `lib/workspace/tools.ts` | `WORKSPACE_TOOLS: ReadonlyArray<WorkspaceToolDefinition>` — name, title, description, schema, annotations, `requiresConfirmation`, `run(service, actor, args)`. Same frozen-definition discipline as `RESEARCH_TOOLS`. |
| `lib/workspace/service.ts` | implements `WorkspaceService` (one method per tool): `createWorkspaceService(deps)`, `defaultWorkspaceService()` singleton, `resetWorkspaceServiceForTests()`. Order per call: validate → reserve (per-minute bucket) → daily write cap (writes only) → command → record. |
| `lib/workspace/explorerFilters.ts` | The converter (§5): `toExplorerFilters(input)`, `explorerUrlFor(appUrl, filters)`, `compactExplorerFilters(filters)`, `savedViewUrlFor(appUrl, id)`, `customCategoryUrlFor(appUrl, id)`. Pure; no I/O. |
| `lib/workspace/examples.ts` | The three workspace example prompts for the Connect AI page (§9.3). |
| `lib/mcp/tools/registerWorkspaceTools.ts` | Registers `WORKSPACE_TOOLS` on the `McpServer`, same thin adapter as `registerResearchTools.ts` (`actorFromContext`, `runTool`, `outputSchema: anyObject`). |
| `lib/savedViews/commands.ts` | Shared saved-view commands (§6.1), used by the API routes and the workspace service. |
| `lib/customCategories/commands.ts` | Shared custom-category commands (§6.2). |
| `lib/watchlist/commands.ts` | `addToWatchlist` / `removeFromWatchlist` by text and/or id (§6.3); `bulkAddToWatchlist` becomes a thin wrapper. |

Changed:

| File | Change |
|---|---|
| `lib/research/tools.ts` | A generic base so both lists share one shape: `ToolAnnotations` (four booleans) and `ToolDefinition<TService, TName>` (`name`, `title`, `description(limits)`, `inputSchema: z.ZodObject<z.ZodRawShape>`, `run(service, actor, args)`, `annotations: ToolAnnotations`, `requiresConfirmation: boolean`). `ResearchToolDefinition` keeps its literal types (`annotations: typeof READ_ONLY_ANNOTATIONS`, `requiresConfirmation: false`). `READ_ONLY_ANNOTATIONS` is reused by the three list tools. |
| `lib/research/contracts.ts` | `SearchResponse.explorerUrl`, `SearchResponse.explorerNotes`; `GuideResponse.workspace?` (§9.1). |
| `lib/research/service.ts` | `search()` computes `explorerUrl`/`explorerNotes`; `guide()` passes `workspace: actor.channel === 'mcp' && mcpWriteEnabled()` to `buildGuide`. |
| `lib/research/catalog.ts` | `GUIDE_VERSION = 2`; `buildGuide` takes `workspace: boolean` and emits the workspace section. |
| `lib/research/errors.ts` | New codes `LIMIT_REACHED`, `DUPLICATE_NAME`, `NOT_FOUND` (§7). |
| `lib/research/limits.ts` | `writesPerDay: 200`, overridable via `RESEARCH_LIMITS_JSON`. |
| `lib/research/usage.ts` | unchanged API; the workspace service calls `reserveResearchRequest` with `rows: 0` and `recordResearchActivity(userId, 0, 'mcp')`. |
| `lib/activity/bump.ts` | `UserActivityMetric` gains `'mcp_write'`. |
| `lib/mcp/config.ts` | `mcpWriteEnabled()`. |
| `lib/mcp/handler.ts` | Registers workspace tools when `mcpWriteEnabled()`; `instructions` gains its workspace sentence under the same condition. |
| `lib/env.ts` | `MCP_WRITE_ENABLED`. |
| `app/api/explorer/saved-views/route.ts`, `[id]/route.ts` | Delegate to `lib/savedViews/commands.ts`; identical status codes, messages and bodies (§6.4). |
| `app/api/category-builder/custom/route.ts`, `[id]/route.ts` | Delegate to `lib/customCategories/commands.ts`; identical behaviour. |
| `lib/watchlist/bulkAdd.ts` | `bulkAddToWatchlist(userId, keywords)` delegates to `addToWatchlist`; its result shape and the bulk route are unchanged. |
| `lib/watchlist/loadServer.ts` | `listWatchlistWithKeywords(userId)` (join `search_terms.search_term_raw`). |
| `lib/customCategories/loadServer.ts` | `loadCustomCategoryForUser(userId, id)`. |
| `lib/notifications/abuseDigest/*` | `mcpWrites` counter, column and amber flag (§8.4). |
| `app/(app)/connect-ai/page.tsx`, `ExampleQuestions.tsx` | Flag-dependent intro sentence and the three extra prompts (§9.3). |

The workspace service runs its database work through `db` (drizzle over neon-http, no transactions), exactly like the routes it shares commands with; category expansion reuses the research catalog through `resolveScope` (the research pool, 60-second cached catalog).

## 5. Search → Explorer conversion

One converter serves the search link (§3.2), `create_saved_view` and `update_saved_view`. It runs **after the same validation the search uses**, so a saved view can only hold filters the search already accepted, and unknown category paths fail the same way (`CATEGORY_NOT_AVAILABLE`).

### 5.1 Pipeline

1. `parseSearchInput({ schemaVersion: 1, ...search })` — a continuation (`cursor`) never reaches this step: the strict `searchSpecSchema` omits the key, so `invalid()` renders the schema's own `Unrecognized key: "cursor"` as `INVALID_FILTERS` before the service runs, and the tool description says never to pass one. The service keeps a continuation guard after the parse only for the type narrowing; it is unreachable (Task 8 reviews, 2026-09-30). `pageSize`, when sent, is dropped here (`pageSize: undefined` in the parse call) — see §3.
2. `applyPresets(request)` → `filters`, `sort`, `comparisonWindow`, `applications`. Presets are filter bundles, so this step is lossless.
3. The search's own `resolveScope(userId, filters.categories, limits.maxExpandedLeaves, deps)` result — `scope.leaves`, the expanded, sorted union of the taxonomy selections, the explicit leaf paths and the custom categories' leaves (max 2000, the Explorer's own `MAX_LEAF_PATHS`) — is handed to the converter as `leaves`. There is no second resolution: the converter decides between ids and leaves (§5.2, the custom row). Changed 2026-09-30 after the Task 9 code review; the first design re-resolved the taxonomy part separately and emitted ids and leaves together.
4. `toExplorerFilters({ filters, sort, window: comparisonWindow, leaves })` → `{ filters: ExplorerFilters, notes: string[] }` (custom selections are read from `filters.categories`).
5. For a saved view: `normalizeFilters(filters)` (the app's own normaliser: `filtersToSearchParams` → `parseExplorerFilters`, page 1, perPage 100) and store. For a link: `explorerUrlFor(appUrl, filters)`.

### 5.2 Field map (exact)

| Research (`Filters` / request) | Explorer (`ExplorerFilters`) | Rule |
|---|---|---|
| `text.value`, `text.mode` | `q`, `qMode` | copy |
| `excludeTerms` | `qExclude` | copy |
| `rank` | `rankMin` / `rankMax` | `gte n` → min n; `gt n` → min n+1; `lte n` → max n; `lt n` → max n−1 |
| `estimatedMonthlySearches` | `volMin` / `volMax` | same shift |
| `averageReviews` | `reviewsMin` / `reviewsMax` | same shift |
| `wordCount` | `wordsMin` / `wordsMax` | same shift |
| `broadCategory` | `category` | copy (both compile to `kcs.top_clicked_category_1_current`) |
| `severities` | `severities` | copy |
| `titleGap.slots` / `.quantifier` / `.mode` | `titleSlots` / `titleMatchMode` / `matchMode` | copy; `titleGap: null` leaves the Explorer defaults (`[1,2,3]`, `null`, `'loose'`) |
| `categories.selections[kind='custom'].id` | `customCategoryIds` **or** `leafPaths` | **Custom-only scope** (no taxonomy selection, no explicit leaf path): copy the ids and leave `leafPaths` empty; the Explorer expands the ids itself, so the link or view follows later edits to the category. **Mixed scope** (custom plus taxonomy selections or explicit leaf paths): no ids; `leafPaths` = the full `scope.leaves`, the custom categories' leaves included — a snapshot at save time. Reason: the Explorer sidebar holds one leaf mode at a time (`FilterSidebar` emits either `custom` or `leaf`), so a link or view carrying both opens with the right rows and then loses the taxonomy part on the first sidebar Apply; expanding the mixed case keeps it refinable (Task 9 code review, 2026-09-30). |
| `categories.selections[kind='taxonomy']`, `categories.leafPaths` | `leafPaths` | the expanded terminal leaves from step 3 (the full `scope.leaves`), except in the custom-only case above, where `leafPaths` stays empty |
| a single taxonomy selection that is a **department** | `leafPaths` | **Dropped 2026-09-30.** The planned shortcut (map a lone department to the Explorer's broad category) was probed before implementation: in a 200,000-row sample, 182,658 rows have a broad category that differs from the first segment of the leaf path. `top_clicked_category_1_current` is Brand Analytics' own taxonomy ("Apparel", "Home", "Kitchen"), not the Keepa path root ("Clothing, Shoes & Jewelry", "Home & Kitchen"), and the mapping is not one to one. A department selection therefore expands to its leaves like every other selection; a department too large for a link gets the too-long note (§5.6). |
| `comparisonWindow` (effective) | `window` | copy. The view keeps the window the search actually ran with (research defaults to 4w, the Explorer to 1w), so the Explorer shows the same change columns the AI quoted. |
| `movement` | `jump`, `jumpMetric`, `jumpFrom`, `jumpTo`, `window` | §5.3 |
| `sort` | `sort` | §5.4 |
| `presetIds` | — | expanded in step 2; nothing to map |
| page, perPage | `page: 1`, `perPage: 100` | via `normalizeFilters` |
| anything the Explorer's own parser would read back differently (today: an excluded term containing a comma or a doubled space, which `parseExcludeTerms` splits or collapses; a volume jump threshold above the int4 ceiling) | — | a self-check runs the finished filters through the saved-view normaliser; any difference adds the note "The Explorer reads part of these filters differently from the search (for example a comma or a doubled space inside an excluded term); check the filters it opens with." Added 2026-09-30 after the Task 3 code review; the upstream cure is a §14 follow-up. |

Everything the search did not set stays at the Explorer's default or blank (`EXPLORER_DEFAULTS`), exactly as if the member had touched only those sidebar controls.

### 5.3 Movement → jump

The Explorer's jump is "was on one side of `from`, is now past `to`", and always includes keywords with no earlier value: rank compiles to `(prior > from OR prior IS NULL) AND current < to`, volume to `(prior < from OR prior IS NULL) AND current > to`.

| Research movement | Explorer |
|---|---|
| `metric` | `jumpMetric` |
| `window` | `window` |
| rank: `prior.gt X` → from X; `prior.gte X` → from X−1; `current.lt Y` → to Y; `current.lte Y` → to Y+1 | `jump: <preset id>` when (metric, from, to) equals a preset in `lib/explorer/jumpPresets.ts`, else `jump: 'custom'` with `jumpFrom`/`jumpTo` |
| volume: `prior.lt X` → from X; `prior.lte X` → from X+1; `current.gt Y` → to Y; `current.gte Y` → to Y−1 | same |
| `baseline: 'include_not_observed'` | exact |
| `baseline: 'observed_only'` (the default) | mapped as above, plus a note: "The Explorer also counts keywords that had no earlier value, so it can show a few more rows than this search." (neutral wording, since the Explorer side may be a plain range rather than a movement filter) |
| a `current` bound with **no** `prior` bound | not a jump: becomes the plain range on the same metric (`rankMin/Max` or `volMin/Max`), exact |
| a `prior` bound with no `current` bound | dropped, with a note |
| `prior` with bounds on both sides (a band) | the side the jump uses is mapped; the other side is dropped, with a note |
| `current` with an extra bound the jump cannot carry (e.g. rank `current.gte`) | the extra bound becomes the plain range on the same metric when possible, otherwise dropped, with a note |
| `delta` (volume only) | dropped, with a note: "The Explorer cannot filter on the size of the change itself; that part of the movement filter was dropped." (Reworded 2026-09-30 after the Task 3 code review: the first wording claimed a move was kept even when none was, e.g. for the delta-only `growing_4w_v1` preset.) |
| a from/to pair the Explorer would reject (rank needs from > to, volume needs from < to; `parseExplorerFilters` drops such a custom jump silently) | the jump is dropped, with a note; any current-side bound still becomes the plain range |
| a prior bound on the side the jump does not read (rank `lt`/`lte`, volume `gt`/`gte`): a decline, an improvement within a band, or that bound alone | no jump. With a current bound the note says the Explorer cannot express the move; alone, the note says the earlier-value bound was dropped. Any current bound still becomes the plain range. (Added 2026-09-30 after the Task 3 spec review: the first draft dropped these silently, breaking §3.2's "empty notes = exact link".) |

"Moved from 100k to 50k over the last week" is rank movement `{ window: '1w', prior: { gt: 100000 }, current: { lt: 50000 } }` and lands exactly on the Explorer's `100k_to_50k` preset with `window: '1w'`.

### 5.4 Sort

| Research sort | Explorer `sort` |
|---|---|
| `estimatedMonthlySearches desc` (the default) | `'rank'` (same order) |
| `estimatedMonthlySearches asc` | `'rank_desc'` |
| `rank asc` / `rank desc` | `'rank'` / `'rank_desc'` |
| `averageReviews asc` / `desc` | `'avg_reviews_asc'` / `'avg_reviews_desc'` |
| `volumeDelta desc` / `asc` | `'imp'` / `'decline'` |
| `wordCount asc` / `desc` | `'rank'`, with a note: "The Explorer cannot sort by word count; the view opens sorted by rank." |

### 5.5 Compact filters (what the list and create results show)

`compactExplorerFilters(f)` returns only the fields that differ from `EXPLORER_DEFAULTS`, never `page`/`perPage`, and `jumpMetric` whenever `jump` is set (even for the default rank metric, so the AI never has to infer it). Severities are kept in canonical order so a reordered default still compacts away. An empty object means "the default Explorer". This is what `list_saved_views`, `create_saved_view` and `update_saved_view` return as `filters`. There is no reverse translation into research vocabulary. The summary also carries `leafCount` (how many leaf categories the stored filters name; 0 when none) and `previewComplete`; `filters.leafPaths`, when present, is cut to the first 20 stored paths, like a category's `previewPaths` — a department-wide view would otherwise echo up to 2,000 paths (~120 KB) per view, five views per list, twice per tool result (Task 8 code review, 2026-09-30). The link and the stored view itself are untouched.

### 5.6 Link length

Vercel's CDN rejects URLs over 14 KB, and an encoded leaf path costs 80–150 bytes (`›` alone is 9 bytes once percent-encoded; measured on 50–100-character paths in the Task 9 code review), so a link holds about 75–140 leaves. `explorerUrlFor` builds `${appUrl}/explorer?${filtersToQueryString(filters)}` and returns `null` when the result exceeds **12,000 bytes**; the caller then adds a note chosen by what the reader can do: on a channel with the workspace tools (the MCP with `MCP_WRITE_ENABLED`) `NOTE_LINK_TOO_LONG` = "Too many leaf categories for a link; save them as a custom category first, then search or save a view with it."; elsewhere (Ask AI, or the MCP with writes off) `NOTE_LINK_TOO_LONG_READONLY` = "Too many leaf categories for a link; narrow the categories to get one." (Task 9 code review, 2026-09-30: the first wording named a tool the reader may not have; final review, 2026-10-01: it now points at the custom-category route first, see below.)

A saved view's own link carries only the view id, so it is always short — but the Explorer re-serialises the stored filters into URLs for Export (one GET with the whole filter set) and for the sidebar's Apply (one param per leaf), so a view that names more leaves than a link can hold opens as saved and then cannot be exported or refined (a 150-leaf view measured 14,777 bytes; 2,000 leaves 196,077). `create_saved_view` and `update_saved_view` therefore add `NOTE_VIEW_TOO_WIDE` = "This view names more leaf categories than the Explorer can export or refine; it opens as saved. For a view you can export and change, save these categories as a custom category and save a view that uses it." whenever `explorerUrlFor` would return null for the stored filters (the same 12,000-byte predicate), and the guide carries a matching rule (§9.1). A custom category avoids the problem: a custom-only scope passes just the category id everywhere (final review, 2026-10-01).

### 5.7 Update semantics

`update_saved_view` with `search` replaces the stored filters wholesale (no merge); with `name` only, it renames. `update_custom_category` with `categories` recomputes the leaf list per `leafMode` (§6.2); with `name` only, it renames.

## 6. Shared commands

Today the saved-view, custom-category and watchlist rules live inline in the API routes with no route tests. This arc moves them into command modules that both the routes and the workspace service call, so the app and the AI can never disagree on a cap, a message or a duplicate-name rule. Commands return results, never HTTP responses; the routes map result codes to the exact status codes and messages they return today, and the workspace service maps them to `ResearchError`s (§7).

Result shape for every command: `{ ok: true, ...payload } | { ok: false, code, message }`. `message` is the user-facing sentence the route already returns (verbatim).

Unique-name violations are detected with `lib/db/pgErrorCode.ts` (`pgErrorCode(e)`, `isUniqueViolation(e)`), which reads the SQLSTATE on the error or on the `cause` that drizzle-orm wraps every driver error in (`DrizzleQueryError`). The inline check the routes used before this arc read only the top level and therefore never matched in production: a duplicate name answered 500 instead of the 409 sentence. Found by the Task 4 code review and fixed on both surfaces 2026-09-30; the test doubles now build the wrapped shape.

### 6.1 `lib/savedViews/commands.ts`

| Command | Codes | Notes |
|---|---|---|
| `createSavedView(userId, { name: unknown, filters: unknown })` → `{ view: SavedView }` | `invalid_name`, `cap_reached`, `duplicate_name` | `validateName`, `normalizeFilters`, count-then-insert (cap 5), 23505 → `duplicate_name`. Messages: the route's existing strings. |
| `updateSavedView(userId, id, { name?: unknown, filters?: unknown })` → `{ view }` | `invalid_id`, `invalid_name`, `nothing_to_update`, `not_found`, `duplicate_name` | owner-scoped update; sets `updatedAt`. |
| `deleteSavedView(userId, id)` → `{ deleted: { id, name } }` | `invalid_id`, `not_found` | owner-scoped; returns the name it removed (the route ignores it). |

`SavedView` is the existing type (`lib/savedViews/types.ts`); `filters` in results are normalised through `normalizeFiltersBlob`.

### 6.2 `lib/customCategories/commands.ts`

| Command | Codes | Notes |
|---|---|---|
| `createCustomCategory(userId, { name: unknown, leafPaths: unknown })` → `{ category: CustomCategoryDTO }` | `invalid_name`, `no_leaves`, `too_many_leaves`, `cap_reached`, `duplicate_name` | `validateName`, `normalizePaths`, cap 25, 12,000 leaves, 23505 (case-insensitive unique) → `duplicate_name`. |
| `updateCustomCategory(userId, id, { name?: unknown, leafPaths?: unknown })` → `{ category }` | `invalid_id`, `invalid_name`, `no_leaves`, `too_many_leaves`, `nothing_to_update`, `not_found`, `duplicate_name` | partial: a missing field is left alone. The PATCH route keeps requiring both fields and returns its existing 400s before calling this. |
| `deleteCustomCategory(userId, id)` → `{ deleted: { id, name, leafCount } }` | `invalid_id`, `not_found` | owner-scoped. |

Leaf modes are resolved in the workspace service, not the command: it loads the row (`loadCustomCategoryForUser`; `not_found` if missing), expands `categories` through `resolveScope(userId, categories, MAX_LEAF_PATHS_PER_CATEGORY, deps)` (12,000, not the search's 2,000 — a category may hold a whole department), then computes the final list: `replace` = the expansion; `add` = stored ∪ expansion (stored paths are kept as they are, even ones no longer in the catalog); `remove` = stored minus the explicit `leafPaths` taken verbatim (trimmed) and minus the expansion of any `selections` — explicit paths are not run through the catalog in remove mode, so a stale stored leaf that `list_custom_categories` just showed can still be removed (the catalog would otherwise reject it with CATEGORY_NOT_AVAILABLE; Task 7 code review, 2026-09-30). An empty result is `no_leaves`. The command then stores the full list. A custom selection inside `categories` expands to that category's live leaves, so categories can be composed; a category adding itself is a harmless no-op.

Category paths use the app's separator `' › '` (space, U+203A, space), as `resolve_categories` returns them.

### 6.3 `lib/watchlist/commands.ts`

| Command | Result | Notes |
|---|---|---|
| `addToWatchlist(userId, { keywords: string[], searchTermIds: string[] })` → `{ added, alreadyWatching, unmatched, skippedAtCap, watching }` | never fails; input size is validated by the caller | text is normalised and looked up like `bulkAddToWatchlist` today; ids are checked against `search_terms`; unknown ids and unmatched text go to `unmatched` verbatim; dedupe across both inputs; cap 100 best-effort in input order (`skippedAtCap`); `ON CONFLICT DO NOTHING`; `watching` = count after the call. |
| `removeFromWatchlist(userId, { keywords, searchTermIds })` → `{ removed, notWatching, unmatched, watching }` | never fails | same matching; a matched keyword not on the list counts as `notWatching`; delete is owner-scoped and idempotent. |

`bulkAddToWatchlist(userId, keywords)` (used by the paste box route and its tests) becomes `addToWatchlist(userId, { keywords, searchTermIds: [] })` minus `watching`; its `BulkAddResult` and `HARD_MAX_INPUT` behaviour are unchanged. The single-item `POST /api/watchlist/items` and `DELETE /api/watchlist/items/[keywordId]` routes stay as they are (the POST returns `addedAt`, which the shared path does not carry).

### 6.4 Route behaviour is pinned

The first route tests these APIs have had are added in this arc, asserting today's status codes, error strings and response bodies for every branch listed in §6.1–6.3, with `requireAuthenticatedUser` and the database mocked. Extraction must leave every assertion green.

## 7. Errors

The workspace service throws `ResearchError`s so the MCP adapter's `errorResult`/`classifyToolError` path is unchanged. New codes in `RESEARCH_ERROR_CODES`:

| Code | When | Message |
|---|---|---|
| `LIMIT_REACHED` | a resource cap: 5 views, 25 categories, or a leaf list that would exceed 12,000 after an `add`-mode union (the command's `too_many_leaves`) | the app's own sentence, e.g. "You've reached the 5-view limit. Delete a saved view to add a new one." A single selection that would itself expand past 12,000 leaves is refused earlier by `resolveScope` as `INVALID_FILTERS` ("…the limit is 12000. Choose a narrower branch."), the same guard search uses; the whole taxonomy is ~11.4k leaves today, so that path is theoretical (Task 8 spec review, 2026-09-30). |
| `DUPLICATE_NAME` | 23505 on a name | the app's own sentence, e.g. `You already have a view named "Lamps". Choose a different name or update the existing one.` |
| `NOT_FOUND` | an id that is not the caller's or no longer exists | "No saved view with that id belongs to this account." / "No custom category with that id belongs to this account." |
| `INVALID_FILTERS` (existing) | schema failures, `nothing_to_update`, `no_leaves`, a `cursor` in `search` | `invalid()`'s rendering, or the command's sentence |
| `CATEGORY_NOT_AVAILABLE` (existing) | category expansion, as in search | unchanged |
| `RATE_LIMITED` (existing) | the per-minute bucket, or the daily write cap | per-minute: unchanged; daily: "Daily limit of 200 saves reached. Try again tomorrow." with `retryAfterSeconds` = seconds until the next Eastern midnight |
| `DATA_UNAVAILABLE` (existing) | anything unexpected | `SAFE_TOOL_FAILURE`, never `e.message`. The service converts the raw error itself after its log line (§8.6), so the shared classifier never sees a drizzle error from a workspace tool; a pool connect timeout becomes `poolBusyError()` as in search |

The watchlist cap is not an error: `add_to_watchlist` reports `skippedAtCap`, and the guide tells the AI to say what could be removed.

## 8. Limits and guards

### 8.1 Per minute
Every workspace call reserves through the same `research_usage_buckets` minute bucket the research tools use (`reserveResearchRequest`, channel `'mcp'`, `rows: 0`), so the 60-requests-per-minute limit covers reads and writes together.

### 8.2 Per day
`ResearchLimits.writesPerDay = 200` (overridable). Before each write the service reads `countUserActivityToday(userId, 'mcp_write')`; at or above the limit it throws the daily `RATE_LIMITED` (§7). After a successful write it bumps `mcp_write` (fire-and-forget, `bumpUserActivity`). Days are Eastern calendar days like every other counter in `user_activity_daily`.

### 8.3 Per resource
Enforced in the shared commands with the app's wording: 5 saved views, 25 custom categories, 100 watched keywords, 12,000 leaves per category, names up to 80 characters, 100 items per watchlist call, 25 selections / 2,000 explicit leaf paths per `categories` object.

### 8.4 What the abuse digest sees
`PerUserActivity.mcpWrites` from the `mcp_write` counter (`USER_METRICS.mcpWrite`), shown next to MCP calls in both the text and HTML digest, with `THRESHOLDS.userMcpWritesPerDay = { amber: 100 }` ("N MCP writes in a day"). The existing `savedViewsCreated`, `customCategoriesCreated` and `watchlistAdds` counts already include rows created through the MCP, since they count table rows.

### 8.5 Ownership and idempotency
Every command is scoped to `actor.localUserId`. A foreign or missing id is `NOT_FOUND`, never a silent success, so the AI cannot report a delete that did not happen. Removing a keyword that was not watched is `notWatching`, not an error. Deletes are permanent; the guide says so.

### 8.6 Logging
One line per workspace call: `console.log('[workspace]', JSON.stringify({ tool, outcome: 'ok' | 'refused' | 'failed', code?, error?, userId, durationMs }))`. Never names, keyword text or leaf paths. `refused` = a `ResearchError` the caller can act on; `failed` = anything else, logged with `errFields` (the unwrapped error name and SQLSTATE — a `DrizzleQueryError`'s own message embeds the bound params; `errFields` also returns `detail`, the cause's message capped at 200 characters, which the workspace line drops and the classifier, `gated()` and the fail-soft logs keep — still log-safe, since it is the Postgres message, never the drizzle params) — and also a `ResearchError` whose code is `DATA_UNAVAILABLE` or `QUERY_TIMEOUT` (infrastructure, e.g. a category loader), so incidents stay searchable. After the line, the service rethrows a `ResearchError` of its own — `poolBusyError()` for a pool connect timeout, otherwise `DATA_UNAVAILABLE` with `SAFE_TOOL_FAILURE`'s sentence and no `cause` — never the raw error, which `classifyToolError` would otherwise log with its message and stack (Task 8 code review, 2026-09-30; the classifier itself is hardened in Task 10).

### 8.7 Known soft spot
Cap checks are count-then-insert without a transaction (neon-http), as in the routes today. Two racing writes can land one row over a cap. Accepted: the per-minute limit and the AI's one-at-a-time calls make it rare, and the app already lives with it. Two refinements from the 2026-09-30 reviews: (1) the custom-category leaf modes are likewise an untransacted load → expand → update, so a Category Builder save landing in between is overwritten — the same accepted trade-off; (2) "one-at-a-time" is an assumption — Claude and ChatGPT can issue parallel tool calls, and "Always allow" removes the pacing, so N concurrent creates could overshoot a cap by N−1. A hard cap would need a per-user advisory lock plus a conditional insert inside one `db.batch()` (drizzle's neon-http batch runs as one transaction). An owner decision for later; nothing changes now.

## 9. What the AI is told, what members read

### 9.1 Guide
`buildGuide` takes `workspace: boolean`. When true, `GuideResponse.workspace` is present:

```ts
workspace?: {
  rules: string[];
  caps: { savedViews: 5; customCategories: 25; watchedKeywords: 100; leavesPerCategory: 12000; writesPerDay: number };
}
```

Rules, in the guide's existing style:

- "Run the search first, show the results, then save. Pass the exact search object (presetIds, filters, sort, comparisonWindow) to create_saved_view; never a cursor. Relay every entry in notes to the person."
- "Every search answer carries explorerUrl: the Explorer opened with the same filters. Offer it when the person wants to see or refine the results in the app."
- "A view that names more than about a hundred leaf categories opens but cannot be exported or refined in the Explorer. Save those categories as a custom category and search or save with it instead." (added 2026-10-01 after the final review; §5.6)
- "Resolve category words with resolve_categories first and pass the returned selections to create_custom_category or update_custom_category; the server expands them to leaves."
- "Edits and deletes take ids from list_saved_views, list_custom_categories or list_watchlist. Confirm the item's name with the person before deleting. Deleting is permanent; removing from the watchlist is not."
- "Names must be unique per account. On DUPLICATE_NAME, ask the person for a different name; never invent one."
- "Caps: 5 saved views, 25 custom categories, 100 watched keywords. At a cap, tell the person what they could remove; do not delete anything to make room unless they say so."
- "A saved view built from custom categories alone follows later edits to those categories; a view that mixes a custom category with other categories stores its leaves as they were when it was saved." (added 2026-09-30 after the Task 9 re-review; the §5.2 mixed-scope rule)
- "Never create, change or delete anything the person did not ask for in this conversation."

`GUIDE_VERSION` becomes 2 (echoed in search provenance). `guide()` passes `workspace: actor.channel === 'mcp' && deps.workspaceEnabled()` (the `ResearchServiceDeps` member the Task 9 fix round introduced for §5.6's note; default `mcpWriteEnabled`), so Ask AI's guide has no workspace section; it shares the error-code list (which now carries the three workspace codes, as it already carries the never-thrown `UNSUPPORTED_FILTER`) and `guideVersion` with the MCP guide.

### 9.2 Server instructions
`lib/mcp/handler.ts`'s `instructions` string gains, when the flag is on: "Workspace tools (list/create/update/delete saved views and custom categories, add to and remove from the watchlist) change this account's own data; clients normally ask the person before each write; confirm names and deletions."

### 9.3 Connect AI page
- Intro sentence, flag on: "Let Claude or ChatGPT search KeywordQuarry directly while you work and, with your approval, save views, build custom categories and edit your watchlist. Beta, free while it lasts." Flag off: today's read-only sentence. (Amended 2026-09-30 after the Task 12 code review: the first draft said "with your approval each time", but the client, not the server, prompts — a member who picks Always allow, or a client set to auto-run, stops seeing prompts — so "each time" overpromised; the server instructions already say clients "normally" ask. Owner may revert in one line.)
- `ExampleQuestions` gains, flag on only, a second list under the existing disclosure headed "It can also save. Try asking" (an `h3` labelling its list; the first draft's "With saving on, also try" named a switch members never see — same review), from `lib/workspace/examples.ts`:
  1. "Save that search as a view called Lamps under 500 reviews."
  2. "Build a custom category called Lighting from everything under Lamps and Ceiling Lights, then show me its top keywords."
  3. "Add the top 20 results to my watchlist."
- `lib/ask/examples.ts` is unchanged (Ask AI's empty state must not show write prompts).
- Setup steps and the troubleshooting card are unchanged (one scope: nobody reconnects).

### 9.4 App pages
Explorer, Category Builder and Watchlist pages need no change; they read the same tables. Saved views created by the AI appear in the Explorer dropdown, custom categories in the Category Builder and the Explorer's category filter, watchlist rows on the Watchlist page and in the weekly digest, all on the next load.

## 10. Data flow

```
client tool call
  → withMcpAuth (token, scope)          lib/mcp/handler.ts (unchanged)
  → gated(): client, account, connection status, touch
  → McpServer tool handler              lib/mcp/tools/registerWorkspaceTools.ts
      actorFromContext(ctx) → ResearchActor { localUserId, clerkUserId, clientId, channel: 'mcp' }
      runTool(name, () => def.run(service, actor, args))
  → WorkspaceService.<method>(actor, args)
      1. schema.safeParse(args)  → INVALID_FILTERS via invalid()
      2. reserveResearchRequest({ rows: 0 })  → RATE_LIMITED
      3. (writes) countUserActivityToday('mcp_write') ≥ writesPerDay → RATE_LIMITED (daily)
      4. (views/categories) parseSearchInput/applyPresets/resolveScope or resolveScope(…, 12000)
         toExplorerFilters → notes
      5. command (lib/*/commands.ts)  → { ok } | { ok:false, code } → ResearchError (§7)
      6. recordResearchActivity(userId, 0, 'mcp'); (writes) bumpUserActivity('mcp_write')
      7. log line (§8.6); return response (§3)
  → okResult / errorResult               lib/mcp/tools/toolResult.ts (unchanged)
```

`search_keywords` (research service) additionally computes `explorerUrl`/`explorerNotes` between `resolveScope` and `build()`.

## 11. Testing

All offline (vitest, node environment for MCP/research modules, `vi.mock('@/lib/env', …)` as the existing tests do), run before anything ships:

1. **Converter** (`lib/workspace/explorerFilters.test.ts`): every row of §5.2 including the gt/lt shifts; presets expand first; a department selection expands to its leaves like any other; each movement row in §5.3 (preset hit, custom, current-only → range, prior-only dropped, band, delta, baseline note); each sort in §5.4; the note texts; `compactExplorerFilters`; `explorerUrlFor` at and over 12,000 bytes; and a round trip: converted filters → `normalizeFilters` → `parseExplorerFilters(searchParamsToLike(new URLSearchParams(filtersToQueryString(f))))` equals the stored object.
2. **Commands** (`lib/savedViews/commands.test.ts`, `lib/customCategories/commands.test.ts`, `lib/watchlist/commands.test.ts`): every code in §6 with `@/db/client` mocked; leaf modes add/remove/replace; dedupe across keywords and ids; `skippedAtCap` in input order; `bulkAddToWatchlist`'s existing tests still pass unchanged.
3. **Routes** (`app/api/explorer/saved-views/*.test.ts`, `app/api/category-builder/custom/*.test.ts`): every status code and message in §6.1–6.2 before and after extraction (the assertions are written against the pre-extraction routes first, then the extraction lands under them).
4. **Tool definitions** (`lib/workspace/tools.test.ts`): eleven names in order, strict schemas (a `cursor` inside `search` is rejected; `categories` needs at least one selection or leaf path; watchlist inputs 1–100 combined), annotations per §3, `requiresConfirmation` true on the eight writes, frozen entries, `run` dispatch.
5. **Service** (`lib/workspace/service.test.ts`): order of operations per §10 with injected deps; the daily cap refuses the 201st write and never bumps on refusal; the minute reservation happens before any work; `NOT_FOUND` for a foreign id; result shapes per §3.
6. **Registration and parity** (`lib/mcp/tools/registerWorkspaceTools.test.ts`, updated `registerResearchTools.test.ts`, `app/api/mcp/route.test.ts`): `tools/list` shows five research tools plus `whoami` with the flag off, sixteen plus `whoami` with it on; a workspace tool call through the real route returns `okResult`; `lib/ask/tools.test.ts` still asserts exactly the five research tools.
7. **Search link** (`lib/research/service.test.ts`): `explorerUrl` present on every page, `null` plus a note past the length cap, notes for a dropped delta.
8. **Guide** (`lib/research/catalog.test.ts`): `workspace` present only when asked for; `guideVersion` 2; the caps echo the limits.
9. **Config, env, digest** (`lib/mcp/config.test.ts`, `lib/notifications/abuseDigest/*.test.ts`, `lib/research/limits.test.ts`): `mcpWriteEnabled` truth table; `mcpWrites` column and amber flag; `writesPerDay` overridable.
10. **Connect AI page** (`app/(app)/connect-ai/page.test.tsx`): intro sentence and the three prompts with the flag on and off; Ask AI's example list unchanged.

Then `pnpm typecheck`, `pnpm lint`, the full `pnpm test`, and `pnpm build`.

**Integration** (owner-gated, `RUN_INTEGRATION=1`, real tables, synthetic `itest` users via `tests/integration/helpers.ts`, run before the next Monday import): `tests/integration/workspaceCommands.test.ts` — create/update/delete for a view and a category, add/remove for the watchlist, the duplicate-name path, and a custom category expansion against the real catalog; every row cleaned up in `afterAll`.

## 12. Smoke test (owner, Claude desktop, after the deploy)

1. Search something; open the link; same rows.
2. "Save that as a view called …": approval prompt appears; the view is in the Explorer dropdown and opens to the same rows.
3. "Build a custom category called … from everything under …": it appears in the Category Builder; use it in a follow-up search and in the Explorer link; add leaves; delete it.
4. Add five keywords to the watchlist, remove two; the Watchlist page matches.
5. Save a view under a name that already exists: the AI asks instead of inventing a name.
6. Delete a view: gone from the dropdown.
6b. Search a whole department: the answer has no link and its note says to save the categories as a custom category first (an encoded leaf path costs 80–150 bytes, so a link holds about 75–140 leaves). Ask for that: the category is created, the search re-run with it gets a short link, and a view saved from it opens, exports and refines. Then also save the raw department search as a view: the save answers `NOTE_VIEW_TOO_WIDE`; open it (it opens), press Export and change one filter (both fail on the URL length — expected, that is what the note warned about).
7. If ChatGPT is handy: repeat step 2 there.

Done means: a member with Claude or ChatGPT can, with a prompt on each write, get Explorer links from searches, manage saved views, build and edit custom categories from category words, and edit their watchlist, and every change shows in the app on the next load. Nothing changes for members who never touch the tools. No database schema changes.

## 13. Ship plan

Arc 3 commits land on local `main` on top of arc 2's 44 unpushed commits. Nothing is pushed without the owner's explicit go for that push, and `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` runs first (the Railway worker restarts on push).

Owner steps before the push: set `MCP_WRITE_ENABLED=1` in Vercel (Production) — the push's deployment picks it up; switching it off later also needs a redeploy; leave `ASK_AI_ENABLED` unset so Ask AI stays dark (page, nav link and routes all answer as if it did not exist, and nothing reads the new tables); confirm migration 0048 so it is applied at push time (`APPLY_0048=yes node --env-file=.env.local --import tsx scripts/applyMigration0048.ts`; it only creates empty tables and indexes, so the admin page cannot trip on them). Then: push, watch Vercel and Railway to green, smoke (§12), announce to beta members. The Ask AI launch steps in the arc-2 plan (Anthropic key and spend limit, `ANTHROPIC_API_KEY`, `INITIAL_ADMIN_EMAIL`, `ASK_AI_ENABLED=1`, integration tests) happen whenever the owner is ready, after this.

## 14. Follow-ups (not this arc)

- Write tools in the in-app Ask AI chat, with an approve/deny card (the arc-2 spec §16 item this arc half-closes).
- A separate write scope if read-only connections are ever wanted.
- A saved-view "update filters" control in the Explorer UI (the API and the MCP support it; the sidebar does not).
- `list_watchlist` rows could carry current rank and volume; today the AI calls `get_keyword_details` for that.
- ~~Explorer: a column-header sort on a saved view produces `?view=<id>&sort=…`, and the page then treats `sort` as a URL filter and ignores the stored filters while the dropdown still shows the view's name (`SortableHeader.tsx`, `page.tsx`); pre-existing, but AI-made views will expose it more often (final review, 2026-10-01).~~ **Fixed 2026-10-01** (plan 2026-10-01-explorer-saved-view-fixes, Task 1: `resolveExplorerFilters` overlays `sort`/`page`/`per_page` on the stored filters; the Save button resolves the same way).
- ~~Saved views: the accepted count-then-insert race (§8.7) can create a sixth view, and `loadServer.ts` lists with `.limit(5)`, so that view is invisible to `list_saved_views` and the dropdown and cannot be deleted by id; list without the limit, or enforce the cap in the database (final review, 2026-10-01).~~ **Fixed 2026-10-01** (same plan, Task 2: listings are never capped, so a sixth view is visible and deletable and the Save note says how many to delete; the race itself stays accepted — an atomic cap needs a slot column + unique index, i.e. DDL, still a follow-up).
- Normalise `excludeTerms` upstream in the research schema (collapse whitespace runs, reject a comma inside a term, "one word or phrase per item") so the Explorer reads them exactly as the search did; today the converter adds a note instead (Task 3 code review, 2026-09-30). This changes the live search contract, so it is an owner decision.

# KeywordQuarry Research and remote MCP specification

- Date: September 18, 2026
- Audience: application owner and Claude Code implementation agent
- Repository: C:/Users/raw50/Amazon Keyword Analytics
- Reviewed code baseline: 2d78e83 on main
- Status: detailed handoff for owner review; product direction approved in the brainstorming session. Technical defaults below are implementation recommendations, not previously selected commercial allowances.

## 1. Objective and completion boundary

Deliver two independently gated, admin-only entry points to KeywordQuarry's existing Amazon keyword data:

1. A dedicated Research page, branded **Ask KeywordQuarry**, for conversational filtering, clarification, visible editable criteria, factual explanations, and keyword results.
2. An authenticated remote Model Context Protocol (MCP) server for research through the owner's ChatGPT and Claude accounts.

Both use one validated research service inside the existing Next.js application. The remote client provides its own language model; MCP tool execution does not call an owner-funded model. The internal page uses a server-side model API paid for by KeywordQuarry.

Design the service, access policy, and usage accounting so a paid customer HTTP API can be added later. Do not ship a public developer API, API-key dashboard, or payment integration in this release. MCP access will itself be a paid add-on when opened to customers. Admin testing bypasses payment, not access checks or operating limits.

The primary acceptance example is:

> Please return all keywords with over 10k searches and less than 500 average reviews in the lighting niche.

The result must use verified category scope, estimated monthly search volume strictly greater than 10,000, and the stored average-review metric strictly less than 500. Return a bounded, clearly labeled result set with pagination. Never represent a capped subset as every matching keyword.

This document specifies the complete first release, including its internal interface. Implementing only a tool endpoint with unvalidated filters, or only a chat mockup, does not satisfy it. No application changes, migrations, paid API calls, or deployment were performed in preparing this specification.

## 2. Approved product decisions

| Area | Required behavior |
|---|---|
| Data sources | Existing KeywordQuarry data only. No live Amazon browsing, web research, or new enrichment triggered by a request. |
| Internal experience | Dedicated Research page first. Conversational search with concise explanations and follow-ups; an Explorer-side assistant is deferred. |
| External experience | The same MCP server supports ordinary tool-using conversations in ChatGPT and Claude. |
| Initial access | Both entry points are admin-only, enforced on the server, with independent release switches. |
| Research scope | Read-only research. Search, category discovery, current details, and available history. |
| History | Save the latest 10 executed internal searches per account: prompt, exact resolved criteria, and execution time. Reopening reruns against current data and says so. Full conversation persistence is not included. |
| Category interpretation | Search full taxonomy paths, including parents. Resolve to existing leaf paths and combine them with OR. Other filters combine with AND. |
| Custom categories | Use the authenticated user's existing named custom categories when requested. Temporary niche groupings are not saved as permanent Category Builder categories. |
| Ambiguity | Ask a short clarification when different interpretations materially change the search. |
| Vague thresholds | Use defined, visible, editable presets. Explicit user criteria take precedence. |
| “Best opportunities” | Ask which signals matter and suggest a starting point of at least 10,000 estimated monthly searches and fewer than 500 average reviews. Do not create an overall opportunity score. |
| Undefined requests | Explain the ambiguity or missing capability and offer a supported alternative. Do not silently omit unsupported conditions. |
| Empty results | Explain that no results match; offer changes for the user to accept. Never silently loosen criteria. |
| Model choice | One configurable internal provider/model selected by evaluation. The ChatGPT/Claude choice refers to external MCP clients, not an internal model selector. |
| Commercial direction | MCP is an upcharge. A paid customer/developer API is a later release. Exact prices and monthly allowances are intentionally deferred. |

## 3. Scope exclusions

This release has no MCP tools for saving views, editing custom categories, changing watchlists, exporting files, importing data, running Keepa enrichment, managing users, issuing arbitrary SQL, fetching arbitrary URLs, or invoking general shell/code execution. Operational persistence for recent searches, result caches, access checks, and usage records is allowed and necessary; it does not turn the research tools into business-data write tools.

The existing website CSV export remains available under its current rules. It was added after the initial September 16 review: 10,000 rows per export and 10 exports per account per Eastern Time day. This specification does not change those product limits or expose that route through MCP.

Also deferred: complete bulk extraction, a public API, public directory submission, interactive widgets embedded inside AI clients, a proprietary opportunity score, full persisted chats, website browsing, profitability/PPC estimates, and ChatGPT's separately named Deep Research/company-knowledge search/fetch adapter. Deeper analysis in ordinary external conversations remains supported using the five tools below.

## 4. Existing code and integration map

Read AGENTS.md and the relevant installed Next.js documentation under node_modules/next/dist/docs before writing application code. The repository uses Next.js 16.2.3, React 19.2.4, Clerk, Zod 4, Drizzle, Neon PostgreSQL, and Vitest. Follow current executable code rather than stale README or schema comments.

| Existing path | Role and implementation implications |
|---|---|
| app/(app)/explorer/page.tsx | Existing authenticated Explorer loader. Preserve its behavior. |
| app/(app)/TabNav.tsx | Add admin-visible Research navigation. Hiding a tab is not authorization. |
| lib/explorer/types.ts | Existing Explorer filter and row types. Direct current-volume bounds are absent. |
| lib/explorer/parseFilters.ts | Forgiving URL parser; invalid criteria can silently disappear. Do not use it as research/API validation. |
| lib/explorer/buildQuery.ts | Parameterized predicates, optimized category path, text matching, volume-delta expressions, and existing sort semantics. |
| lib/explorer/runQuery.ts | Existing results/count orchestration. Broad searches may run for 115 seconds; counts for 45 seconds. These budgets are unsuitable for research tools. |
| lib/explorer/queryTotals.ts | Precomputed-count eligibility. Any widening of the shared filter type must update these guards. |
| lib/explorer/matchPattern.ts | Reusable escaped literal whole-word/substring matching. |
| lib/explorer/fetchKeywordDetail.ts | Separate header, products, chart history, and raw-history loaders. The monolithic loader is too broad for every tool call. |
| lib/explorer/chartSeries.ts | Compact historical-series mapping and existing masking/volume semantics. |
| lib/categoryBuilder/loadTree.ts | Root/child/descendant-path discovery; do not load the entire taxonomy into every model prompt. |
| lib/explorer/listLeafCategories.ts | Facet-backed path discovery with existing cache/fallback behavior to assess. |
| lib/customCategories/expand.ts | Owner-scoped expansion, but missing IDs are silently skipped. Research must reject unresolved references. |
| lib/savedViews/validation.ts | Legacy filter round-trips. Update all relevant conversions if changing ExplorerFilters. |
| app/api/explorer/export/route.ts | Existing CSV export; uses shared Explorer filters and a soft daily counter. Preserve its behavior and regression coverage. |
| lib/explorer/export/query.ts | Existing URL/filter serialization dependency. |
| lib/auth/getCurrentUser.ts | Browser-session identity and verified account provisioning. It is not already a remote OAuth-token guard. |
| lib/auth/requireAdmin.ts | Current admin-role check. Reuse the role policy after resolving remote identity correctly. |
| lib/auth/provisionUser.ts | Existing verified identity/relink safeguards; do not bypass with email from a tool argument. |
| proxy.ts | Browser route protection. Add /research; do not redirect MCP requests to HTML login pages. |
| db/schema/keywordCurrentSummary.ts | Current searchable metrics and full category path. |
| db/schema/keywordCurrentSummaryMeta.ts | Dataset week, refresh time, snapshot version, fit ID, and default count. |
| db/schema/keywordChartSeries.ts | Cached observations, at most 52 retained entries. |
| db/schema/asinWeeklyData.ts | Product enrichment and actual enrichedAt timestamps. |
| inngest/functions/refreshSummary.ts | Weekly stage/swap, calibration, aggregate and historical-series maintenance. |
| worker/kcsKeepaSyncJobs.ts | Updates current review/category aggregates in place without changing the weekly snapshot version. |
| db/client.ts | HTTP/TCP driver selection. Transactional limits and coherent reads need an appropriate actual connection/transaction, not just a JavaScript promise timeout. |
| lib/activity/bump.ts | Existing reporting counters, not a hard concurrent quota ledger. |
| tests/integration/setup.ts | Loads .env.local. Do not assume this points to a disposable test database. |

The baseline contains no model SDK or MCP implementation. Recheck HEAD and working-tree changes before implementation because another agent maintains this application. Preserve unrelated untracked scripts, spreadsheets, output directories, and investigation documents. Do not renumber or overwrite migrations introduced concurrently.

## 5. Architecture and component boundaries

~~~mermaid
flowchart TD
    UI[Admin Research page] --> API[Internal session-authenticated handlers]
    API --> P[Prompt interpreter and clarification]
    P --> S[Shared research service]
    API --> S
    C[ChatGPT or Claude] --> M[OAuth-authenticated MCP adapter]
    M --> S
    S --> A[Access policy and operating limits]
    A --> Q[Validated queries and result snapshots]
    Q --> DB[(Existing Neon analytics)]
    S --> U[Usage and recent-search persistence]
    F[Future paid HTTP API] -.-> S
~~~

The Research page calls the service directly through its own application handlers. It does not make an HTTP MCP round trip. The MCP adapter translates transport requests/results and delegates to the same service. The future API can become another adapter without moving business logic.

Recommended modules, with equivalent naming allowed:

| Component | Responsibility |
|---|---|
| lib/research/contracts.ts | Strict versioned Zod input/output schemas and exported types. |
| lib/research/catalog.ts | Versioned metric definitions, presets, supported intents, and limitations; no database/provider dependency. |
| lib/research/access.ts | Resolve feature access from trusted actor, role, entitlement/override, and feature flag. |
| lib/research/categories.ts | Taxonomy candidate search, verified path expansion, and owner-scoped custom-category resolution. |
| lib/research/query.ts | Bounded parameterized search over current summary; shared pure predicate logic where applicable. |
| lib/research/details.ts and history.ts | Narrow current-detail and bounded history reads with common semantics. |
| lib/research/results.ts | Immutable short-lived result sets, cursor creation/verification, byte bounds, and expiry. |
| lib/research/service.ts | Authorized guide/category/search/detail/history operations used by adapters. |
| lib/research/recentSearches.ts | Latest-10 internal searches and replay semantics. |
| lib/research/usage.ts and limits.ts | Atomic reservations, concurrency leases, counters, and safe usage events. |
| lib/research/ai/* | Provider adapter, bounded interpretation loop, prompts, strict planner schema, and evaluation harness. |
| lib/mcp/* | MCP registration, verified OAuth identity, transport, discovery, and error mapping. |
| app/(app)/research/* | Research page, conversation controls, filters, result table, recent searches, and connection instructions. |

Server-only boundaries must prevent database credentials, model keys, OAuth secrets, and signing keys entering client bundles. Actor identity, access channel, scopes, and client ID are supplied by trusted adapters, never tool arguments.

Reuse and extract focused query fragments instead of copying the Explorer builder into a second drifting implementation. The new service needs strict direct volume bounds and explicit ordering. It does not require moving the entire existing Explorer onto a new architecture.

Preserve legacy Explorer URLs, saved views, CSV behavior, and the default layout. Research owns its new filters and result rendering. If implementation adds fields to ExplorerFilters instead of using an adapter, update every parser/default/serializer/saved-view/count/export path and prove compatibility. An “Open in Explorer” action is optional and may appear only when all active criteria can be represented losslessly; otherwise link to individual keyword details.

## 6. Data semantics: authoritative definitions

### 6.1 Current population and dates

Search the active keyword_current_summary population. Current eligibility includes terms last seen within 28 days of the dataset week. “Current” therefore does not guarantee observation in the latest week.

Every search returns datasetWeek, snapshotVersion, summaryRefreshedAt, resultCapturedAt, and per-keyword lastSeenWeek. Dates are ISO YYYY-MM-DD; timestamps are UTC ISO 8601. History uses week-end dates, not invented daily observations.

The weekly snapshot version is useful provenance but is not an immutable database revision. Keepa synchronization changes category/review aggregates in place. Section 9 specifies result capture so pagination remains consistent without rewriting all ingestion workers.

### 6.2 Demand and movement

estimatedMonthlySearches is the stored estimated_monthly_volume_current, an estimate derived from rank and calibration. It is not measured search count, sales, or the sum of weekly searches. Preserve integer values; do not round before applying bounds. Expose fit ID, calibration month when available, and extrapolation status.

For lookbacks use only 1w, 4w, 13w, 26w, or 52w. Reuse the current volumeDeltaExpr/volumePriorExpr convention:

- A missing prior rank uses a zero baseline for the existing Explorer-compatible delta calculation. Label that baseline as not_observed; it is not evidence that real demand was zero.
- A prior rank with missing calibration volume has an unknown baseline; delta remains null.
- Expose baselineStatus as observed, not_observed, or calibration_unavailable. These are evidence states, not automatic claims of a newly launched product.
- Growth presets require an observed baseline. Explicit newcomer-inclusive movement searches can opt into the existing zero-baseline convention and must disclose it.
- Do not manufacture percentage growth from a zero or unknown baseline. Percentage-growth filtering is outside v1; offer absolute change or current/prior thresholds.

Sorting by estimated monthly searches must use the actual volume field, not an approximate rank cutoff. SFR rank is a keyword search-frequency rank; lower is better. It is not a product's organic position or its sales rank.

### 6.3 Reviews, prices, and coverage

averageReviews is the existing stored integer average over available review observations for the top three clicked product slots. Null observations are ignored in that stored aggregate. It can reflect fewer than three observed products and is rounded by the existing database cast. Apply filters to this stored metric, not a newly recalculated unrounded mean.

Missing averageReviews is null, never zero. Any review range excludes null values. “Fewer than 500 reviews” is interpreted as fewer than 500 average reviews only with that metric visibly stated. If the user explicitly means each product, or a specific product slot, that filter is unsupported in v1 and must not be substituted silently.

Search rows carry a coverage caveat; they need not perform three product joins per row. Detailed results report per-slot review observations, source week, and actual enrichedAt where available. Distinguish the stored search aggregate from any later product observation; never imply that newly loaded detail values necessarily reproduce an earlier cached aggregate. Exact aggregate contributing-count/freshness values may be null unless computed from the same inputs at aggregate publication. Do not infer them from an unrelated current product query.

Current product prices, if displayed, use integer cents and the configured marketplace currency. The reviewed Keepa client uses domain 1; verify the application's US/USD source convention before publishing the guide. No marketplace selector or cross-market conversion is included. Price filters and profit estimates are outside v1; available prices can still be returned in keyword details.

### 6.4 Categories and flags

The searchable Keepa category path is the full path of the slot-1, most-clicked product. It is a proxy for keyword niche, not proof that every clicked product is in that niche. Broad Amazon category and Keepa taxonomy are separate dimensions; explain their distinction when both are used.

Default severity selection is none plus warning, excluding critical. A null severity follows the existing default-filter treatment of none, but remains null in output: it must not become a claim that the keyword was evaluated and cleared. Flags are indicators, not proof of fraudulent activity.

Title-gap filters mean selected product titles lack the keyword under a stated matching definition. Loose matching requires all non-stopword keyword tokens in the title; strict matching uses the Amazon-shipped flags. Missing title flags do not count as confirmed gaps. Preserve existing data-visibility/masking rules when mapping detail/history output.

## 7. Research vocabulary and interpretation policy

Maintain a small versioned catalog used by internal prompts, tool descriptions, get_research_guide, filter labels, and tests. Match concepts and combinations rather than enumerating every possible sentence.

| Phrase/intention | v1 interpretation or response |
|---|---|
| Over 10k searches | estimatedMonthlySearches.gt = 10000. |
| At least 10k searches | estimatedMonthlySearches.gte = 10000. |
| Less than 500 reviews | averageReviews.lt = 500, with the average metric displayed. |
| High demand | Suggested initial preset: estimatedMonthlySearches.gte = 10000. Visible and editable. |
| Low competition | Suggested initial preset: averageReviews.lt = 500; label it “low review competition,” a limited proxy. |
| High demand and low competition | Combine the two presets above; name both signals. |
| Best opportunities | Clarify preferred signals; offer the >=10000 / <500 preset for acceptance. No automatic best-score ranking. |
| Growing/trending keywords | Suggested initial preset: positive absolute estimated-volume change over 4w, observed baseline, sort by volume change descending. Display the window and definition. |
| Fastest-growing | Clarify absolute versus percentage growth if intent is unclear. v1 supports absolute-volume-change ranking. |
| Lighting niche | Resolve verified taxonomy scope; ask about materially different lighting sub-niches when needed. |
| My custom category called X | Find the connected user's exact/case-insensitive name; clarify non-exact matches. |
| Long-tail | Ask whether the user means keyword length; offer a word-count filter. No claim that word count alone measures purchase intent. |
| Title gaps | Offer explicit slots and loose/strict mode; catalog default is any of slots 1–3 missing the keyword under loose matching. |
| Lower reviews to 200 | Modify the existing upper bound to <200 if the prior bound was exclusive; preserve other criteria. If there is no prior bound, state the proposed comparator. |
| Compare these keywords | Internal page links to details; external client can compare bounded detail/history responses. No separate compare tool. |
| Seasonal, evergreen, stable, underserved | Clarify a measurable supported proxy, or offer external examination of available history. No undeclared classification algorithm. |
| Most profitable, cheap ads, guaranteed winner | Explain missing costs/PPC/profitability data and offer supported demand/review research. |
| All matching keywords | Explain paginated, capped retrieval and any remaining matches; do not claim exhaustive extraction. |

The suggested high-demand, low-review, growth, and title-gap definitions are explicit beta catalog defaults, not universal truths about Amazon markets. Store preset ID/version and the actual numerical filters so later catalog changes cannot reinterpret saved searches.

Ambiguity is handled before execution when it materially affects results. For a request mixing supported and unsupported criteria, name the unsupported condition and ask whether the supported subset is useful. Do not quietly execute a weakened request. A model may suggest alternatives but cannot invent data, claim observed profitability, or automatically broaden a search after zero matches.

## 8. Strict shared search contract

### 8.1 Validation rules

Use a strict versioned schema, reject unknown keys, and return field-level errors. Defaults apply only to omitted supported fields. Reject malformed/contradictory ranges, strings masquerading as numbers, NaN/infinity, unsafe integers, invalid UUIDs, unsupported enums, invalid category selections, and oversize input. Do not silently truncate filter arrays or drop short text.

Integer ranges have optional gt, gte, lt, lte; at least one bound, and at most one lower and one upper bound. An empty range object is invalid; null means no range. Domains: search volume/reviews >=0; ranks/word counts >=1; volume delta may be negative. Equal exclusive bounds and ranges containing no legal integer are invalid. Comparators are first-class; do not silently turn >10000 into >=10000. Query values are parameters; column names, operators, and ordering come from server allowlists.

### 8.2 Input shape

The following describes the public research-domain shape, not an instruction to accept arbitrary expressions:

~~~json
{
  "schemaVersion": 1,
  "presetIds": [],
  "filters": {
    "text": null,
    "estimatedMonthlySearches": {"gte": 10000},
    "averageReviews": {"lt": 500},
    "rank": null,
    "wordCount": null,
    "categories": {
      "selections": [],
      "leafPaths": []
    },
    "broadCategory": null,
    "severities": ["none", "warning"],
    "titleGap": null,
    "movement": null
  },
  "sort": {"field": "estimatedMonthlySearches", "direction": "desc"},
  "comparisonWindow": "4w",
  "pageSize": 50
}
~~~

Category arrays in this example are empty because the particular lighting scope must first be resolved. An actual resolved search inserts verified selections; an empty category scope means all active categories, never a failed category lookup.

For a new search, schemaVersion is required and equals 1. Filters may omit individual supported fields, which receive their documented defaults; an entirely omitted filters object means the canonical unfiltered active-population search. Every data return still requires permission and operating-limit checks. The optional top-level fields are presetIds (default []), sort (default estimatedMonthlySearches descending), comparisonWindow (see below), and pageSize (default 50). A continuation object contains only cursor.

presetIds accepts only high_demand_v1, low_review_competition_v1, growing_4w_v1, and title_gap_loose_any_v1 from the versioned catalog. Expand declared presets first, then apply explicit filter overrides and validate the complete result. Conflicting preset combinations require clarification instead of array-order precedence. Return actual applied values and overridden preset fields. An equal numeric filter does not prove the user requested a preset; only report a preset application when declared by the caller/interpreter. Once expanded, follow-ups and saved-search replay use the actual criteria; historical preset annotations do not automatically restore a filter that the user removed.

Allowed filter fields:

- text: {value, mode: word | broad}. Literal matching, 3–200 characters after trimming. For 1–2 characters return a clear validation error rather than removing the condition. Escape wildcard and regex metacharacters through the existing matching utility.
- categories.selections: union of {kind: taxonomy, path, includeDescendants} and {kind: custom, id}. Limit 25 selectors. Each selected taxonomy path is independently validated. Explicit leafPaths permit a verified leaf union; total expanded leaves must be <=2000, with <=256 characters per path as in the existing filter policy. Reject over-limit sets and offer narrowing.
- broadCategory: one verified broad category, combined with the leaf union using AND.
- severities: one to three distinct values from none, warning, critical. An explicit empty array is invalid, rather than a request to restore defaults or include everything.
- titleGap: {slots: [1,2,3], quantifier: any | all, mode: loose | strict}. The condition tests false flags, not null values; no duplicate/empty slots.
- movement: {window: 1w | 4w | 13w | 26w | 52w, metric: volume | rank, prior: IntegerRange | null, current: IntegerRange | null, delta: IntegerRange | null, baseline: observed_only | include_not_observed}. Delta is supported for volume only in v1. At least one movement bound is required. Rank movement uses prior/current rank ranges. With include_not_observed and metric=volume, absent prior rank uses zero as the explicit synthetic volume baseline; missing calibration for an observed prior rank stays unknown. With include_not_observed and metric=rank, require a prior lower bound (gt or gte), no prior upper bound, and a current upper bound (lt or lte); an absent prior rank satisfies the prior worse-rank bound without inventing a numeric rank. Reject other synthetic-rank combinations. Default baseline is observed_only.

Current-volume/rank bounds and movement.current both apply with AND; validate contradictory combined bounds before querying. Top-level comparisonWindow is one of the five supported lookbacks; when omitted it uses movement.window if present, otherwise 4w. If both are supplied they must agree. Return the effective window explicitly. Supported sort fields: estimatedMonthlySearches, rank, averageReviews, wordCount, volumeDelta, firstSeenWeek. Both directions are allowed. Default is estimatedMonthlySearches descending. Use NULLS LAST and searchTermId ascending as the final unique tie-breaker. A volumeDelta sort requires a computable delta and reports that eligibility condition; catalog growth additionally requires observed baseline and delta >0.

No user-supplied SQL, column names outside the enum, arbitrary functions, regular expressions, JavaScript, unbounded OR trees, or runtime evaluation. Multiple category selections are the one supported OR grouping; remaining active conditions use AND.

### 8.3 Search result contract

Every success contains schemaVersion, requestId, searchId, appliedFilters, effectiveSort, preset applications if any, resolvedCategoryScope, provenance, rows, pagination, and warnings.

- appliedFilters: normalized explicit criteria with defaults, never just the original prompt.
- resolvedCategoryScope: chosen selectors, expandedLeafCount, leafSetHash, up to 20 preview paths, and previewComplete. Persist the complete resolved leaf set server-side. The Research page can expand it through an authorized internal lookup. Parent selectors plus the resolved-set identity specify the search without sending thousands of paths to the model.
- provenance: datasetWeek, snapshotVersion, summaryRefreshedAt, resultCapturedAt, volumeFitRunId/calibration month/extrapolation flag where available, guideVersion, and queryVersion.
- rows: searchTermId, keyword, keywordUrl, estimatedMonthlySearches, averageReviews, rank, wordCount, categoryPath, broadCategory, severity, lastSeenWeek, firstSeenWeek, selected-window prior/delta values and baselineStatus when requested, and title flags/mode when relevant. Nullable metrics remain null. Use numeric JSON values, not formatted strings.
- pagination: pageSize, returnedCount, accessibleResultCount, totalMatches {kind: exact | at_least | unknown, value: number | null}, nextCursor, capped, capReason, and expiresAt.
- warnings: stable codes plus concise factual messages. Examples: ESTIMATED_VOLUME, PARTIAL_REVIEW_COVERAGE_POSSIBLE, STALE_KEYWORD_OBSERVATION, EXTRAPOLATED_VOLUME, BASELINE_NOT_OBSERVED, RESULTS_CAPPED, CATEGORY_DEFINITION_CHANGED.

Canonical keywordUrl is the configured application origin plus /explorer/keyword/{searchTermId}. It contains no credentials. The common metadata is sent once per result, not repeated in every row. The response is raw evidence for the external host to interpret; the server cannot guarantee that an external model will always phrase it correctly.

## 9. Stable pagination and data freshness

Recommended v1 choice: **bounded materialized result sets**. Capture at most 1001 matching summary rows in deterministic order within one coherent PostgreSQL read transaction. Retain the first 1000 rows as an immutable short-lived result set; the extra row is a truncation probe. This avoids promising stable cursors over metrics that can change during Keepa synchronization.

Store only the bounded research projection, not product blobs, full histories, or entire database rows. Maximum stored result payload is 2 MiB. Select/clip display strings using deterministic documented length bounds; never truncate matching keyword identity or numeric criteria. If the payload still exceeds the bound, reduce the accessible prefix, report capReason=payload, and preserve a truthful lower bound on matches. Do not fail by silently dropping random rows.

Bound the serialized evidence for one tool response to 256 KiB before its protocol-required text duplication. When a search page would exceed that bound, return the largest nonempty ordered prefix that fits and advance the cursor by returnedCount, not requested pageSize. Mark pageLimitedByBytes without marking the entire result set exhausted. If even required metadata plus one full row cannot fit, return RESPONSE_TOO_LARGE and request narrower scope; never remove an active criterion or alter keyword identity to fit. Apply equivalent output bounds to category/details/history responses.

The capture transaction reads metadata and rows from the same database view. Use a read-only REPEATABLE READ transaction when multiple statements are involved, or one atomic SQL statement that captures both. A default READ COMMITTED multi-statement transaction alone does not provide that guarantee. Release the transaction before model work or HTTP waiting. Transaction/query limits and a small connection pool are mandatory. Do not hold a database transaction across pages.

Recommended defaults:

- Initial page: 50 rows; maximum requested page: 100 rows.
- Captured accessible results: maximum 1000 rows per search.
- Result lifetime: 15 minutes, measured from capture, not extended indefinitely by paging.
- Maximum live result sets per account: 10 across both channels; evict the oldest with an explicit expired-result response on later use.
- Exact counts are not required. If the extra-row probe found another row, totalMatches is at_least with a truthful observed lower bound. If the query exhausted matches before any cap, the count is exact. Never infer the total from the number shown on one page.

These are configurable engineering defaults, separate from deferred monthly product allowances. Describe them in get_research_guide and the UI. A result cap is not a promise that repeated searches can extract the full dataset.

A signed opaque cursor binds result ID, owner, channel, offset, fixed page size, expiry, schema/query version, and filter fingerprint. On each continuation recheck identity, feature access, quota, signature, ownership, expiry, and bounds. Missing/expired/evicted results return SEARCH_EXPIRED and offer a new search. Never run a fresh query and splice it into an old cursor sequence.

Continuation uses the same search_keywords tool with cursor only. Reject cursor plus new filters/sort/pageSize. A filter or sort change starts a new result capture. A cursor is neither an access token nor permission to use the other channel.

Later details/history calls are fresh reads with their own timestamps; explicitly mark them as potentially newer than the captured search. No ingestion-worker generation counter is needed for the frozen result pages. Category-discovery caches still need short expiry because taxonomy/enrichment can change within a weekly snapshot.

## 10. Category resolution

resolve_categories is a deterministic discovery tool. The external host, or internal interpreter, supplies likely words and selects candidates. It must not incur a model call inside the MCP server.

Build a searchable catalog from existing full terminal paths and their parent segments, using current summary facets and the Category Builder taxonomy as appropriate. Search whole path segments and full paths with deterministic ranking: exact label/path first, then token/substring matches. A small maintained synonym map can normalize known niche vocabulary; do not introduce embeddings or a vector database for v1.

Return taxonomy candidates with full path, terminal/parent status, descendant-leaf count when known, and a scope selection descriptor. Custom-category candidates contain only this user's ID/name/leaf-count information. Distinguish estimated/capped counts if the underlying lookup is bounded.

Support bounded refinement by parentPath and cursor. Default 20 candidates, maximum 50. An empty query is allowed only for root browsing or listing the current user's custom categories; a general empty-query dump of the full taxonomy is not allowed. Source is taxonomy, custom, or all. Never treat a candidate's popularity as permission to silently select it.

Search-time resolution revalidates selected references, expands selected parents/custom categories into actual full leaf paths, deduplicates, sorts canonically, and applies OR. A missing, unauthorized, deleted, or empty custom category returns CATEGORY_NOT_AVAILABLE; do not reveal whether another account owns the ID. A failed/empty expansion must never become an unfiltered search.

For a taxonomy selector, includeDescendants=true includes every verified terminal path at/below that path, including the path itself when it is also terminal. With includeDescendants=false the selected path must itself be terminal. Parent-child matching uses complete path segments and the canonical separator, so a text prefix such as “Lamp” cannot accidentally match a sibling called “Lampshades.”

Broad lighting includes materially different choices: household lamps, outdoor lighting, seasonal lights, photography/studio equipment, and other taxonomy branches. Ask one focused question if scope is uncertain. An explicit named category or sufficiently specific niche can run immediately with the chosen scope shown. Do not hard-code the four-leaf lighting sample from the review as “all lighting.”

Use a bounded TTL, initially 60 seconds, for public taxonomy discovery caches, keyed by dataset identity as well. Never share custom-category results between accounts. Validate actual selected paths at execution; do not rely on a stale facet cache as an authorization source.

## 11. MCP tools

Register exactly these five research tools for v1. All have strict input/output schemas, read-only annotations, concise action-oriented descriptions, and documented bounds. Tool discovery descriptions and a compact server instruction explain sequencing, nulls, estimates, limits, and clarification behavior. The protocol's structured result and text representation contain equivalent evidence. Use the SDK's protocol-era encoding rather than constructing version-specific wire envelopes manually.

Use server name keywordquarry and display name KeywordQuarry, a versioned server release, and object-shaped outputs for compatibility. Set readOnlyHint=true, destructiveHint=false, and openWorldHint=false truthfully; readOnlyHint describes the business capability, while documented internal caches/accounting still occur. These hints are not security enforcement. Test tools/list and each input/output schema with the selected SDK and both clients.

### 11.1 get_research_guide

Input: empty object. Output: schema/guide versions; supported metrics/filters/sorts/windows; definitions and preset IDs with exact thresholds; category behavior; current-data population and limitations; configured technical caps; and authenticated feature availability when useful. No email, full user profile, secret, or other-account information.

Its purpose is interpretation, not a large marketing/help dump. Critical instructions must also be in search/detail/history tool descriptions because a host may omit this call.

### 11.2 resolve_categories

Input: query, source, optional parentPath, limit, and optional cursor, with mutually exclusive continuation rules. Output: bounded candidates, nextCursor, provenance, and unresolved/no-match status. This tool discovers options; it does not create custom categories or silently execute a keyword search.

### 11.3 search_keywords

Input: either a validated new search as in section 8 or {cursor}. Output: section 8.3. No actor/user ID, raw prompt requiring server AI, or entitlement parameter. The same exact filters must identify the same rows through both adapters at the same captured data state.

### 11.4 get_keyword_details

Input: {searchTermId: UUID}. One keyword per call. Output: canonical keyword identity/link; active/dormant status; current summary metrics and provenance; up to three clicked product slots with ASIN/title and available prices/reviews/click/conversion shares; title flags; available source week/enrichedAt; coverage caveats and severity context.

Use the stored current-volume field for current comparisons. Historical calculations can use their per-week calibration fits. Preserve source measurement units: explicitly define whether shares are percentage points, based on the existing import convention. Expose ratings as stars only after converting the stored 0–50 scale by dividing by 10. Missing values remain null. Do not fetch images or product URLs to answer this tool.

Use a bounded enrichment lookup matching the application's latest-active-source-at-or-before-week aggregate policy where possible. Report the selected source week and timestamp, and keep stored aggregate versus freshly observed product measurements distinct. A dormant keyword can return current=null and available historical identity. An unknown UUID returns KEYWORD_NOT_FOUND.

### 11.5 get_keyword_history

Input: {searchTermId: UUID, weeks: integer 1..52}, default weeks=13. Output: requested calendar window ending at the current dataset week; actual observed dates; oldest-first points; rank, estimated monthly searches, calibration/extrapolation information, available title flags/severity; missing weeks; series source/update time and coverage warnings.

The calendar window matters: do not return 13 old observations spanning several years and label them “the last 13 weeks.” Include week-end dates from datasetWeek minus (weeks-1)*7 days through datasetWeek, inclusive. Filter the cached series to that window. Absent weeks are missing observations, not fabricated zero-demand points. Keep point fields compact; product lists and variants belong to details, not every history row.

Prefer keyword_chart_series. A cache miss may use a bounded raw-history fallback subject to the same query deadline. Do not inherit a 60-second cold scan without bounds, trigger enrichment, or claim missing cache equals no history. If a source is stale and cannot be refreshed within the deadline, return clearly identified stale coverage or HISTORY_UNAVAILABLE as appropriate; never hide freshness differences.

### 11.6 Host behavior and read-only scope

For the original question: resolve category candidates, clarify if necessary, call search_keywords with explicit bounds, summarize returned evidence, and follow nextCursor only as needed. For follow-ups the host supplies a complete new filter object; MCP contains no hidden per-conversation filter state. For comparisons the host requests details/history for the selected bounded IDs.

The server provides KeywordQuarry evidence only. External clients may have other tools enabled; tool instructions request source separation, but the server cannot prohibit a host from browsing independently. Do not market host-wide data exclusivity as a guarantee.

## 12. Internal Research page and model orchestration

### 12.1 Page behavior

Route: /research. Use the current application layout/style and an admin-visible navigation item. Main components: prompt input, compact conversation/clarification area, current editable filters, category scope summary with expansion, result summary/table, pagination, recent searches, and “Connect your AI” instructions linking to /research/connections.

The shared /research layout may check session/admin identity, but it must not make the connection page depend on RESEARCH_ENABLED. Gate the main Research page by its own feature and /research/connections by MCP access. Keep MCP connection instructions reachable when internal AI is disabled. Navigation reflects the independently available entry points.

Initial empty state offers example prompts, including explicit thresholds, a specific niche, and the “best opportunities” clarification flow. Label admin preview. Do not imply public or paid availability yet.

Show pending status, cancellation, validation errors, and a retry path. Prevent accidental duplicate submissions. A slower earlier request must not overwrite a newer search; use a per-turn request ID/revision and ignore stale UI responses. Make loading/results/errors accessible through appropriate labels, keyboard handling, focus, and live regions.

Manual filter changes and pagination call deterministic handlers with no model request. “New search” clears current criteria and ephemeral conversation state. A table row links to the existing keyword detail page. The internal assistant can point to details for deeper investigation; it need not implement a general multi-step research agent.

### 12.2 Internal HTTP handlers

These are private application endpoints, not the future paid developer API:

| Proposed route | Purpose |
|---|---|
| POST /api/research/ask | Bounded interpretation, clarification, or search response. |
| POST /api/research/search | Execute exact edited filters or a continuation cursor without a model. |
| GET /api/research/categories | Bounded category discovery for manual filter controls using the shared resolver. |
| GET /api/research/recent | Return this account's latest 10 internal searches. |
| POST /api/research/recent/{id}/rerun | Revalidate saved scope and rerun against current data. |
| GET /api/research/results/{id}/scope | Owner-authorized complete resolved category paths for UI expansion. |
| POST /api/research/mcp/disconnect | Revoke the account's MCP authorization/grants using the verified provider flow. |

Every handler validates a session-authenticated admin and the relevant feature. Enforce same-origin/CSRF protections on cookie-authenticated mutations and quota-consuming actions. Remote bearer auth is handled separately; do not copy a browser-only fetch-site guard onto MCP and block legitimate remote clients. Use Cache-Control: no-store for personalized responses.

### 12.3 Interpreter responsibilities

Use a server-controlled system prompt plus catalog, current structured filter state, and a bounded recent conversational context. User/product/category text is untrusted data. Current filters are the authoritative state, not a reconstruction from chat prose.

The planner returns a strict discriminated response:

- search: explicit changes to allowed fields (set/clear), resolved category selections, recognized preset applications, and a short factual interpretation.
- clarify: one focused question with two or three suggestions and pending criteria.
- unsupported: missing data/capability and a supported alternative.

The host validates and merges changes into current criteria. Omitted fields stay unchanged on a follow-up; only an explicit clear/reset removes them. The host then validates the complete plan and performs one search. A new-search action starts from canonical defaults. Show any applied presets and assumptions.

Keep the pending clarification plan and candidate IDs in bounded page state alongside the last executed filters. A response such as “yes, use those thresholds” resolves that pending plan, preserving the original niche and other criteria. Revalidate pending values on the server. When the user changes topic or starts a new search, discard the old pending plan. A clarification never silently replaces the displayed current result set.

Allow bounded calls to the deterministic guide/category resolver during interpretation. Default maximum four category lookups and three model round trips per user submission, including one schema-repair attempt. Exceeding the bound produces a clarification/error, not an open-ended agent loop. The model is not given SQL, ingestion, web, or arbitrary-code tools.

Prefer deterministic result summaries derived from applied filters, scope, counts, and warnings. The result table always renders structured database output. A second model pass to narrate rows is not required in v1. Zero results can offer catalog-defined relaxation suggestions, but execution waits for acceptance.

Keep at most 10 recent user/assistant exchanges (20 messages) in in-memory browser state, subject to the total context-size bound; do not persist a full transcript. The saved latest-10 searches are separate. Treat client-supplied history/currentFilters as untrusted, length-bound context and revalidate every filter/reference on the server. No identity or privilege comes from that context.

### 12.4 Provider selection

Provide a narrow provider adapter with structured planning output, cancellation, token accounting, and request IDs. Implement one selected provider for launch; do not build a user-facing model picker or require customer API keys. Configure provider/model server-side.

Before enabling the internal feature, evaluate current suitable OpenAI/Anthropic models using section 18's cases. Select based on constraint fidelity, category/clarification behavior, latency, and measured cost. Record the selected exact model ID, prompt/catalog versions, pricing source/date, and evaluation results in the implementation report. Do not choose an obsolete model based on this document's creation date or the owner's consumer subscriptions.

Model/API credentials and billing belong to a server-side API project; the owner must provision them separately from ChatGPT/Claude subscriptions. Missing model configuration disables natural-language interpretation with a clear admin message; it must not break MCP or unrelated application builds.

## 13. Recent searches and persistence

Introduce a small user-owned recent-search table with UUID, userId (cascade delete), unique per-user submission ID, createdAt, prompt or deterministic edit label, schema/query/guide/preset versions, canonical filters, sort and comparisonWindow, full resolved leaf set, original category references/definition hashes, and original dataset/capture timestamps. Store compact explanation metadata if useful; not a full chat transcript or complete result rows.

Each completed new search or follow-up that changes criteria/sort creates one entry, including a valid zero-result search. Pagination, clarification-only turns, provider failures, and validation failures do not create entries. Manual edits use a generated label such as “Manual change: average reviews <200.” An unchanged rerun creates a fresh entry marked as a rerun. MCP searches do not populate website recent history; their conversations stay with the client.

Insert and trim to the latest 10 atomically per user. Use a short user-keyed database lock/transaction or equivalent serialization, ordered by createdAt and UUID, so concurrent requests cannot exceed the cap. Deduplicate a retried submission ID. Do not hold that lock while querying analytics or calling the model.

Persist the new result set and applicable recent-search entry together in a short transaction after analytics capture, enforcing result-set eviction under the same per-account serialization. If persistence fails, return DATA_UNAVAILABLE rather than a success with a broken continuation or a falsely saved history item. Settle any already-incurred model usage separately and idempotently.

On reopen, execute against current metrics using the stored resolved leaf scope. Revalidate ownership and existence of referenced custom categories. If a still-owned category's definition changed, display “Using the category scope saved with this search” plus CATEGORY_DEFINITION_CHANGED; use the stored set until the user explicitly chooses the current definition. Deleted/unauthorized custom references return CATEGORY_NOT_AVAILABLE. Removed taxonomy paths prompt a new scope selection; never silently remove them and widen a search.

The replay operation supplies that validated stored leaf set through a trusted service path; it must not accidentally call ordinary current-definition expansion and replace the saved set. This special path accepts an owner-checked saved-search ID, not a client flag that bypasses category validation.

Save old dataset date for comparison but label new results “Refreshed using [dataset week].” If the saved schema is obsolete, migrate it explicitly or return SAVED_SEARCH_VERSION_UNSUPPORTED. Replaying a saved search is not a way around current limits or entitlement checks.

Operational tables also include:

- research_result_sets: owner, trusted channel, capture/expiry timestamps, canonical criteria, full resolved scope, provenance, immutable bounded rows, truthful count/cap metadata. This table has no dependency on the last-10 history retention.
- research_feature_access: unique user/feature (research, mcp, future api), enabled/disabled status, source, optional expiry, and updatedAt. Explicit disable overrides the admin default. Future api access is hard-disabled in v1.
- research_usage_buckets: atomic account/bucket counters for request/row/cost reservations and settlement.
- research_request_leases: request ID, account, expiry, operation/channel for concurrency control. A companion bounded request-outcome record or terminal fields provide retry deduplication; active-lease expiry and completed-outcome retention are separate lifetimes.
- research_usage_events: operation/channel, trusted account/client ID, status, durations, returned/materialized row counts, model ID/token usage/cost when applicable, and versions. No secrets or full prompts.

Use existing Postgres infrastructure for beta; an additional Redis deployment is not required. Keep operational transactions short. Prove contention behavior with concurrent tests. Expired caches/leases must be unusable immediately even before physical cleanup. Add bounded cleanup to the existing job system: expired result sets/leases at least hourly and diagnostic usage events after 30 days, retaining aggregate daily counts/costs for 90 days. History retains only its latest 10 entries until deleted with the account. Document these defaults.

## 14. Authentication, authorization, and paid-access foundation

### 14.1 Access policy

The service receives a trusted actor containing local user ID, verified Clerk user ID, channel, and verified client information. Callers cannot set userId, role, channel, entitlement, token scopes, or quota bypass through any research schema.

For this release allow a request only when its feature switch is enabled, the account exists and is active, local role is admin, no explicit feature suspension applies, and operating limits permit it. An admin's free test access is the default under the switch; an explicit disabled access record still blocks it. A manually enabled entitlement for a standard user must not bypass the beta admin-only gate.

Future commercial access replaces only the audience policy: an active paid MCP entitlement will be required, independently from ordinary website access. Keep the policy centralized and expose separate research/mcp/api entitlements. Do not turn off the admin-only gate or build checkout as part of this implementation. A later API must join the same account-level data-access accounting so separate adapters cannot bypass extraction limits.

### 14.2 OAuth and Clerk

Use Clerk as the preferred OAuth authorization server, with a server-side MCP bearer-token verifier. Browser session auth and remote OAuth are separate adapter paths that resolve to the same local account. Require an already-linked local account for remote access; return an actionable “Sign in to KeywordQuarry first” response if missing. Preserve existing verified browser provisioning/relink logic. Do not create or relink a local account from a tool-provided email or unverified token payload.

Define and enforce the custom scope keywordquarry:research:read for all five tools. Register/assign/advertise it in the actual Clerk configuration; merely publishing its name is insufficient. Request only necessary identity scopes, and offline_access through authorization-server metadata when refresh support is used. Do not expose Clerk private/public metadata, user profile tools, or admin capabilities. Clerk currently documents custom scopes and backend checking of granted scopes: [Clerk OAuth configuration](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth) and [token verification](https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens).

Verify token type, authenticity/active state, expiry, issuer/instance, intended resource/audience, required scope, and verified client identity. Resolve the local user and current role/access record for every request, including cached continuations. Do not accept consumer-model API keys, session cookies, ID tokens, arbitrary JWTs, or another service's bearer token at the MCP endpoint. Opaque tokens require the provider's supported verification/introspection path; do not decode them as JWTs. Do not equate an OAuth client ID with a resource audience.

Token audience binding is a protocol requirement; the exact verified Clerk token fields and resource configuration must be demonstrated in the compatibility milestone. The existing SDK/configuration has not been live-tested for this application. If it cannot prove resource binding, keep MCP disabled and report the precise integration gap rather than shipping a weaker validator or inventing a second custom OAuth server. [MCP authorization requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

Prefer explicitly configured ChatGPT/Claude OAuth clients for the small beta. Where appropriate use supported Client ID Metadata Documents; Clerk currently identifies CIMD as an account-enabled beta. Use DCR only when a tested client requires it. Delegate OAuth mechanics, redirect validation, PKCE S256, code exchange, and refresh to maintained provider/SDK components. Do not write a home-grown OAuth implementation. [Clerk Next.js MCP guide](https://clerk.com/docs/nextjs/guides/ai/mcp/build-mcp-server)

### 14.3 Discovery, transport, and revocation

Canonical proposed endpoint: https://keywordquarry.com/api/mcp, with a corresponding staging origin. Configure the canonical resource URL; do not construct it from an untrusted Host header. Publish the appropriate OAuth protected-resource metadata and authorization-server discovery required by the selected clients. These metadata documents are public, contain no account data, and must bypass browser-login redirects. Tool calls require authorization. Use proper 401/403 challenges rather than an HTML sign-in page or a 200 success with an auth-error string.

Use maintained TypeScript SDK HTTP support in the Node.js runtime. Current protocol and 2025-era client lifecycles differ; pin a mutually compatible SDK/auth/adapter set and use its documented legacy support where needed. Do not mix the v2 package API with an older mcp-handler tutorial without verifying compatibility. No business state depends on an in-memory transport session. [Official SDK compatibility guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

Set and test bounded request bodies, Origin/Host validation appropriate for browser and server clients, allowed methods, and discovery CORS. A missing Origin from a legitimate server client is not automatically a CSRF violation. Tools and personalized responses are not publicly cached. Authenticate every tool call even if discovery was previously authorized.

The connection page offers separate ChatGPT and Claude instructions, copyable endpoint URL, required account/setup conditions, read-only permission explanation, and disconnect instructions. Do not claim a connection is active merely because the user clicked an onboarding link; show last verified successful MCP request if available.

Disconnect must revoke the applicable provider authorization/access and refresh grants, then deny reuse. Removing feature access blocks subsequent calls immediately at the application layer. Prove that an old token cannot revive just by re-enabling the feature after a disconnect; require a fresh authorization grant. If provider revocation cannot be completed, keep access disabled and report the failure instead of reporting successful disconnect. No bearer/refresh token is stored in website history or logs.

## 15. Operating limits and accounting

Use configuration for technical bounds; these values are initial beta recommendations and are not monthly commercial pricing decisions:

| Control | Initial default |
|---|---:|
| Prompt length | 4000 characters |
| Internal context | Last 10 exchanges / 20 messages, 20,000 characters total |
| HTTP request body | 128 KiB |
| Tool evidence payload, before text duplication | 256 KiB |
| Search page | 50 default / 100 maximum rows |
| Captured result set | 1000 rows / 2 MiB maximum |
| Result expiry | 15 minutes |
| Live result sets per account | 10 across channels |
| Category candidates | 20 default / 50 maximum |
| Expanded category scope | 2000 leaves maximum |
| History | 13 weeks default / 52 maximum |
| Concurrent expensive operations per account | 2 across both features |
| Global expensive research operations | 6 across processes, configurable for measured DB capacity |
| Internal AI submissions | 10 per rolling minute per account |
| Deterministic research requests | 60 per rolling minute per account across adapters |
| Search/details/history SQL deadline | 10 seconds per operation, including fallback work |
| Category SQL deadline | 3 seconds |
| Overall MCP operation deadline | 15 seconds |
| Internal interpretation + query deadline | 30 seconds |
| Planner work | Up to 3 model round trips and 4 category lookups |

Control concurrency with shared short-lived leases and a deadline longer than the permitted operation plus cleanup margin. Release leases in finally; expiry handles crashed processes. Use atomic counter/reservation transactions, not the current soft export read-then-bump pattern. Quota/authorization storage failures fail closed for these new paid-access surfaces while unrelated Explorer routes retain their existing behavior.

Set per-request model input/output caps and a required owner-configured daily AI spend ceiling before enabling internal AI. Estimate the maximum request cost from configured prices and reserve it atomically; settle against returned provider usage, including billable reasoning/cached token classes as applicable. Do not launch paid requests if cost configuration is missing. This technical spend control is independent from the deferred monthly user allowance.

Count accepted operations, successes/errors, data rows returned on every page, rows materialized, provider tokens/cost, and DB/overall duration separately. A prompt can make several tool calls; one model message is not the same as one billable data request. No pricing unit is selected by this specification. Repeated read pages consume request/row counters because data is being delivered again, even if served from cache.

Internal submission IDs prevent accidental duplicate model charges/history writes on retries. Retain bounded terminal request outcomes for 15 minutes, separately from active concurrency leases. Outcomes contain a result reference or a compact clarification/error, not the submitted transcript. If the same ID and payload completed, return its stored outcome within that window; if still in progress, return an in-progress response. Reuse with a different payload is a conflict. A retry cannot resurrect an expired result or bypass a fresh access check. Do not assume an MCP JSON-RPC ID is a globally unique billing idempotency key.

Monthly request/row allowances may be unset during admin-only testing. Configuration must distinguish unset from zero. Before any non-admin paid release, require explicit allowances and subscription enforcement; that release is outside this task.

## 16. Errors and response integrity

Use stable domain codes with safe messages, retryable flag, optional retryAfterSeconds, and field details without SQL, tokens, connection strings, or other-account information. Map protocol errors through the SDK and tool execution errors through its supported error-result mechanism. HTTP authentication failures retain proper status/challenge behavior.

| Code | Meaning and behavior |
|---|---|
| UNAUTHENTICATED / TOKEN_INVALID | Authenticate/reconnect; HTTP 401 for transport auth. |
| INSUFFICIENT_SCOPE / ACCESS_DENIED | Valid identity without required permission; 403. |
| FEATURE_DISABLED | Entry point disabled; no data/model call. |
| ACCOUNT_NOT_LINKED | Sign into KeywordQuarry through the normal account flow. |
| INVALID_FILTERS / UNSUPPORTED_FILTER | Explain exact invalid/unsupported fields; do not run a weakened query. |
| CATEGORY_NOT_AVAILABLE / STALE_CATEGORY_SCOPE | Re-resolve scope; do not broaden. |
| KEYWORD_NOT_FOUND | Unknown ID, consistent non-leaking response. |
| SEARCH_EXPIRED / INVALID_CURSOR | Start a new search; do not splice fresh rows into old pages. |
| SAVED_SEARCH_VERSION_UNSUPPORTED | Saved criteria cannot be safely interpreted. |
| RESPONSE_TOO_LARGE | Required evidence cannot fit a bounded response; request narrower scope without dropping criteria. |
| RATE_LIMITED / CONCURRENCY_LIMITED / USAGE_LIMIT_REACHED | Retry after the indicated interval or explain account allowance. |
| QUERY_TIMEOUT | Narrow/retry; not equivalent to zero matches. |
| HISTORY_UNAVAILABLE / DATA_UNAVAILABLE | Explain unavailable or stale source; avoid invented data. |
| MODEL_UNAVAILABLE / MODEL_OUTPUT_INVALID | Preserve prior filters/results and offer retry/manual filtering. |
| REQUEST_CONFLICT | A submission ID was reused inconsistently. |

No-match search is a successful empty result. Estimated/capped counts and partial coverage are successful results with explicit metadata, not hidden errors. SQL/query cancellation must actually stop or deadline-limit database work; Promise.race alone is insufficient. A canceled request may have incurred model usage and must still be accounted for truthfully.

Use JSON/escaped text for keyword and product strings. Do not render arbitrary HTML or follow instructions inside returned titles. Generate links from validated IDs and the configured origin. Tool names, capability permissions, and result totals cannot be changed by instructions in a user prompt or product title.

## 17. Migrations, deployment, and rollback

Use additive migrations compatible with the existing deployment while both feature switches default off. New operational tables reference users with cascade deletion and have owner/expiry/request lookup indexes. Validate schema versioning and result bounds in application code and appropriate DB constraints. Include the repository's migration journal/snapshots as required; inspect the current next migration number at implementation time.

First benchmark combined category/volume/review queries on a representative non-production dataset. Existing category covering indexes do not include volume. A new filter must disable an ineligible optimized branch or use a verified index/query design; it cannot be dropped for speed. Any new current-summary index must also be represented for the stage table/refresh path. Preserve expression identity where existing volume-delta partial indexes depend on it. Large index builds/backfills need a deployment procedure that does not unexpectedly lock production.

Existing app/worker environment variables retain their meaning. Add documented server-only configuration for:

- Independent RESEARCH_ENABLED and MCP_ENABLED switches, default false; admin-only audience remains enforced in code for v1.
- RESEARCH_AI_PROVIDER, RESEARCH_AI_MODEL, selected provider API key, price configuration, and RESEARCH_AI_DAILY_BUDGET_USD.
- RESEARCH_CURSOR_SECRET with a strong random value and rotation behavior (rotation expires outstanding cursors).
- Canonical APP_PUBLIC_URL/MCP resource URL and verified OAuth client/scope settings; use the existing Clerk credentials correctly.
- Validated technical-limit overrides from section 15; no arbitrary client overrides.

Read model-specific configuration lazily behind the internal feature so missing credentials do not break other routes or MCP. Do not include real secrets in fixtures, documentation, screenshots, or commits. Separate staging and production identities, tokens, databases, and model projects where available.

Roll out in order: additive schema and disabled code; representative integration/performance tests; real OAuth/client compatibility; admin MCP; admin Research with model/spend settings; regression verification. Keep the two switches independent. Feature rollback is to disable the affected switch and stop new expensive work; preserve existing site functionality. Do not drop tables during emergency rollback. Expired cache cleanup may continue.

## 18. Verification and acceptance cases

### 18.1 Required test layers

1. Pure tests for schema/comparators, intent/preset definitions, category expansion, predicate compilation, count metadata, serialization, cursor verification, and follow-up merging.
2. Database integration tests against a disposable database/Neon branch for exact rows, owner isolation, concurrent quota/history operations, transactions, expiration, and snapshot consistency. Inspect test setup first: current setup loads .env.local.
3. Handler/protocol tests for session versus OAuth auth, metadata challenges, protocol versions, strict tool schemas, read-only annotations, failures, and disabled flags.
4. Browser checks for the full Research flow, manual filters, history replay, errors/cancellation, keyboard access, and non-admin exclusion.
5. Live owner-account tests in ChatGPT and Claude, recording exact client surface/plan/date and SDK/auth versions. An SDK simulator alone is not evidence of successful client onboarding.
6. Model evaluations separate from deterministic tests. Use mocked model responses in routine CI and explicitly configured live provider runs for quality/cost comparison.

### 18.2 Semantic and regression matrix

Use fixed synthetic fixtures and assert exact ordered IDs, not merely plausible prose. Include category overlap, duplicate leaf names under different parents, ties, zero/null reviews, partially enriched products, missing calibration, absent historical observations, dormant terms, warning/critical/null flags, and values exactly at each threshold.

| ID | Scenario | Expected result |
|---|---|---|
| Q01 | Volume >10000, reviews <500 | Exclude exactly 10000 and exactly 500; exclude null values in either filtered metric. |
| Q02 | Volume >=10000, reviews <500 | Include exactly 10000 when other criteria match. |
| Q03 | Reviews <=500 versus <500 | Boundary inclusion differs correctly. |
| Q04 | Reviews equal zero | Zero is legal; unknown is excluded. |
| Q05 | Inverted, impossible, fractional, or unsafe bounds | Reject before SQL; no default search. |
| Q06 | Several leaf paths | OR within the deduplicated set; AND with numeric criteria. |
| Q07 | Same leaf label under different parents | Full paths keep scopes distinct. |
| Q08 | Unknown/deleted/other-user custom ID | Generic category error; never an unrestricted query or existence leak. |
| Q09 | Parent expansion exceeds 2000 leaves | Explicit narrow-scope response; no silent truncation. |
| Q10 | Broad “lighting” with conflicting branches | Focused scope clarification or clearly justified explicit scope; no guessed universal lighting list. |
| Q11 | “Best opportunities” | Clarify signals and offer >=10000 / <500; wait for selection. |
| Q12 | Explicit numbers plus vague preset | Explicit bounds override the preset without silently dropping other explicit conditions. |
| Q13 | “Lower the reviews to 200” | Change only that bound, preserving category, volume, severity, and sort. |
| Q14 | “Remove the review filter” | Explicitly clear it; preserve the rest. |
| Q15 | “Most profitable” plus supported filters | Identify unsupported profit criterion and offer supported alternative before execution. |
| Q16 | Missing prior rank versus missing fit | Distinct baseline statuses; no invented positive/percentage growth. |
| Q17 | Growth preset | Observed baseline, 4w, positive delta, descending delta; expose assumptions. |
| Q18 | Title-gap any/all with null flag | Correct Boolean semantics; null does not prove a missing keyword. |
| Q19 | Default severities | Include none/warning and existing null treatment; exclude critical. |
| Q20 | Volume sort with ties/nulls | Actual volume order, nulls last, UUID tie-breaker. |
| Q21 | No matching rows | Successful empty result; no automatic relaxation. |
| Q22 | Query/model timeout | Explicit error, prior UI state preserved; no fabricated zero results. |
| Q23 | More than result cap | Capped lower-bound total, accessible prefix, honest final-page message. |
| Q24 | Pagination while Keepa/weekly data changes | Captured rows and order remain stable; new search sees new data. |
| Q25 | Cursor tampering, owner/channel swap, expiry | Reject; no fresh-query fallback or unauthorized data. |
| Q26 | Concurrent history inserts and retry | At most 10 entries; duplicate submission stored once. |
| Q27 | Replay after dataset update | Same saved resolved scope, current data, explicit refresh label. |
| Q28 | Replay after custom-category change/deletion | Changed definition warning with saved scope; deletion produces explicit category error. |
| Q29 | History with missing calendar weeks | Gaps remain missing; no zero fill or mislabeled older observations. |
| Q30 | Dormant keyword details | Historical identity available, current=null; no invented current metrics. |
| Q31 | Hostile SQL/wildcard/category/product text | Safe literal/parameterized handling; no extra tools, code, URL requests, or instruction execution. |
| Q32 | Identical criteria through internal/MCP adapters | Same captured fixture rows, values, filtering, and provenance semantics. |
| Q33 | Existing Explorer/saved views/CSV export | Existing accepted behavior and row/cap rules remain intact. |
| Q34 | Short text input or unknown filter key | Explicit error rather than silently removing the criterion. |
| Q35 | Manual filter edit/pagination | No model provider call. |
| Q36 | Provider unavailable, MCP healthy | MCP continues working; missing internal provider configuration does not crash unrelated routes. |
| Q37 | “Yes, use those thresholds” after clarification | Resolve the pending plan and retain the original niche and other criteria. |
| Q38 | Removing a filter originally set by a preset | Clear the actual bound; old preset metadata cannot silently restore it. |
| Q39 | Page constrained by payload bytes | Advance by actual returned rows; no omissions/duplicates or false exhaustion. |
| Q40 | Result/history persistence failure | Explicit unavailable response; no broken success cursor or falsely saved history; usage settles once. |

### 18.3 Access, accounting, and client cases

- Anonymous request, browser cookie presented to MCP, wrong token type, wrong instance/audience, expired/revoked token, missing scope, and unlinked account.
- Standard user with a valid token, including a manually enabled entitlement: blocked during admin beta.
- Admin role removed or feature disabled after a successful first page: next tool/page blocked.
- Explicit per-feature suspension overrides admin payment bypass; one switch does not disable the other feature.
- Another user's recent-search ID, result ID, custom-category ID, or cursor never returns their data.
- Provider disconnect blocks both existing access and refresh paths; re-enabling does not resurrect an old disconnected grant.
- Parallel quota requests reserve atomically; operation cap cannot be exceeded by racing requests or separate client IDs.
- Failed/canceled requests release leases; expired leases recover after simulated crashes; usage settlement does not double-charge a retry.
- A usage-store outage denies new protected work, with no model/database operation escaping the guard.
- Discovery is reachable without cookies; auth challenge leads to the intended Clerk flow; consent displays the research scope; refresh/reconnect and tool rescan work in both clients.
- All five tools appear and work in ordinary ChatGPT and Claude conversations, with truthful limitations and canonical links. Do not claim their special research modes were tested if they were not.

### 18.4 Model evaluation and performance targets

Create at least 50 prompts spanning the catalog, paraphrases, compound filters, follow-ups, ambiguous categories, unsupported concepts, boundary comparators, and prompt-injection strings. Expected outcomes specify search/clarify/unsupported and exact criteria. All critical numerical-boundary, authorization, scope, and unsupported-condition cases must pass. Target >=95% correct overall interpretation across repeated representative runs; report failures and variance rather than a single favorable run. Deterministic validation/security tests require 100% pass.

Measure warm and cold DB/API paths separately. Initial targets: warm deterministic search p95 <=3 seconds for representative scoped queries; end-to-end internal response p95 <=10 seconds for ordinary successful prompts; hard deadlines from section 15 always enforced. Record dataset size, query mix, concurrency, sample size, warm/cold conditions, and token cost. These are acceptance targets, not claims about current production performance. If missed, optimize the measured query/model path or explicitly report the limitation before enabling it.

Useful baseline commands (adapt to the implementation environment):

~~~powershell
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/vitest/vitest.mjs run --reporter=dot
pnpm lint
pnpm build
~~~

Run integration tests only after verifying their environment uses an isolated test database; the existing test:integration command is not safe to assume isolated. Include production-build validation and real client/browser evidence in the implementation report. This document makes no assertion that the current revised application test suite has been run or passed.

## 19. Implementation sequence and required handoff evidence

This is a dependency order for Claude Code, not permission to deploy production or change product scope:

1. Reconcile current HEAD/AGENTS.md and preserve concurrent work. Read the installed Next.js route/auth/runtime guidance. Inventory existing migration and test conventions.
2. Prove the OAuth/SDK/client compatibility path using minimal authenticated read-only behavior in staging. Pin compatible dependencies. Record issuer/resource validation, scope enforcement, registration mode, refresh/revoke behavior, and both clients. Continue independent service work if external setup is unavailable, but label MCP connectivity unverified.
3. Implement strict contracts, catalog, trusted-actor/access policy, shared query predicates, category resolution, and fixture-based semantics tests.
4. Add atomic operational storage, limits, result snapshots/cursors, and latest-10 history with isolated integration tests.
5. Implement five MCP tools, metadata/error mappings, and protocol contract tests over the shared service.
6. Implement the Research page and deterministic handlers, then the bounded interpreter/provider adapter and live model evaluation.
7. Complete regression, browser, real-client, and performance checks; document setup, limits, migrations, feature switches, failure modes, and rollback.

Claude Code must deliver:

- Source changes and additive migrations with focused tests.
- A configuration example containing variable names and safe placeholders only.
- A maintained capability/metric catalog and versioned tool input/output schemas generated from the same validation source.
- A developer README describing shared service boundaries and how a future paid API adapter would enforce the same access/accounting policy.
- Separate tested ChatGPT and Claude connection instructions, including the exact tested surfaces and account requirements; no unsupported universal plan claims.
- Model evaluation results and selected provider/model, measured usage/cost, and query-performance evidence.
- A test report with commands, results, test database identity/safety check, and any unexecuted live checks explicitly listed.
- Migration/feature-enable/rollback runbook and a concise implementation summary listing changed files and residual limitations.

## 20. External setup prerequisites and owner decisions deliberately deferred

No additional product answer is required to begin implementation. These are setup dependencies to verify, not values an agent should invent:

| Dependency | Action and completion evidence |
|---|---|
| Staging/test database | Verify a disposable database/branch for fixtures and migrations; record how production was excluded. |
| Clerk OAuth setup | Configure actual research scope, client registration, resource/audience binding, refresh, and revocation. Record tested verification fields without tokens. |
| Remote clients | Owner completes any required account sign-in/consent; record successful tool calls from both ChatGPT and Claude. |
| Internal API billing/key | Owner supplies a server-side model API project/key and daily spend ceiling; evaluate/select the model before enabling internal AI. |
| Deployment access | Use the project's normal deployment process; leave switches off until their checks pass. |
| Technical bounds | Start from section 15 defaults; tune from measurements and document changes. |
| Commercial pricing | Deferred: MCP add-on price, future API price, monthly request/row allowances, and packaging of internal AI access. Do not invent or launch these. |

If an integration prerequisite fails, report the exact failing capability and the smallest decision/setup action needed. Continue independently verifiable code work, keep the affected feature disabled, and do not describe live compatibility as complete.

## 21. Documentation sources and compatibility notes

Sources checked September 18, 2026. These guide integration, but the installed SDK versions and actual account configuration must still be tested:

- [MCP tool schemas and results](https://modelcontextprotocol.io/specification/2026-07-28/server/tools): structured output, tool metadata, and client-compatible representation.
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): resource discovery and token validation requirements.
- [TypeScript SDK protocol compatibility](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28): current versus legacy protocol behavior; do not assume the same lifecycle for every client.
- [Clerk Next.js MCP integration](https://clerk.com/docs/nextjs/guides/ai/mcp/build-mcp-server), [OAuth configuration/scopes](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth), and [OAuth token verification](https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens).
- [Official OpenAI developer-mode documentation](https://developers.openai.com/api/docs/guides/developer-mode): arbitrary tools can be used in ordinary developer-mode conversations; read-only metadata matters.
- [OpenAI MCP integration guide](https://developers.openai.com/api/docs/mcp): the separate Deep Research/company-knowledge search/fetch compatibility interface is outside this release.
- [Claude remote custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp): remote connection setup and cloud-originating requests.

Public documentation and plan availability can change. Verify the actual two owner accounts during setup instead of assuming a subscription guarantees every connector surface. No marketplace publication or branded research-mode certification is part of acceptance.

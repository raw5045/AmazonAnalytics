# Arc 1 — External MCP research tools: amendment to the 2026-09-18 design

**Date:** 2026-09-19
**Status:** Approved by owner 2026-09-21 (live pages chosen, §9)
**Parent:** [2026-09-18-keywordquarry-research-mcp-design.md](2026-09-18-keywordquarry-research-mcp-design.md)
(the "parent"). This amendment changes the parent only where stated; every
parent section not mentioned here stands as written.
**Foundation:** the spike in [2026-09-19-mcp-spike-design.md](2026-09-19-mcp-spike-design.md)
(commit `4403aef`, live 2026-09-19): claude.ai and ChatGPT both connect
through Clerk with manually created OAuth clients, and `whoami` works.

## 1. What arc 1 delivers, and what moves to arc 2

Arc 1 = the parent's external half: the five read-only research tools
(`get_research_guide`, `resolve_categories`, `search_keywords`,
`get_keyword_details`, `get_keyword_history`) on the proven `/api/mcp`
endpoint, a shared research service they call, operating limits, usage
counters that feed the admin digest, and a "Connect AI" page with
per-client instructions and an app-level disconnect. Ships admin-only;
the owner tests conversational fluidity in both clients; then the
audience switch opens it to every beta account (free during beta).

Arc 2 (separate spec) = the internal Ask KeywordQuarry page: prompt
interpreter, provider/model selection and daily spend ceiling, recent
searches, and the model evaluation harness (parent §12, §13 recent
searches, §15 AI rows, §18.4).

Owner decisions this amendment records (2026-09-18/19): split approved,
MCP first; admin-only until the owner confirms fluid use, then ALL beta
users via a switch (no per-user allowlist, no payments yet); audience
binding = our Clerk issuer + our custom scope + pinned client ids;
app-level access record is the disconnect source of truth; integration
tests keep the existing synthetic-user pattern on the production database.

## 2. What the spike proved and arc 1 keeps unchanged

- `lib/mcp/verifyMcpToken.ts` (token facts from Clerk) + the gate in
  `lib/mcp/handler.ts` (client allowlist → account → audience; plain 403s
  without a re-auth challenge; 503 on a lookup failure). Arc 1 adds one
  step to the gate (§4.3) and otherwise reuses it as is.
- Discovery documents, the 401 challenge, `MCP_ENABLED`, `MCP_AUDIENCE`,
  `MCP_ALLOWED_CLIENT_IDS`, `MCP_RESOURCE_URL`.
- mcp-handler 2.2 + `@modelcontextprotocol/server` 2.0, stateless, tools
  read identity from `ctx.http.authInfo.extra` (`clerkUserId`, `account`).
- Manual OAuth clients per external client; DCR and CIMD stay off.

## 3. Changes to the parent design

### 3.1 Audience (parent §14.1)

No `research_feature_access` table in arc 1. Access = valid token + our
scope + allowlisted client + local account + `MCP_AUDIENCE` (`admin` →
role admin; `all` → any account) + not disconnected (§3.4). Paid
entitlements arrive with payments, replacing only the audience rule, as
the parent intends. `RESEARCH_ENABLED` and everything internal wait for
arc 2.

### 3.2 Storage trimmed (parent §9, §13, §15)

Not built in arc 1: `research_result_sets`, `research_request_leases`,
`research_usage_events`, cost reservations, global concurrency, recent
searches, idempotent submission ids. Built instead:

- **Stateless signed cursors** over live data (§5.3; the open decision).
- **`research_usage_buckets`**: per-account, per-channel, per-minute
  atomic counters (requests, rows) for the burst limit.
- **`user_activity_daily` metrics** `mcp_request` and `mcp_rows`
  (increment-by-N) for the existing admin digest, which gains an MCP
  column next to Exports.
- **`mcp_connections`**: one row per account: status, disconnected/
  reconnected timestamps, last successful request time and client id.

Why: with no owner-paid model call in the loop, the parent's ledger
(leases, reservations, events) protects nothing that a 10-second
statement timeout, a small dedicated pool and a per-minute counter do
not already protect; every deferred table returns with arc 2 or payments
only if measurements say so.

### 3.3 Query engine (parent §5, §8.2, §9, §17)

- `lib/research/query.ts` compiles the strict research contract into SQL
  from the **Explorer's own predicate fragments**, exported from
  `lib/explorer/buildQuery.ts` (range bounds, leaf-path and broad-category
  predicates, severity, title gap, text match via `matchPattern`, and the
  `volumeDeltaExpr`/`volumePriorExpr`/`volumeDeltaEligibility` window
  expressions). One implementation of each predicate; the Explorer keeps
  `buildExplorerQuery` untouched. Integer comparators map losslessly:
  every filtered metric is an integer, so `gt 10000` becomes `>= 10001`
  at the SQL boundary while the response still reports `gt: 10000`.
- Deterministic order with a unique tie-break: `<sort key>, current_rank
  ASC, search_term_id ASC`. `estimatedMonthlySearches` order is executed
  as `current_rank` order because the stored estimate is monotone
  non-increasing in rank by construction (the calibration fit maps rank
  to volume; verified on the 2026-09-12 snapshot: zero inversions over
  2.68 M rows). Arc 1 adds the monotonicity guard deferred from arc 0 to
  `refreshSummary` so a future fit cannot break the invariant silently.
- Runs on the existing broad-search **TCP pool** (`pg`, extracted from
  `runQuery.ts` into `lib/db/tcpPool.ts`) inside `BEGIN READ ONLY; SET
  LOCAL statement_timeout = 10000` (3000 for category discovery). A
  timeout is `QUERY_TIMEOUT`, never an empty result. The Explorer's 115 s
  broad path and 45 s count are not reachable from MCP.
- Counts: `SELECT count(*) FROM (... LIMIT 10001)` under the same
  timeout → `exact` up to 10 000, else `at_least 10000`; on timeout
  `unknown`. Mirrors the Explorer's `COUNT_CAP`.
- Sorts: `estimatedMonthlySearches`, `rank`, `averageReviews`,
  `wordCount`, `volumeDelta`. **`firstSeenWeek` is dropped** (it lives on
  `search_terms` with no index; an unbounded sort would be a 140 M-row
  hazard). `NULLS LAST` everywhere the key is nullable.
- Every search response carries `provenance` from
  `keyword_current_summary_meta` read in the same transaction.

### 3.4 Auth, disconnect (parent §14.2, §14.3)

As proven in the spike. Disconnect = the account's `mcp_connections.status`
set to `disconnected` from the Connect AI page (session-authenticated,
same-origin); the gate denies the next request with `403 access_denied`
(`reason: disconnected`, message says to reconnect on the page).
Reconnect flips it back. **Provider-side revocation is deferred**: Clerk's
revocation endpoint is client-authenticated and the app holds no client
secrets. Consequence, documented on the page: after "Reconnect" an
already-issued token works again; to force a fresh consent the user
removes the connector in the client. No bearer or refresh token is ever
stored.

### 3.5 Connect AI page (parent §12.1, §14.3)

Route `/connect-ai` inside the signed-in app (not `/research/connections`,
which belongs to arc 2), nav item "Connect AI" shown only to accounts the
audience rule admits. Content: copyable endpoint URL, the tested
claude.ai and ChatGPT steps (from the spike results), what the connection
can read, status ("last successful request: <time> via <client>" from
`mcp_connections`, or "never connected"), Disconnect / Reconnect. Admins
additionally see the audience setting and the pinned client ids.

### 3.6 Limits (parent §15) — arc 1 values

| Control | Arc 1 default |
|---|---:|
| Search page | 50 default / 100 maximum rows |
| Rows reachable per search (cursor cap) | 1 000 |
| Cursor lifetime | 15 minutes from the first page |
| Category candidates | 20 default / 50 maximum |
| Expanded category scope | 2 000 leaves |
| History | 13 weeks default / 52 maximum |
| Search / details / history SQL deadline | 10 s |
| Category SQL deadline | 3 s |
| Requests per account per rolling minute (all clients) | 60 |
| Rows returned per account per minute | 6 000 |
| Tool response payload | 256 KiB |

All are environment-overridable (`RESEARCH_*`, validated, defaulting
as above). Concurrency is bounded by a dedicated research pool (max 4
connections, built by the same `lib/db/tcpPool.ts` factory the Explorer's
broad path uses) plus the statement timeout, not by leases.

### 3.7 Errors (parent §16) — arc 1 subset

`INVALID_FILTERS`, `UNSUPPORTED_FILTER`, `CATEGORY_NOT_AVAILABLE`,
`KEYWORD_NOT_FOUND`, `SEARCH_EXPIRED`, `INVALID_CURSOR`, `RESPONSE_TOO_LARGE`,
`RATE_LIMITED` (with `retryAfterSeconds`), `QUERY_TIMEOUT`,
`HISTORY_UNAVAILABLE`, `DATA_UNAVAILABLE`. Transport-level: the spike's
401/403/503 (plus `reason: disconnected`). All are MCP tool errors
(`isError: true` with a structured `{ code, message, retryable,
retryAfterSeconds?, details? }`), never a 200 with prose only.

### 3.8 Migrations (parent §17)

One hand-numbered raw-SQL migration, **0047**, owner-confirmed before it
runs (project rule): `research_usage_buckets` and `mcp_connections`
(§6). No index on existing tables. Rollback = leave the tables; they are
inert while the feature is off.

### 3.9 Verification (parent §18)

- Unit: contracts (every §8.1 rejection), catalog/presets, predicate
  compilation asserting exact SQL fragments and parameters, cursor
  sign/verify/expiry/ownership, guide content, error mapping, the gate's
  new disconnect step, bucket arithmetic.
- Protocol: the spike's in-process `@modelcontextprotocol/client` pattern
  extended to all five tools with mocked database rows (tools/list
  schemas and annotations, each tool's structured output, every error
  code as an MCP tool error).
- Integration (production database, existing synthetic-user harness):
  bucket atomicity under concurrent increments, owner isolation of
  `mcp_connections`, and read-only execution of the acceptance query
  shapes with `EXPLAIN (ANALYZE, BUFFERS)` recorded in the spec (the arc-0
  discipline: probe the adverse direction of every new predicate under
  every sort).
- Live: the owner runs the fluidity checklist (§8) in both clients;
  results recorded in this document.
- Semantic matrix: parent §18.2 rows Q01–Q10, Q16–Q25, Q29–Q34, Q39 apply
  to arc 1 (the rest are arc 2).

## 4. Components and data flow

```
ChatGPT / claude.ai
   │  Bearer (Clerk OAuth)
   ▼
app/api/mcp/route.ts ── withMcpAuth(verifyMcpToken) ── gate (allowlist, account,
   │                                                   audience, connection) ── rate bucket
   ▼
lib/mcp/tools/*.ts  (five tools: validate → service → map result/error)
   ▼
lib/research/service.ts  (guide · categories · search · details · history)
   ├─ contracts.ts   strict zod schemas + types (versioned)
   ├─ catalog.ts     metric definitions, presets, limits text
   ├─ categories.ts  leaf-facet catalog search, taxonomy browse, custom expansion
   ├─ query.ts       contract → SQL via exported Explorer fragments; count
   ├─ cursor.ts      signed continuation (HMAC, RESEARCH_CURSOR_SECRET)
   ├─ details.ts / history.ts   narrow loaders (fetchKeywordHeader/Products,
   │                            keyword_chart_series window)
   └─ limits.ts      buckets (atomic upsert), activity metrics
lib/db/tcpPool.ts   pg pool + runReadOnly(sql, args, timeoutMs)
```

### 4.1 Trusted actor

Every service call receives `{ localUserId, clerkUserId, clientId,
channel: 'mcp' }` from the gate; no tool argument can set any of it.

### 4.2 Category resolution (parent §10, unchanged in behaviour)

Catalog = the current snapshot's `keyword_current_summary_leaf_category_facets`
paths (full paths with counts) plus their parent segments, searched by
whole segment / full path with deterministic ranking (exact label, then
token, then substring), cached 60 s per snapshot. `parentPath` browsing
uses `loadChildrenAtPath`/`loadLeavesUnderPath`. Custom categories are
the caller's own rows; a missing, foreign, deleted or empty id is
`CATEGORY_NOT_AVAILABLE` — `expandCustomCategories`' silent skip is not
used on this path. Expansion at search time revalidates, dedupes, caps at
2 000 leaves and returns `expandedLeafCount`, `leafSetHash` and 20 preview
paths.

### 4.3 Gate addition

After the audience step: `mcp_connections` lookup (same 503-on-failure
handling); `disconnected` → 403. On admission the gate records
`last_request_at`/`last_client_id` (fire-and-forget, throttled to once a
minute per account) so the Connect AI page can show real status.

## 5. Tool contracts (differences from parent §8 and §11 only)

### 5.1 `search_keywords` input

Parent §8.2 shape with these arc-1 restrictions: `sort.field` excludes
`firstSeenWeek`; `movement` supports `metric: volume | rank`, `window`,
`prior`/`current`/`delta` integer ranges and `baseline` exactly as the
parent states, compiled from the Explorer's window expressions;
`categories.selections` ≤ 25, expanded ≤ 2 000 leaves; `pageSize` 1–100.
A continuation is `{ cursor }` alone.

### 5.2 `search_keywords` output

Parent §8.3 with `pagination = { pageSize, returnedCount, offset,
totalMatches: { kind: exact | at_least | unknown, value }, nextCursor,
capped, capReason: max_rows | payload | null, expiresAt }` and no
`accessibleResultCount` (there is no captured set). Rows are the parent's
projection (`searchTermId`, `keyword`, `keywordUrl`,
`estimatedMonthlySearches`, `averageReviews`, `rank`, `wordCount`,
`categoryPath`, `broadCategory`, `severity`, `lastSeenWeek`,
`firstSeenWeek`, window prior/delta/`baselineStatus` when movement or a
delta sort is active, title flags when a title-gap filter is active).

### 5.3 Continuation: stateless signed cursor (decided, §9)

`cursor` = base64url of `{ v: 1, f: <sha256 of canonical filters+sort+
window+pageSize>, snap: <snapshotVersion>, off: <next offset>, ps, exp,
uid, ch }` + HMAC-SHA256 with `RESEARCH_CURSOR_SECRET`. On continuation
the server re-validates identity, access, rate limit, signature, owner,
channel, expiry, `off ≤ 1000 − ps`, and that the current snapshot still
matches `snap` (a weekly refresh invalidates every cursor →
`SEARCH_EXPIRED`), then re-runs the same query with `OFFSET off`. Pages
are computed live; within a snapshot the only in-place change is a Keepa
sync touching review averages and category paths, so a review-sorted or
category-filtered page can shift by a few rows mid-week. The guide and
the response say so (`warnings: LIVE_PAGINATION`). Rotating the secret
expires outstanding cursors.

### 5.4 `resolve_categories`, `get_keyword_details`, `get_keyword_history`

As the parent §11.2, §11.4, §11.5. Details use `fetchKeywordHeader` +
`fetchKeywordProducts` (no history, no images); history uses the
`keyword_chart_series` row filtered to the calendar window, with the
`fetchKeywordRawHistory` fallback only under the 10 s deadline. Ratings
are stars (stored 0–50 ÷ 10); shares are the stored percentage strings
parsed to numbers; missing stays null.

### 5.5 `get_research_guide`

Parent §11.1: catalog version, metric definitions, presets with exact
thresholds, sorts, windows, category behaviour, current population
rules, the §3.6 limits, the live-pagination note, and the account's
audience/status (no email).

## 6. Data model (migration 0047)

```sql
CREATE TABLE research_usage_buckets (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel      varchar(16) NOT NULL,            -- 'mcp' now; 'research' | 'api' later
  bucket_start timestamptz NOT NULL,            -- minute floor, UTC
  requests     integer NOT NULL DEFAULT 0,
  rows         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel, bucket_start)
);
CREATE INDEX research_usage_buckets_start_idx ON research_usage_buckets (bucket_start);

CREATE TABLE mcp_connections (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status          varchar(16) NOT NULL DEFAULT 'enabled',  -- enabled | disconnected
  disconnected_at timestamptz,
  reconnected_at  timestamptz,
  last_request_at timestamptz,
  last_client_id  varchar(128),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

Bucket check = one statement at request start: `INSERT … ON CONFLICT DO
UPDATE SET requests = requests + 1, rows = rows + $pageSize RETURNING
requests, rows` (rows are reserved at the requested page size, so a
burst cannot overshoot); over either limit → `RATE_LIMITED` with
`retryAfterSeconds` to the next minute. Buckets older than one day are deleted by the existing hourly
maintenance cron. Daily totals go to `user_activity_daily`.

## 7. Configuration (all optional; `lib/env.ts` strings, interpreted in code)

| Variable | Meaning |
|---|---|
| `RESEARCH_CURSOR_SECRET` | HMAC key for cursors. When unset the server derives a stable key from `CLERK_SECRET_KEY` (HMAC with a fixed label), so cursors survive deploys; setting a dedicated value lets cursors be rotated independently of Clerk |
| `RESEARCH_LIMITS_JSON` | optional JSON overriding §3.6 numbers, validated, ignored with a warning when malformed |
| `MCP_AUDIENCE` | as in the spike; `all` = the beta rollout |

## 8. Rollout and the fluidity gate

1. Ship dark behind the existing switches; migration 0047 applied on
   the owner's confirmation before the push.
2. Admin phase (`MCP_AUDIENCE=admin`): the owner works through a
   fluidity checklist in **both** clients and records outcomes here:
   the acceptance question (lighting, > 10 k searches, < 500 reviews)
   including the category clarification; a follow-up that tightens one
   bound; "remove the review filter"; "what are the biggest movers in
   <niche> over 4 weeks"; a two-keyword comparison via details + history;
   paging to the end of a capped search; an unsupported ask
   (profitability); an empty result; and a long-tail word-count request.
   Pass = the client uses the right tool with the right bounds, explains
   caps and estimates truthfully, and never invents data.
3. Fix what the checklist finds (prompt text in tool descriptions and
   the guide is the usual lever).
4. Audience flip: set `RESEARCH_CURSOR_SECRET`, `MCP_AUDIENCE=all`,
   redeploy; the "Connect AI" nav item appears for every account; beta
   announcement via the existing channels. Payments later replace the
   audience rule.

## 9. Decision: pagination (owner, 2026-09-21: live pages)

**Pagination.** The parent (§9) freezes each search's first 1 000 rows
in a new table for 15 minutes so pages never move. This amendment
recommends **stateless signed cursors over live data** (§5.3) instead:
no new table, no eviction, no cleanup job, and cursors self-invalidate
at the weekly refresh. The trade: a review-sorted or category-filtered
page can shift by a few rows if a Keepa sync lands mid-week; the guide
says so. Recommended: stateless. If frozen pages are preferred, §3.2
gains `research_result_sets` (owner, channel, capture/expiry, criteria,
rows jsonb ≤ 2 MiB, count metadata) with the parent's eviction rule, and
the plan grows by roughly a third.

## 10. Not in arc 1

Internal Research page and interpreter, provider/model/budget, recent
searches, leases/global concurrency/cost reservations/usage events,
feature-access table, provider-side revocation, paid entitlements and
checkout, public API, `firstSeenWeek` sort, materialized result sets
(unless §9 chooses them), Claude Code / Cursor (CIMD), directory listing
or marketplace submission, ChatGPT deep-research adapter.

## Results

| Step | Outcome |
|---|---|
| Owner review of this amendment | approved 2026-09-21 (live pages) |
| Implementation plan | `docs/superpowers/plans/2026-09-21-mcp-arc1.md` |
| Migration 0047 | pending owner confirmation |
| Fluidity checklist (§8.2) | pending |
| Audience flip | pending |

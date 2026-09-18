# Claude Code handoff: KeywordQuarry Research and MCP

The implementation specification is [KeywordQuarry Research and remote MCP](2026-09-18-keywordquarry-research-mcp-design.md) in this directory. Read it completely, together with the repository's AGENTS.md and current code, before planning implementation. The specification is self-contained; earlier chat messages and the original website review are not required.

## Task to hand to Claude Code after owner review

Implement the admin-only Ask KeywordQuarry Research page and remote MCP server described in docs/superpowers/specs/2026-09-18-keywordquarry-research-mcp-design.md. Use the shared backend design and all five approved read-only tools. Preserve the existing application, Explorer, saved views, watchlist, Category Builder, and recently added CSV export. Follow your normal planning and implementation workflow, treating the specification as the product contract.

Start by comparing current HEAD with the reviewed baseline 2d78e83 and inspecting AGENTS.md. Other work may have landed since the specification was written. Preserve unrelated working-tree changes and choose migration numbers from the current repository. Read relevant installed Next.js documentation before coding.

Prepare an implementation plan from the specification, then implement and verify in dependency order. Prove Clerk OAuth, scope/resource validation, and client compatibility early because these are the principal external integration dependencies. Build the shared service, deterministic schemas/queries, and isolated tests while any owner account setup is pending.

Deliver source, additive migrations, focused tests, configuration documentation, client connection instructions, a deployment/rollback runbook, and an evidence-based completion report. Follow sections 18–20 for the exact acceptance cases, setup dependencies, and required evidence. Do not claim real ChatGPT/Claude connectivity, provider evaluation, or production deployment unless actually performed.

## Product decisions to preserve

- Dedicated Research page and MCP first; public customer API later.
- Both features admin-only initially, with independent switches and server-side checks.
- KeywordQuarry data only; no request-triggered scraping, enrichment, or web research.
- Internal conversational filtering with explanations and clarifications; external clients provide broader conversation and research.
- Five MCP tools: get_research_guide, resolve_categories, search_keywords, get_keyword_details, get_keyword_history.
- Last 10 executed internal searches per account, not a full persisted chat transcript.
- Verified category leaves combined temporarily; do not create permanent custom categories automatically.
- Visible research presets; “best opportunities” asks about signals and offers >=10,000 estimated monthly searches / <500 average reviews.
- One evaluated internal model/provider; both ChatGPT and Claude are external client targets.
- MCP will be a paid add-on. Prepare entitlements/accounting now; do not invent prices, monthly allowances, checkout, or a public API.

## Technical defaults versus owner decisions

The specification supplies recommended engineering defaults, including a 1000-row bounded result capture, 15-minute result expiry, 50/100-row pagination, byte bounds, query deadlines, and burst/concurrency limits. These support a complete implementation and are distinct from the owner's deliberately deferred monthly pricing/allowances. Tune from evidence and document changes; do not silently expand scope or weaken correctness/access checks.

The owner still supplies actual API credentials/billing, a daily internal-AI spend ceiling, account consent where required, and deployment access. Clerk scope/client/resource configuration and real client compatibility need live verification. These are setup dependencies rather than unresolved product requirements.

## Pitfalls identified in the reviewed code

- Current-volume min/max filtering is missing from the Explorer filter contract. Add strict research predicates; do not approximate with rank.
- The Explorer URL parser silently defaults malformed input. Research tools must reject invalid input instead.
- Missing/deleted custom-category IDs can currently disappear during expansion. Research must fail explicitly rather than widen the query.
- The category covering index and precomputed-count shortcuts do not automatically support new volume/movement filters.
- Weekly snapshotVersion does not freeze in-place Keepa aggregate updates. Follow the specification's captured-result pagination policy.
- Review averages ignore missing product observations and use the stored rounded integer metric. Unknown does not mean zero or complete coverage.
- Existing broad-search/count deadlines are too long for tool requests; enforce the research operation budgets.
- Existing integration setup loads .env.local, which may point at production. Use a verified isolated database for destructive fixtures/migrations/tests.
- The existing CSV export has its own product limits and soft daily counter; neither expose it via MCP nor copy its soft counter as a hard paid-access quota.
- Clerk browser-session auth is not remote OAuth validation. A valid login token alone does not establish research scope, intended resource, local role, or paid access.

## Final delivery checklist

- All specified deterministic and access-control tests pass with fresh evidence.
- Existing application regression tests, type checking, lint, and build complete or any pre-existing failure is clearly evidenced and separated.
- Research browser flow works: prompt, clarification, exact filters, results, manual edit without model usage, pagination, and history replay.
- Both external clients connect and execute the five tools, or remaining account/setup blocks are explicitly documented with the affected feature disabled.
- Model evaluation and performance measurements are reported, with actual configuration and costs.
- No unrelated code cleanup, account changes, data operations, or production deployment is presented as implicitly authorized by this handoff alone.

This handoff is for the owner's existing Claude Code workflow. It does not create another task, send a message to Claude, or start implementation in this Codex task.

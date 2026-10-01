# MCP Write Access (Workspace Tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add eleven workspace tools to the external MCP server (saved views, custom categories, watchlist, three list tools) plus an Explorer link on every search answer, gated by `MCP_WRITE_ENABLED`, exactly as `docs/superpowers/specs/2026-09-30-mcp-write-access-design.md` (the spec) describes.

**Architecture:** The saved-view, custom-category and watchlist rules move out of the API routes into shared command modules that both the routes and a new `WorkspaceService` call. A pure converter turns a research search into Explorer filters (for the link and for saved views). The tools are a second frozen definition list (`WORKSPACE_TOOLS`) registered through the same adapter as the research tools, only when the flag is on; Ask AI keeps the five research tools. Guards reuse the per-minute bucket, add a 200-writes-per-day counter, and keep every resource cap and message the app already has. No DDL.

**Tech Stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` before touching any route or page — this version differs from training data), TypeScript strict, zod 4, `@modelcontextprotocol/server` 2 via `mcp-handler`, Drizzle over neon-http (no transactions), vitest (jsdom default; `// @vitest-environment node` for MCP/research tests).

---

## Conventions (every task)

- **TDD**: write the failing test, run it, implement, run it, commit. Run one file at a time: `pnpm vitest run <path>`. If you pipe output (`| tail`), check `${PIPESTATUS[0]}`, not the pipe's exit code. Whole-project `pnpm lint` fails on pre-existing warnings and on untracked throwaway scripts (review finding, Task 2); wherever a step says `pnpm lint`, run `pnpm exec eslint <the files you touched>` instead.
- **Commits** are local only, on `main`, one per task (or per step where marked). Every commit message ends with exactly this trailer line: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Use `git commit -F - <<'MSG' … MSG`. **Never push.** `git add` only the files named in the task, never `-A` or `.` (the working tree carries untracked throwaway scripts that must stay untracked, including `scripts/applyMigration0048.ts`).
- **No DDL.** Nothing in this plan touches `db/migrations`, `pnpm db:generate` or `pnpm db:migrate`.
- **Log-safe**: never log `e.message` of a database error (it embeds SQL params); log `e.name` / `code` via `errFields` (`lib/ask/logSafe.ts`) or the patterns shown. Never log names, keyword text, leaf paths or member emails.
- **The spec is the contract.** Section numbers below (§) refer to the spec. Where this plan and the spec disagree, stop and say so.
- `.env.local`'s `DATABASE_URL` reaches **production**. Only Task 3 Step 1 (a read-only probe) and Task 13 (owner-gated integration tests) touch it.
- The research tools' tests mock `@/lib/env`, `@/db/client` and `@clerk/nextjs/server` at the top of each file (see `lib/mcp/tools/registerResearchTools.test.ts:11-13`); copy that pattern for any new test under `lib/mcp` or `lib/workspace`.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `lib/env.ts`, `lib/mcp/config.ts` | `MCP_WRITE_ENABLED` → `mcpWriteEnabled()` | 1 |
| `lib/research/limits.ts` | `writesPerDay` (200, overridable) | 1 |
| `lib/research/errors.ts` | codes `LIMIT_REACHED`, `DUPLICATE_NAME`, `NOT_FOUND` | 1 |
| `lib/activity/bump.ts`, `lib/activity/etDay.ts` | `mcp_write` metric; `secondsUntilNextEtDay` | 1 |
| `lib/research/tools.ts`, `lib/mcp/tools/registerDefinitions.ts` | generic `ToolDefinition`; one registration adapter for both lists | 2 |
| `lib/workspace/explorerFilters.ts` | pure converter, compact filters, URL builders | 3 |
| `lib/savedViews/commands.ts` + routes | shared saved-view commands; routes delegate | 4 |
| `lib/customCategories/commands.ts`, `loadServer.ts` + routes | shared custom-category commands; `loadCustomCategoryForUser` | 5 |
| `lib/watchlist/commands.ts`, `bulkAdd.ts`, `loadServer.ts` | add/remove by text or id; `listWatchlistWithKeywords` | 6 |
| `lib/workspace/contracts.ts`, `lib/workspace/tools.ts` | schemas, response types, the eleven definitions | 7 |
| `lib/workspace/service.ts` | `WorkspaceService`: validate → reserve → daily cap → command → record → log | 8 |
| `lib/research/contracts.ts`, `lib/research/service.ts` | `explorerUrl` / `explorerNotes` on search | 9 |
| `lib/research/catalog.ts`, `lib/mcp/tools/registerWorkspaceTools.ts`, `lib/mcp/handler.ts` | guide workspace section (GUIDE_VERSION 2), registration, instructions | 10 |
| `lib/notifications/abuseDigest/*` | `mcpWrites` counter, column, amber flag | 11 |
| `lib/workspace/examples.ts`, `app/(app)/connect-ai/*` | flag-dependent copy and prompts | 12 |
| `tests/integration/workspaceCommands.test.ts` | owner-gated real-table test; ship steps | 13 |

---

### Task 1: Flag, daily limit, error codes, metric, ET-midnight helper

**Files:**
- Modify: `lib/env.ts` (serverSchema, after `MCP_CLIENT_SECRET_CHATGPT`)
- Modify: `lib/mcp/config.ts`, `lib/mcp/config.test.ts`
- Modify: `lib/research/limits.ts`, `lib/research/limits.test.ts`
- Modify: `lib/research/errors.ts`
- Modify: `lib/activity/bump.ts`
- Modify: `lib/activity/etDay.ts`, `lib/activity/etDay.test.ts`
- Modify (review amendment): `.env.example` — document `MCP_WRITE_ENABLED` in the MCP section, as every other serverSchema flag is

> **Landed as 4c73891 (2026-09-30).** Spec review: compliant. Code-quality review: approve with fixes — four more `secondsUntilNextEtDay` tests (the 23-hour and 25-hour daylight-saving days, rounding a partial second up, the year boundary; the committed three could not tell a correct implementation from three plausible wrong ones), the `.env.example` entry, and three nits (config comment without a hard-coded tool count, test title "is off unless MCP_WRITE_ENABLED is exactly \"1\"", etDay comment citing §7, §8.2). Fix round requested from the same implementer; its SHA is in the Results table. The reviewer's oracle sweep (479,058 instants, 2024–2028, two host time zones plus a spot check under a third) found 0 mismatches in the helper itself.

- [ ] **Step 1: Failing tests for the flag, the limit and the ET helper**

Append to `lib/mcp/config.test.ts` inside `describe('mcp config', …)` (and add `mcpWriteEnabled` to the import list from `./config`):

```ts
  it('registers the workspace tools only when MCP_WRITE_ENABLED is exactly "1" (spec 2026-09-30 §2)', () => {
    expect(mcpWriteEnabled()).toBe(false);
    envMock.env.MCP_WRITE_ENABLED = 'true';
    expect(mcpWriteEnabled()).toBe(false);
    envMock.env.MCP_WRITE_ENABLED = '1';
    expect(mcpWriteEnabled()).toBe(true);
  });
```

In `lib/research/limits.test.ts`, add `writesPerDay: 200,` to the `defaults` object (after `poolMax: 4,`) and append inside `describe('parseResearchLimits', …)`:

```ts
  it('lets RESEARCH_LIMITS_JSON override writesPerDay (spec 2026-09-30 §8.2)', () => {
    expect(parseResearchLimits(JSON.stringify({ writesPerDay: 50 }))).toEqual({ ...DEFAULT_LIMITS, writesPerDay: 50 });
    expect(warn).not.toHaveBeenCalled();
  });
```

Append to `lib/activity/etDay.test.ts` (add `secondsUntilNextEtDay` to its import):

```ts
describe('secondsUntilNextEtDay', () => {
  it('counts to 04:00Z in summer (EDT midnight)', () => {
    // 2026-07-15 12:00Z → next ET day starts 2026-07-16T04:00:00Z
    expect(secondsUntilNextEtDay(new Date('2026-07-15T12:00:00Z'))).toBe(16 * 3600);
  });
  it('counts to 05:00Z in winter (EST midnight)', () => {
    expect(secondsUntilNextEtDay(new Date('2026-01-15T12:00:00Z'))).toBe(17 * 3600);
  });
  it('never returns less than one second', () => {
    expect(secondsUntilNextEtDay(new Date('2026-07-16T03:59:59.900Z'))).toBe(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run lib/mcp/config.test.ts lib/research/limits.test.ts lib/activity/etDay.test.ts`
Expected: FAIL — `mcpWriteEnabled is not a function`, the defaults `toEqual` mismatch (`writesPerDay` missing), `secondsUntilNextEtDay is not a function`.

- [ ] **Step 3: Implement**

`lib/env.ts`, in `serverSchema` right after `MCP_CLIENT_SECRET_CHATGPT: z.string().optional(),`:

```ts
  /** Workspace (write) tools on /api/mcp (arc 3, docs/superpowers/specs/2026-09-30-mcp-write-access-design.md §2): "1" registers them. */
  MCP_WRITE_ENABLED: z.string().optional(),
```

`lib/mcp/config.ts`, after `mcpEnabled()`:

```ts
/** The eleven workspace (write) tools are registered only while MCP_WRITE_ENABLED is exactly "1" (spec 2026-09-30 §2). */
export function mcpWriteEnabled(): boolean {
  return env.MCP_WRITE_ENABLED === '1';
}
```

`lib/research/limits.ts`: add to the `ResearchLimits` interface (after `poolMax`):

```ts
  /** Spec 2026-09-30 §8.2: workspace writes per account per Eastern calendar day. */
  writesPerDay: number;
```

add `writesPerDay: 200,` to `DEFAULT_LIMITS` (after `poolMax: 4,`), and `'writesPerDay',` to the `OVERRIDABLE` set.

`lib/research/errors.ts`, in `RESEARCH_ERROR_CODES` after `'DATA_UNAVAILABLE',`:

```ts
  // Workspace tools (spec 2026-09-30 §7)
  'LIMIT_REACHED',
  'DUPLICATE_NAME',
  'NOT_FOUND',
```

`lib/activity/bump.ts`: extend the union:

```ts
export type UserActivityMetric =
  | 'explorer_query'
  | 'detail_view'
  | 'explorer_export'
  | 'mcp_request'
  | 'mcp_rows'
  | 'ask_question'
  | 'ask_tool_call'
  | 'ask_rows'
  /** One successful workspace write through the MCP (spec 2026-09-30 §8.2); the daily cap reads it back with countUserActivityToday. */
  | 'mcp_write';
```

`lib/activity/etDay.ts`, append:

```ts
/**
 * Seconds from `now` until the next Eastern calendar day begins. ET midnight is 04:00Z under
 * EDT and 05:00Z under EST; DST switches happen at 02:00 local, never at midnight, so the
 * first instant of a day is always one of those two. Probing 04:00Z decides which: if that
 * instant already falls on the next ET day, the offset is −4, otherwise −5. Used as the daily
 * write cap's retryAfterSeconds (spec 2026-09-30 §8.2).
 */
export function secondsUntilNextEtDay(now: Date): number {
  const next = addDays(etDay(now), 1);
  const [y, m, d] = next.split('-').map(Number);
  const edtMidnight = Date.UTC(y, m - 1, d, 4);
  const midnight = etDay(new Date(edtMidnight)) === next ? edtMidnight : Date.UTC(y, m - 1, d, 5);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run lib/mcp/config.test.ts lib/research/limits.test.ts lib/activity/etDay.test.ts lib/research/errors.test.ts lib/research/catalog.test.ts && pnpm typecheck`
Expected: PASS, typecheck clean. (`catalog.test.ts` is included because the guide echoes `RESEARCH_ERROR_CODES`; if a test there pins the code list literally, extend the literal with the three new codes in the same order.)

- [ ] **Step 5: Commit**

```bash
git add lib/env.ts lib/mcp/config.ts lib/mcp/config.test.ts lib/research/limits.ts lib/research/limits.test.ts lib/research/errors.ts lib/activity/bump.ts lib/activity/etDay.ts lib/activity/etDay.test.ts
git commit -F - <<'MSG'
feat(workspace): MCP_WRITE_ENABLED flag, writesPerDay limit, workspace error codes, mcp_write metric, ET-midnight helper (spec 2026-09-30 §2, §7, §8.2)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 2: A generic tool definition and one registration adapter

The research tools are typed to `ResearchService`; the workspace tools need the same shape over `WorkspaceService`. Introduce the generic base and a shared adapter, keeping every existing export and test green (§4 "Changed": `lib/research/tools.ts`).

**Files:**
- Modify: `lib/research/tools.ts:12-32`
- Create: `lib/mcp/tools/registerDefinitions.ts`
- Modify: `lib/mcp/tools/registerResearchTools.ts`
- Test (existing, must stay green): `lib/research/tools.test.ts`, `lib/mcp/tools/registerResearchTools.test.ts`, `lib/ask/tools.test.ts`

> **Landed as c30d224 (2026-09-30).** Spec review: byte-identical to the plan. Code-quality review: approve (type probes showed the generic is sound, the adapter rejects a mismatched service, and the SDK's annotations typing stays safe under `exactOptionalPropertyTypes`). Nits queued for a later nits commit: `toolResult.ts:33` should name `registerDefinitions.ts` as the `runTool` caller; the `tools.ts` doc comment should say the chat builds from `RESEARCH_TOOLS` only; the `inputSchema` comment should read "Must be a `z.strictObject(...)` (the type cannot tell strict from strip; the tests pin it)". A strictness loop (every definition's `inputSchema` rejects `{ __probe: 1 }` with issue code `unrecognized_keys`) goes into both tool tests with Task 7. Optional: a comment on why `run` is a property (not a method) and moving the two-failure-shapes paragraph into `registerDefinitions.ts`.

- [ ] **Step 1: Replace the interface block in `lib/research/tools.ts`**

Replace lines 12–32 (from `export const READ_ONLY_ANNOTATIONS` through the closing `}` of `ResearchToolDefinition`) with:

```ts
export const READ_ONLY_ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const);

/** MCP tool annotations as each definition sets them (spec 2026-09-30 §3): the four booleans clients read to decide whether to prompt. */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/**
 * The shape every tool list shares — the research tools below and the workspace tools in
 * lib/workspace/tools.ts — so one registration adapter (lib/mcp/tools/registerDefinitions.ts)
 * serves both. Provider-neutral (spec 2026-09-28 §4): the MCP registration and the in-app chat
 * both build from these lists, so names, descriptions, schemas and behaviour cannot drift.
 * `requiresConfirmation` is true for a tool that changes data: the in-app chat is to ask before
 * running it (a later arc); MCP clients decide from `annotations` instead.
 */
export interface ToolDefinition<TService, TName extends string = string> {
  readonly name: TName;
  readonly title: string;
  readonly description: (limits: ResearchLimits) => string;
  /** Always a `z.strictObject(...)` — a plain `ZodObject`, narrower than `z.ZodType`, so `registerTool`'s JSON-Schema conversion always sees an object shape. */
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  readonly run: (service: TService, actor: ResearchActor, args: unknown) => Promise<object>;
  readonly annotations: ToolAnnotations;
  readonly requiresConfirmation: boolean;
}

/**
 * One research tool. Every field is `readonly` and every entry in `RESEARCH_TOOLS` below is
 * individually `Object.freeze`d (in addition to the array itself), so no caller can mutate a
 * shared definition out from under another. All five are read-only and need no confirmation.
 */
export interface ResearchToolDefinition extends ToolDefinition<ResearchService, ResearchToolName> {
  readonly annotations: typeof READ_ONLY_ANNOTATIONS;
  readonly requiresConfirmation: false;
}
```

- [ ] **Step 2: Create `lib/mcp/tools/registerDefinitions.ts`**

```ts
import { z } from 'zod';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { ResearchLimits } from '@/lib/research/limits';
import type { ResearchActor } from '@/lib/research/service';
import type { ToolDefinition } from '@/lib/research/tools';
import { runTool } from './toolResult';

const anyObject = z.looseObject({});

/**
 * Registers one frozen definition list on `server`. Each handler is a thin adapter: the SDK
 * validates `args` against the tool's own input schema before the callback ever runs,
 * `actorFor` resolves the caller's identity from the gate-supplied auth context (never from
 * `args`), and `runTool` turns the service call into `okResult`/`errorResult`. Shared by
 * registerResearchTools.ts and registerWorkspaceTools.ts (spec 2026-09-30 §4).
 */
export function registerDefinitions<TService>(
  server: McpServer,
  defs: ReadonlyArray<ToolDefinition<TService, string>>,
  service: TService,
  actorFor: (ctx: ServerContext) => ResearchActor,
  limits: ResearchLimits,
): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description(limits), inputSchema: def.inputSchema, outputSchema: anyObject, annotations: def.annotations },
      async (args, ctx) => runTool(def.name, () => def.run(service, actorFor(ctx), args)),
    );
  }
}
```

- [ ] **Step 3: Make `registerResearchTools` use it**

Replace the body of `lib/mcp/tools/registerResearchTools.ts` from `const anyObject` to the end with:

```ts
export interface RegisterResearchToolsOptions {
  actorFor?: (ctx: ServerContext) => ResearchActor;
  /** Defaults to `researchLimits()` (memoised, env-driven); overridable so tests can pin the numbers the description is built from. */
  limits?: ResearchLimits;
}

/**
 * Registers the five MCP research tools on `server` from the shared definitions in
 * lib/research/tools.ts (spec 2026-09-28 §4: the in-app chat builds from the same list), through
 * the adapter in ./registerDefinitions.ts. Two distinct shapes reach a client on failure, never
 * a bare 200 with prose only: a schema-invalid call never reaches the callback at all — the SDK
 * itself answers with an MCP tool error whose text is its own prose (`Input validation error: …`);
 * everything past that point (a filter the schema itself cannot express, a service failure) is an
 * MCP tool error whose text is the JSON `{ error: ResearchErrorInfo }`.
 */
export function registerResearchTools(server: McpServer, service: ResearchService, opts: RegisterResearchToolsOptions = {}): void {
  registerDefinitions(server, RESEARCH_TOOLS, service, opts.actorFor ?? actorFromContext, opts.limits ?? researchLimits());
}
```

and fix the imports at the top of the file to:

```ts
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { researchLimits, type ResearchLimits } from '@/lib/research/limits';
import type { ResearchActor, ResearchService } from '@/lib/research/service';
import { RESEARCH_TOOLS } from '@/lib/research/tools';
import { registerDefinitions } from './registerDefinitions';
import { actorFromContext } from './toolResult';
```

- [ ] **Step 4: Run the existing tests and the typecheck**

Run: `pnpm vitest run lib/research/tools.test.ts lib/mcp/tools/registerResearchTools.test.ts lib/ask/tools.test.ts app/api/mcp/route.test.ts && pnpm typecheck`
Expected: PASS (nothing observable changed), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add lib/research/tools.ts lib/mcp/tools/registerDefinitions.ts lib/mcp/tools/registerResearchTools.ts
git commit -F - <<'MSG'
refactor(mcp): generic ToolDefinition + one registration adapter for the research and workspace tool lists (spec 2026-09-30 §4)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 3: The search → Explorer converter

**Files:**
- Create (untracked, never committed): `scripts/probeDeptBroadCategory0930.ts`
- Create: `lib/workspace/explorerFilters.ts`
- Test: `lib/workspace/explorerFilters.test.ts`

> **Landed as 3f69c6d (2026-09-30; amended from 7968773).** The probe returned `{"sampled":200000,"mismatches":182658}`: the Explorer's broad category is Brand Analytics' own taxonomy ("Apparel" over "Clothing, Shoes & Jewelry", "Home" and "Kitchen" both over "Home & Kitchen"), so the department shortcut was dropped per the decision rule and spec §5.2 now says so. Two test corrections in the fix round: the band test's numbers (100000→50000) accidentally matched the `100k_to_50k` preset, so it now uses 100000→40000 to exercise the custom-jump path; and a pin test replaces the deleted department test ("a department alone expands to its leaves like any other selection"). 16 tests. Fix round 2 (d944c17, after the spec review): a prior bound on the side the jump never reads — a decline, or that bound alone — was dropped silently by the plan's own code, breaking spec §3.2's "empty notes = exact link"; it now notes `NOTE_JUMP_INVALID` (with a current bound) or `NOTE_PRIOR_ONLY` (alone). 17 tests; spec §5.3 gained the matching row. Code-quality review: approve with fixes → fix round 3: the delta note said "the from/to move was kept" even when no move existed (reworded to say only what was lost), neutral baseline wording, `NOTE_JUMP_INVALID` renamed `NOTE_MOVE_UNSUPPORTED`, a self-check that adds `NOTE_EXPLORER_REREAD` when the saved-view normaliser would read the filters back differently (comma or doubled space inside an excluded term), `jumpMetric` always with a jump, canonical severities order, volume-shift and compact tests. Its SHA is in the Results table.

- [ ] **Step 1: The production read-only probe for the department shortcut (§5.2)**

Write `scripts/probeDeptBroadCategory0930.ts` (a throwaway like the other `scripts/check*.ts`; do **not** `git add` it):

```ts
// Read-only probe (spec 2026-09-30 §5.2): does the Explorer's broad category
// (kcs.top_clicked_category_1_current) equal the first segment of the leaf path?
// Run: node --env-file=.env.local --import tsx scripts/probeDeptBroadCategory0930.ts
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const sample = `SELECT top_clicked_category_1_current AS broad, top_clicked_category_path AS path
                  FROM keyword_current_summary WHERE top_clicked_category_path IS NOT NULL LIMIT 200000`;
  const [totals] = await sql`
    SELECT count(*)::int AS sampled,
           count(*) FILTER (WHERE broad IS DISTINCT FROM split_part(path, ' › ', 1))::int AS mismatches
    FROM (${sql.unsafe(sample)}) s`;
  console.log(JSON.stringify(totals));
  const examples = await sql`
    SELECT broad, split_part(path, ' › ', 1) AS root, count(*)::int AS n
    FROM (${sql.unsafe(sample)}) s
    WHERE broad IS DISTINCT FROM split_part(path, ' › ', 1)
    GROUP BY 1, 2 ORDER BY n DESC LIMIT 5`;
  console.log(JSON.stringify(examples));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.name : String(e));
  process.exit(1);
});
```

Run: `node --env-file=.env.local --import tsx scripts/probeDeptBroadCategory0930.ts`
Expected: one JSON line like `{"sampled":200000,"mismatches":0}` then `[]`.

Decision rule: **`mismatches` is 0** → keep the department shortcut exactly as written in Steps 2–3. **`mismatches` is not 0** → the two columns are not the same thing: delete the `departmentAlone` branch in Step 3 (always `out.leafPaths = [...input.leaves]`), delete the "department alone" test in Step 2, and edit the spec's §5.2 department row to say "Dropped 2026-09-30: the probe found N mismatches in 200k rows; department selections expand to leaves like every other selection." Record the probe's two output lines in the commit message either way.

- [ ] **Step 2: Write the failing tests — `lib/workspace/explorerFilters.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { EXPLORER_DEFAULTS, parseExplorerFilters } from '@/lib/explorer/parseFilters';
import { searchParamsToLike } from '@/lib/explorer/export/query';
import { normalizeFilters } from '@/lib/savedViews/validation';
import { filtersSchema, type Filters, type Sort, type Window } from '@/lib/research/contracts';
import {
  compactExplorerFilters, customCategoryUrlFor, explorerUrlFor, savedViewUrlFor, toExplorerFilters,
  NOTE_BASELINE, NOTE_DELTA, NOTE_JUMP_INVALID, NOTE_PRIOR_BAND, NOTE_PRIOR_ONLY, NOTE_WORD_COUNT_SORT,
} from './explorerFilters';

const APP = 'https://keywordquarry.com';
const CUSTOM_ID = '11111111-1111-4111-8111-111111111111';
const SORT: Sort = { field: 'estimatedMonthlySearches', direction: 'desc' };
const F = (partial: Record<string, unknown> = {}): Filters => filtersSchema.parse(partial);
const convert = (filters: Filters, over: { sort?: Sort; window?: Window; leaves?: string[] } = {}) =>
  toExplorerFilters({ filters, sort: over.sort ?? SORT, window: over.window ?? '4w', leaves: over.leaves ?? [] });

describe('toExplorerFilters', () => {
  it('an empty search is the default Explorer at the search window, with no notes', () => {
    const { filters, notes } = convert(F());
    expect(filters).toEqual({ ...EXPLORER_DEFAULTS, window: '4w' });
    expect(notes).toEqual([]);
  });

  it('copies text, excluded terms, ranges (gt/lt shifted to inclusive), broad category, severities and title gap exactly', () => {
    const { filters, notes } = convert(F({
      text: { value: 'lamp', mode: 'broad' }, excludeTerms: ['floor'],
      rank: { gt: 100, lte: 5000 }, estimatedMonthlySearches: { gte: 1000, lt: 20000 }, averageReviews: { lt: 500 }, wordCount: { gte: 4 },
      broadCategory: 'Home', severities: ['none'], titleGap: { slots: [1, 2], quantifier: 'all', mode: 'strict' },
    }));
    expect(filters).toMatchObject({
      q: 'lamp', qMode: 'broad', qExclude: ['floor'], rankMin: 101, rankMax: 5000, volMin: 1000, volMax: 19999, reviewsMin: null, reviewsMax: 499,
      wordsMin: 4, wordsMax: null, category: 'Home', severities: ['none'], titleSlots: [1, 2], titleMatchMode: 'all', matchMode: 'strict', jump: null,
    });
    expect(notes).toEqual([]);
  });

  it('taxonomy selections become the expanded leaves; custom selections pass by id and are never expanded', () => {
    const { filters } = convert(
      F({ categories: { selections: [{ kind: 'taxonomy', path: 'A › B', includeDescendants: true }, { kind: 'custom', id: CUSTOM_ID }] } }),
      { leaves: ['A › B › C', 'A › B › D'] },
    );
    expect(filters.leafPaths).toEqual(['A › B › C', 'A › B › D']);
    expect(filters.customCategoryIds).toEqual([CUSTOM_ID]);
    expect(filters.category).toBeNull();
  });

  it('a department alone becomes the broad category instead of its leaves; anything alongside it keeps the leaves', () => {
    const dept = { kind: 'taxonomy' as const, path: 'Lighting', includeDescendants: true };
    const alone = convert(F({ categories: { selections: [dept] } }), { leaves: ['Lighting › Lamps', 'Lighting › Ceiling Lights'] });
    expect(alone.filters).toMatchObject({ category: 'Lighting', leafPaths: [] });
    const withLeaf = convert(F({ categories: { selections: [dept], leafPaths: ['Pet Supplies › Beds'] } }), { leaves: ['Lighting › Lamps', 'Pet Supplies › Beds'] });
    expect(withLeaf.filters).toMatchObject({ category: null, leafPaths: ['Lighting › Lamps', 'Pet Supplies › Beds'] });
    const withBroad = convert(F({ broadCategory: 'Home', categories: { selections: [dept] } }), { leaves: ['Lighting › Lamps'] });
    expect(withBroad.filters).toMatchObject({ category: 'Home', leafPaths: ['Lighting › Lamps'] });
  });

  it('"moved from 100k to 50k over the last week" lands on the rank preset, with the baseline note', () => {
    const { filters, notes } = convert(F({ movement: { window: '1w', metric: 'rank', prior: { gt: 100000 }, current: { lt: 50000 } } }), { window: '1w' });
    expect(filters).toMatchObject({ window: '1w', jump: '100k_to_50k', jumpMetric: 'rank', jumpFrom: null, jumpTo: null, rankMin: null, rankMax: null });
    expect(notes).toEqual([NOTE_BASELINE]);
  });

  it('shifts gte/lte onto the Explorer\'s strict from/to and falls back to a custom jump; include_not_observed is exact', () => {
    const { filters, notes } = convert(F({ movement: { window: '4w', metric: 'rank', prior: { gte: 80001 }, current: { lte: 39999 }, baseline: 'include_not_observed' } }));
    expect(filters).toMatchObject({ jump: 'custom', jumpMetric: 'rank', jumpFrom: 80000, jumpTo: 40000 });
    expect(notes).toEqual([]);
  });

  it('maps a volume move onto the volume presets', () => {
    const { filters } = convert(F({ movement: { window: '4w', metric: 'volume', prior: { lt: 5000 }, current: { gt: 15000 }, baseline: 'include_not_observed' } }));
    expect(filters).toMatchObject({ jump: 'v5k_to_15k', jumpMetric: 'volume' });
  });

  it('a current-only bound is the plain range, exactly; a prior-only bound is dropped with a note', () => {
    const currentOnly = convert(F({ movement: { window: '4w', metric: 'rank', current: { lt: 50000 } } }));
    expect(currentOnly.filters).toMatchObject({ jump: null, rankMax: 49999 });
    expect(currentOnly.notes).toEqual([NOTE_BASELINE]);
    const priorOnly = convert(F({ movement: { window: '4w', metric: 'volume', prior: { lt: 5000 }, baseline: 'include_not_observed' } }));
    expect(priorOnly.filters).toMatchObject({ jump: null, volMin: null, volMax: null });
    expect(priorOnly.notes).toEqual([NOTE_PRIOR_ONLY]);
  });

  it('a band on the prior keeps the side the jump uses and notes the other; an extra current bound tightens the plain range', () => {
    // observed_only on purpose: the schema forbids a prior upper bound under include_not_observed for rank.
    const { filters, notes } = convert(F({ movement: { window: '4w', metric: 'rank', prior: { gt: 100000, lt: 500000 }, current: { gte: 10000, lt: 50000 } } }));
    expect(filters).toMatchObject({ jump: 'custom', jumpFrom: 100000, jumpTo: 50000, rankMin: 10000, rankMax: null });
    expect(notes).toEqual([NOTE_PRIOR_BAND, NOTE_BASELINE]);
  });

  it('a delta filter is dropped with a note and nothing else changes', () => {
    const { filters, notes } = convert(F({ movement: { window: '4w', metric: 'volume', delta: { gt: 0 } } }));
    expect(filters).toMatchObject({ jump: null, volMin: null, volMax: null });
    expect(notes).toEqual([NOTE_DELTA]);
  });

  it('a move the Explorer would reject is dropped with a note; its current bound still becomes the plain range', () => {
    const { filters, notes } = convert(F({ movement: { window: '4w', metric: 'rank', prior: { gt: 100 }, current: { lt: 200 }, baseline: 'include_not_observed' } }));
    expect(filters).toMatchObject({ jump: null, rankMax: 199 });
    expect(notes).toEqual([NOTE_JUMP_INVALID]);
  });

  it('maps every sort; word count falls back to rank with a note', () => {
    const sortOf = (sort: Sort) => convert(F(), { sort });
    expect(sortOf({ field: 'estimatedMonthlySearches', direction: 'desc' }).filters.sort).toBe('rank');
    expect(sortOf({ field: 'estimatedMonthlySearches', direction: 'asc' }).filters.sort).toBe('rank_desc');
    expect(sortOf({ field: 'rank', direction: 'asc' }).filters.sort).toBe('rank');
    expect(sortOf({ field: 'rank', direction: 'desc' }).filters.sort).toBe('rank_desc');
    expect(sortOf({ field: 'averageReviews', direction: 'asc' }).filters.sort).toBe('avg_reviews_asc');
    expect(sortOf({ field: 'averageReviews', direction: 'desc' }).filters.sort).toBe('avg_reviews_desc');
    expect(sortOf({ field: 'volumeDelta', direction: 'desc' }).filters.sort).toBe('imp');
    expect(sortOf({ field: 'volumeDelta', direction: 'asc' }).filters.sort).toBe('decline');
    const words = sortOf({ field: 'wordCount', direction: 'asc' });
    expect(words.filters.sort).toBe('rank');
    expect(words.notes).toEqual([NOTE_WORD_COUNT_SORT]);
  });

  it('round-trips through the saved-view normaliser and through its own link', () => {
    const { filters } = convert(
      F({ text: { value: 'desk lamp' }, excludeTerms: ['floor', 'ceiling fan'], rank: { lte: 20000 }, averageReviews: { lt: 500 }, severities: ['none', 'warning', 'critical'],
          titleGap: { slots: [1, 2, 3], quantifier: 'any', mode: 'loose' }, movement: { window: '13w', metric: 'volume', prior: { lt: 30000 }, current: { gte: 100001 } },
          categories: { selections: [{ kind: 'taxonomy', path: 'A › B', includeDescendants: true }, { kind: 'custom', id: CUSTOM_ID }] } }),
      { window: '13w', sort: { field: 'volumeDelta', direction: 'desc' }, leaves: ['A › B › C'] },
    );
    expect(normalizeFilters(filters)).toEqual({ ...filters, page: 1, perPage: 100 });
    const url = explorerUrlFor(APP, filters)!;
    expect(url.startsWith(`${APP}/explorer?`)).toBe(true);
    expect(parseExplorerFilters(searchParamsToLike(new URL(url).searchParams))).toEqual({ ...filters, page: 1, perPage: 100 });
  });
});

describe('compactExplorerFilters', () => {
  it('keeps only the fields that differ from the defaults, never pagination, and jumpMetric only with a jump', () => {
    expect(compactExplorerFilters({ ...EXPLORER_DEFAULTS })).toEqual({});
    expect(compactExplorerFilters({ ...EXPLORER_DEFAULTS, q: 'lamp', page: 3, perPage: 50, jumpMetric: 'volume' })).toEqual({ q: 'lamp' });
    expect(compactExplorerFilters({ ...EXPLORER_DEFAULTS, jump: 'v5k_to_15k', jumpMetric: 'volume' })).toEqual({ jump: 'v5k_to_15k', jumpMetric: 'volume' });
  });
});

describe('links', () => {
  it('builds the view and category links off APP_PUBLIC_URL without a double slash', () => {
    expect(savedViewUrlFor('https://keywordquarry.com/', 'v1')).toBe('https://keywordquarry.com/explorer?view=v1');
    expect(customCategoryUrlFor(APP, 'c1')).toBe('https://keywordquarry.com/explorer?custom=c1');
  });
  it('omits a search link that would exceed 12,000 bytes', () => {
    const leaves = Array.from({ length: 400 }, (_, i) => `Department › Section ${i} › A fairly long leaf category name ${i}`);
    expect(explorerUrlFor(APP, { ...EXPLORER_DEFAULTS, leafPaths: leaves })).toBeNull();
    expect(explorerUrlFor(APP, { ...EXPLORER_DEFAULTS, leafPaths: leaves.slice(0, 3) })).toContain('leaf=');
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm vitest run lib/workspace/explorerFilters.test.ts`
Expected: FAIL — cannot resolve `./explorerFilters`.

- [ ] **Step 4: Implement `lib/workspace/explorerFilters.ts`**

```ts
/**
 * Research search → Explorer filters (spec 2026-09-30 §5). Pure, no I/O. Serves the
 * `explorerUrl` on every search answer (lib/research/service.ts) and the saved-view tools
 * (lib/workspace/service.ts). The caller runs the search's own validation first
 * (parseSearchInput → applyPresets → resolveScope); this module only maps.
 */
import { isDeepStrictEqual } from 'node:util';
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';
import { filtersToQueryString } from '@/lib/explorer/export/query';
import { jumpPresetsFor } from '@/lib/explorer/jumpPresets';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';
import type { ExplorerFilters, JumpKey, SortKey } from '@/lib/explorer/types';
import type { Filters, IntegerRange, Sort, Window } from '@/lib/research/contracts';

export interface ConvertInput {
  /** The search's effective filters, after applyPresets. */
  filters: Filters;
  sort: Sort;
  /** The window the search ran with (its effective comparisonWindow), so the Explorer shows the same change columns. */
  window: Window;
  /** Terminal leaves expanded from the taxonomy selections and explicit leaf paths only — never from custom selections, which pass by id. */
  leaves: string[];
}
export interface ConvertResult {
  filters: ExplorerFilters;
  /** What could not carry over, in plain words; the guide tells the AI to relay every entry. */
  notes: string[];
}

export const NOTE_BASELINE = "The Explorer's movement filter also counts keywords that had no earlier value, so it can show a few more rows than this search.";
export const NOTE_DELTA = 'The Explorer cannot filter on the size of the change itself; the from/to move was kept.';
export const NOTE_PRIOR_ONLY = 'The Explorer cannot filter on the earlier value alone; that part of the movement filter was dropped.';
export const NOTE_PRIOR_BAND = 'The Explorer takes a single from-value for a move; the other bound on the earlier value was dropped.';
export const NOTE_JUMP_INVALID = 'The Explorer only accepts a move from a worse rank to a better one, or from a lower volume to a higher one; this move was dropped.';
export const NOTE_WORD_COUNT_SORT = 'The Explorer cannot sort by word count; the view opens sorted by rank.';
export const NOTE_LINK_TOO_LONG = 'Too many leaf categories for a link; save it as a view instead.';
/** Vercel's CDN rejects URLs over 14 KB (§5.6); stay well under it. */
export const MAX_EXPLORER_URL_BYTES = 12_000;

type Selection = Filters['categories']['selections'][number];
type TaxonomySelection = Extract<Selection, { kind: 'taxonomy' }>;
const isTaxonomy = (s: Selection): s is TaxonomySelection => s.kind === 'taxonomy';

/** Inclusive Explorer bounds for an exact research range: gt n → n+1, lt n → n−1 (§5.2). */
function inclusive(r: IntegerRange | null | undefined): { min: number | null; max: number | null } {
  if (!r) return { min: null, max: null };
  const min = r.gte !== undefined ? r.gte : r.gt !== undefined ? r.gt + 1 : null;
  const max = r.lte !== undefined ? r.lte : r.lt !== undefined ? r.lt - 1 : null;
  return { min, max };
}

const tighterMin = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
const tighterMax = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/** Narrows the plain range on `metric` by an inclusive bound pair — a movement bound the jump cannot carry (§5.3). */
function tightenPlainRange(out: ExplorerFilters, metric: 'rank' | 'volume', bounds: { min: number | null; max: number | null }): void {
  if (metric === 'rank') {
    out.rankMin = tighterMin(out.rankMin, bounds.min);
    out.rankMax = tighterMax(out.rankMax, bounds.max);
  } else {
    out.volMin = tighterMin(out.volMin, bounds.min);
    out.volMax = tighterMax(out.volMax, bounds.max);
  }
}

/**
 * §5.3. The Explorer's jump is "was on one side of `from`, now past `to`": rank compiles to
 * `(prior > from OR prior IS NULL) AND current < to`, volume to `(prior < from OR prior IS NULL)
 * AND current > to`. Exact research comparators shift onto those strict bounds; whatever the
 * jump cannot carry either tightens the plain range (current side, exact) or is dropped with a note.
 */
function convertMovement(m: NonNullable<Filters['movement']>, out: ExplorerFilters, notes: string[]): void {
  if (m.delta) notes.push(NOTE_DELTA);
  const prior = m.prior;
  const current = m.current;
  const from = m.metric === 'rank'
    ? (prior?.gte !== undefined ? prior.gte - 1 : prior?.gt)
    : (prior?.lte !== undefined ? prior.lte + 1 : prior?.lt);
  const to = m.metric === 'rank'
    ? (current?.lte !== undefined ? current.lte + 1 : current?.lt)
    : (current?.gte !== undefined ? current.gte - 1 : current?.gt);
  const priorHasOtherSide = m.metric === 'rank'
    ? prior?.lt !== undefined || prior?.lte !== undefined
    : prior?.gt !== undefined || prior?.gte !== undefined;
  let mapped = false;
  if (from !== undefined && to !== undefined) {
    const valid = m.metric === 'rank' ? from > to : from < to;
    if (valid) {
      const preset = jumpPresetsFor(m.metric).find((p) => p.from === from && p.to === to);
      out.jump = preset ? (preset.id as JumpKey) : 'custom';
      out.jumpMetric = m.metric;
      out.jumpFrom = preset ? null : from;
      out.jumpTo = preset ? null : to;
      // The current-side bound the jump does not read is still exact as a plain range.
      const leftover = inclusive(current);
      tightenPlainRange(out, m.metric, m.metric === 'rank' ? { min: leftover.min, max: null } : { min: null, max: leftover.max });
      if (priorHasOtherSide) notes.push(NOTE_PRIOR_BAND);
    } else {
      notes.push(NOTE_JUMP_INVALID);
      tightenPlainRange(out, m.metric, inclusive(current));
    }
    mapped = true;
  } else {
    if (from !== undefined) notes.push(NOTE_PRIOR_ONLY);
    if (current) {
      // A current-side bound with no usable prior bound is not a move: it is the plain range, exactly.
      tightenPlainRange(out, m.metric, inclusive(current));
      mapped = true;
    }
  }
  if (mapped && m.baseline === 'observed_only') notes.push(NOTE_BASELINE);
}

/** §5.4. */
function convertSort(sort: Sort, notes: string[]): SortKey {
  switch (sort.field) {
    case 'estimatedMonthlySearches':
      return sort.direction === 'desc' ? 'rank' : 'rank_desc';
    case 'rank':
      return sort.direction === 'asc' ? 'rank' : 'rank_desc';
    case 'averageReviews':
      return sort.direction === 'asc' ? 'avg_reviews_asc' : 'avg_reviews_desc';
    case 'volumeDelta':
      return sort.direction === 'desc' ? 'imp' : 'decline';
    case 'wordCount':
      notes.push(NOTE_WORD_COUNT_SORT);
      return 'rank';
  }
}

export function toExplorerFilters(input: ConvertInput): ConvertResult {
  const f = input.filters;
  const notes: string[] = [];
  const out: ExplorerFilters = {
    ...EXPLORER_DEFAULTS,
    window: input.window,
    qExclude: [...f.excludeTerms],
    leafPaths: [],
    customCategoryIds: [],
    severities: [...f.severities],
    titleSlots: [...EXPLORER_DEFAULTS.titleSlots],
  };
  if (f.text) {
    out.q = f.text.value;
    out.qMode = f.text.mode;
  }
  ({ min: out.rankMin, max: out.rankMax } = inclusive(f.rank));
  ({ min: out.volMin, max: out.volMax } = inclusive(f.estimatedMonthlySearches));
  ({ min: out.reviewsMin, max: out.reviewsMax } = inclusive(f.averageReviews));
  ({ min: out.wordsMin, max: out.wordsMax } = inclusive(f.wordCount));
  out.category = f.broadCategory;
  if (f.titleGap) {
    out.titleSlots = [...f.titleGap.slots];
    out.titleMatchMode = f.titleGap.quantifier;
    out.matchMode = f.titleGap.mode;
  }
  const taxonomy = f.categories.selections.filter(isTaxonomy);
  out.customCategoryIds = f.categories.selections.filter((s) => s.kind === 'custom').map((s) => s.id);
  // §5.2: a whole department alone maps to the Explorer's broad category (same column as
  // broadCategory) instead of thousands of leaves. Only when it is the sole selection with no
  // explicit leaf paths and no broadCategory: the Explorer ANDs `category` with `leafPaths`,
  // while the search ORs its selections.
  const departmentAlone =
    taxonomy.length === 1 && f.categories.selections.length === 1 && f.categories.leafPaths.length === 0 &&
    taxonomy[0].includeDescendants && !taxonomy[0].path.includes(PATH_SEP) && f.broadCategory === null;
  if (departmentAlone) out.category = taxonomy[0].path;
  else out.leafPaths = [...input.leaves];
  if (f.movement) convertMovement(f.movement, out, notes);
  out.sort = convertSort(input.sort, notes);
  return { filters: out, notes };
}

/** §5.5: the fields that differ from the Explorer defaults; never pagination; `jumpMetric` only with a jump. */
export function compactExplorerFilters(f: ExplorerFilters): Partial<ExplorerFilters> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(EXPLORER_DEFAULTS) as Array<keyof ExplorerFilters>) {
    if (key === 'page' || key === 'perPage') continue;
    if (key === 'jumpMetric' && f.jump === null) continue;
    if (!isDeepStrictEqual(f[key], EXPLORER_DEFAULTS[key])) out[key] = f[key];
  }
  return out as Partial<ExplorerFilters>;
}

const base = (appUrl: string) => appUrl.replace(/\/+$/, '');

/** §5.6: the Explorer opened with `filters`, or null when the link would be too long for Vercel's CDN. */
export function explorerUrlFor(appUrl: string, filters: ExplorerFilters): string | null {
  const url = `${base(appUrl)}/explorer?${filtersToQueryString(filters)}`;
  return Buffer.byteLength(url, 'utf8') > MAX_EXPLORER_URL_BYTES ? null : url;
}

export function savedViewUrlFor(appUrl: string, id: string): string {
  return `${base(appUrl)}/explorer?view=${id}`;
}

export function customCategoryUrlFor(appUrl: string, id: string): string {
  return `${base(appUrl)}/explorer?custom=${id}`;
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm vitest run lib/workspace/explorerFilters.test.ts && pnpm typecheck`
Expected: PASS. If `convertSort` fails `noImplicitReturns`, add `return 'rank';` after the switch with the comment `// unreachable: every SortField is handled above`.

- [ ] **Step 6: Commit** (the probe script stays untracked; quote its two output lines in the message)

```bash
git add lib/workspace/explorerFilters.ts lib/workspace/explorerFilters.test.ts
git commit -F - <<'MSG'
feat(workspace): research search → Explorer filters converter, compact filters and Explorer links (spec 2026-09-30 §5)

Department probe (scripts/probeDeptBroadCategory0930.ts, read-only, 200k-row sample): <paste the two JSON lines here>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 4: Saved-view commands, with the routes pinned first

The route tests are written **against the routes as they are today** and must pass before anything is extracted (§6.4). Then the commands module lands under them.

**Files:**
- Test (new, pins today's behaviour): `app/api/explorer/saved-views/route.test.ts`, `app/api/explorer/saved-views/[id]/route.test.ts`
- Create: `lib/savedViews/commands.ts`, `lib/savedViews/commands.test.ts`
- Modify: `app/api/explorer/saved-views/route.ts`, `app/api/explorer/saved-views/[id]/route.ts`

> **Landed as d953890 + b2f53bb (2026-09-30).** The route tests passed against the untouched routes (14) and unchanged against the delegating routes. Spec review: compliant; two minor findings — the stray `export` keywords on the test helpers below were rightly dropped, and a JSON body of literal `null` 500'd (pre-existing on POST, new on PATCH with a bad id because the body is now read first) → b2f53bb hardens both routes with optional chaining and adds null-body tests. The import list in Step 7 was wrong about `savedViews`/`MAX_VIEWS_PER_USER`: `GET` still needs them; only imports that actually become unused are dropped. Code-quality review (approve with fixes) → fix round 2, 2c737cc: Step 5's `isUniqueViolation` never matched in production (drizzle wraps driver errors; the 23505 sits on `cause`) — replaced by the shared `lib/db/pgErrorCode.ts`, with `DrizzleQueryError`-shaped test doubles; PgDialect pins of the owner scoping on COUNT/update/delete; insert-payload, filters-only and legacy-blob pins; `lib/savedViews/httpStatus.ts` used by every route; `rowToSavedView` shared by loaders and commands. Full unit suite 178 files / 1,789 tests green. Do not reintroduce the top-level-only `code` check shown in Step 5.

Before touching the routes, read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (route handlers; `params` is a Promise in this version).

- [ ] **Step 1: Route tests against today's routes — `app/api/explorer/saved-views/route.test.ts`**

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRequireUser, mockDb } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockDb: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(), currentUser: vi.fn() }));
vi.mock('@/db/client', () => ({ db: mockDb }));
vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({ requireAuthenticatedUser: mockRequireUser }));
vi.mock('@/lib/auth/requireAdmin', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/AuthError')>('@/lib/auth/AuthError');
  return { AuthError: actual.AuthError };
});

import { GET, POST } from './route';
import { AuthError } from '@/lib/auth/AuthError';
import { normalizeFilters } from '@/lib/savedViews/validation';

export const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'm@example.com', role: 'standard_user' };
export const VIEW_ID = '11111111-1111-4111-8111-111111111111';
export const row = {
  id: VIEW_ID, userId: USER.id, name: 'Lamps', filters: normalizeFilters({ q: 'lamp' }),
  createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T10:00:00Z'),
};
export const dto = { id: VIEW_ID, name: 'Lamps', filters: row.filters, createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };
export const uniqueViolation = () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

/** Next `db.select(...).from(...).where(...)` resolves to `rows` (the COUNT query). */
export function selectWhere(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}
/** Next `db.select().from().where().orderBy().limit()` resolves to `rows` (the list query). */
export function selectList(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => ({ limit: vi.fn().mockResolvedValueOnce(rows) }) }) }) } as never);
}
export function insertReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.insert.mockReturnValueOnce({ values: vi.fn().mockReturnValueOnce({ returning }) } as never);
}

const post = (body: unknown) => POST(new Request('https://keywordquarry.com/api/explorer/saved-views', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

describe('GET /api/explorer/saved-views', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('lists the caller\'s views as DTOs', async () => {
    selectList([row]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ views: [dto] });
  });
  it('is 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthError('UNAUTHENTICATED', 'Not signed in'));
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not signed in' });
  });
});

describe('POST /api/explorer/saved-views', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('creates a view and returns its DTO', async () => {
    selectWhere([{ n: 2 }]);
    insertReturning([row]);
    const res = await post({ name: ' Lamps ', filters: { q: 'lamp' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ view: dto });
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });
  it('rejects a missing name with the validateName message', async () => {
    const res = await post({ filters: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'name must be a string' });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it('refuses the sixth view with the cap sentence', async () => {
    selectWhere([{ n: 5 }]);
    const res = await post({ name: 'Sixth', filters: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "You've reached the 5-view limit. Delete a saved view to add a new one." });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
  it('maps a unique violation to 409 naming the clash', async () => {
    selectWhere([{ n: 1 }]);
    insertReturning(uniqueViolation());
    const res = await post({ name: 'Lamps', filters: {} });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'You already have a view named "Lamps". Choose a different name or update the existing one.' });
  });
  it('is 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthError('UNAUTHENTICATED', 'Not signed in'));
    expect((await post({ name: 'x', filters: {} })).status).toBe(401);
  });
});
```

And `app/api/explorer/saved-views/[id]/route.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRequireUser, mockDb } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockDb: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(), currentUser: vi.fn() }));
vi.mock('@/db/client', () => ({ db: mockDb }));
vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({ requireAuthenticatedUser: mockRequireUser }));
vi.mock('@/lib/auth/requireAdmin', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/AuthError')>('@/lib/auth/AuthError');
  return { AuthError: actual.AuthError };
});

import { PATCH, DELETE } from './route';
import { normalizeFilters } from '@/lib/savedViews/validation';

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'm@example.com', role: 'standard_user' };
const VIEW_ID = '11111111-1111-4111-8111-111111111111';
const row = {
  id: VIEW_ID, userId: USER.id, name: 'Lamps', filters: normalizeFilters({ q: 'lamp' }),
  createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T11:00:00Z'),
};
const dto = { id: VIEW_ID, name: 'Lamps', filters: row.filters, createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T11:00:00.000Z' };
const uniqueViolation = () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

function updateReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.update.mockReturnValueOnce({ set: vi.fn().mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning }) }) } as never);
}
function deleteReturning(rows: unknown[]) {
  mockDb.delete.mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`https://keywordquarry.com/api/explorer/saved-views/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), params(id));
const del = (id: string) => DELETE(new Request(`https://keywordquarry.com/api/explorer/saved-views/${id}`, { method: 'DELETE' }), params(id));

describe('PATCH /api/explorer/saved-views/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('renames and returns the DTO', async () => {
    updateReturning([row]);
    const res = await patch(VIEW_ID, { name: 'Lamps' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ view: dto });
  });
  it('rejects a malformed id before any query', async () => {
    const res = await patch('nope', { name: 'x' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid view id' });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
  it('rejects a bad name and an empty patch', async () => {
    expect(await (await patch(VIEW_ID, { name: '' })).json()).toEqual({ error: 'name cannot be empty' });
    const empty = await patch(VIEW_ID, {});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'nothing to update' });
  });
  it('is 404 for a view that is not the caller\'s', async () => {
    updateReturning([]);
    const res = await patch(VIEW_ID, { name: 'x' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'view not found' });
  });
  it('maps a unique violation to 409', async () => {
    updateReturning(uniqueViolation());
    const res = await patch(VIEW_ID, { name: 'Taken' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'You already have a view with that name.' });
  });
});

describe('DELETE /api/explorer/saved-views/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('deletes and answers ok', async () => {
    deleteReturning([{ id: VIEW_ID, name: 'Lamps' }]);
    const res = await del(VIEW_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it('is 400 for a malformed id and 404 when nothing matched', async () => {
    expect((await del('nope')).status).toBe(400);
    deleteReturning([]);
    const res = await del(VIEW_ID);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'view not found' });
  });
});
```

- [ ] **Step 2: Run them against today's routes**

Run: `pnpm vitest run "app/api/explorer/saved-views"`
Expected: PASS (these pin the current behaviour). If a chain shape differs from the route's actual drizzle calls, fix the **mock helper**, never the assertion.

- [ ] **Step 3: Failing tests for the commands — `lib/savedViews/commands.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() } }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/db/client', () => ({ db: mockDb }));

import { createSavedView, deleteSavedView, updateSavedView } from './commands';
import { normalizeFilters } from './validation';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const VIEW_ID = '11111111-1111-4111-8111-111111111111';
const row = { id: VIEW_ID, userId: USER_ID, name: 'Lamps', filters: normalizeFilters({ q: 'lamp' }), createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T10:00:00Z') };
const view = { id: VIEW_ID, name: 'Lamps', filters: row.filters, createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };
const uniqueViolation = () => Object.assign(new Error('dup'), { code: '23505' });

function selectWhere(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}
function insertReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.insert.mockReturnValueOnce({ values: vi.fn().mockReturnValueOnce({ returning }) } as never);
}
function updateReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.update.mockReturnValueOnce({ set: vi.fn().mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning }) }) } as never);
}
function deleteReturning(rows: unknown[]) {
  mockDb.delete.mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('createSavedView', () => {
  it('validates the name, normalises the filters and returns the view', async () => {
    selectWhere([{ n: 0 }]);
    insertReturning([row]);
    await expect(createSavedView(USER_ID, { name: ' Lamps ', filters: { q: 'lamp' } })).resolves.toEqual({ ok: true, view });
  });
  it('fails closed on a bad name before any query', async () => {
    await expect(createSavedView(USER_ID, { name: 'x'.repeat(81), filters: {} })).resolves.toEqual({ ok: false, code: 'invalid_name', message: 'name cannot exceed 80 characters' });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it('refuses at the cap with the app\'s sentence', async () => {
    selectWhere([{ n: 5 }]);
    await expect(createSavedView(USER_ID, { name: 'Sixth', filters: {} })).resolves.toEqual({ ok: false, code: 'cap_reached', message: "You've reached the 5-view limit. Delete a saved view to add a new one." });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
  it('reports a duplicate name', async () => {
    selectWhere([{ n: 1 }]);
    insertReturning(uniqueViolation());
    await expect(createSavedView(USER_ID, { name: 'Lamps', filters: {} })).resolves.toEqual({ ok: false, code: 'duplicate_name', message: 'You already have a view named "Lamps". Choose a different name or update the existing one.' });
  });
  it('rethrows any other database error', async () => {
    selectWhere([{ n: 1 }]);
    insertReturning(new Error('connect ETIMEDOUT'));
    await expect(createSavedView(USER_ID, { name: 'Lamps', filters: {} })).rejects.toThrow('connect ETIMEDOUT');
  });
});

describe('updateSavedView', () => {
  it('renames, re-filters, or both, and sets updatedAt', async () => {
    updateReturning([row]);
    await expect(updateSavedView(USER_ID, VIEW_ID, { name: 'Lamps' })).resolves.toEqual({ ok: true, view });
    const set = (mockDb.update.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set;
    expect(set.mock.calls[0][0]).toMatchObject({ name: 'Lamps', updatedAt: expect.any(Date) });
    expect(set.mock.calls[0][0].filters).toBeUndefined();
  });
  it('rejects a malformed id, a bad name and an empty patch without querying', async () => {
    await expect(updateSavedView(USER_ID, 'nope', { name: 'x' })).resolves.toEqual({ ok: false, code: 'invalid_id', message: 'invalid view id' });
    await expect(updateSavedView(USER_ID, VIEW_ID, { name: '' })).resolves.toEqual({ ok: false, code: 'invalid_name', message: 'name cannot be empty' });
    await expect(updateSavedView(USER_ID, VIEW_ID, {})).resolves.toEqual({ ok: false, code: 'nothing_to_update', message: 'nothing to update' });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
  it('is not_found for a foreign or missing id, and duplicate_name on 23505', async () => {
    updateReturning([]);
    await expect(updateSavedView(USER_ID, VIEW_ID, { name: 'x' })).resolves.toEqual({ ok: false, code: 'not_found', message: 'view not found' });
    updateReturning(uniqueViolation());
    await expect(updateSavedView(USER_ID, VIEW_ID, { name: 'Taken' })).resolves.toEqual({ ok: false, code: 'duplicate_name', message: 'You already have a view with that name.' });
  });
});

describe('deleteSavedView', () => {
  it('deletes the caller\'s row and returns what it removed', async () => {
    deleteReturning([{ id: VIEW_ID, name: 'Lamps' }]);
    await expect(deleteSavedView(USER_ID, VIEW_ID)).resolves.toEqual({ ok: true, deleted: { id: VIEW_ID, name: 'Lamps' } });
  });
  it('is invalid_id or not_found otherwise', async () => {
    await expect(deleteSavedView(USER_ID, 'nope')).resolves.toEqual({ ok: false, code: 'invalid_id', message: 'invalid view id' });
    deleteReturning([]);
    await expect(deleteSavedView(USER_ID, VIEW_ID)).resolves.toEqual({ ok: false, code: 'not_found', message: 'view not found' });
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm vitest run lib/savedViews/commands.test.ts`
Expected: FAIL — cannot resolve `./commands`.

- [ ] **Step 5: Implement `lib/savedViews/commands.ts`**

```ts
/**
 * Shared saved-view commands (spec 2026-09-30 §6.1): the API routes and the MCP workspace
 * service both call these, so a cap, a message or a duplicate-name rule can never differ
 * between the app and the AI. Commands return results, never HTTP responses; the caller maps
 * `code` to a status (routes) or a ResearchError (workspace service). Every message is the
 * sentence the routes returned before this module existed, verbatim.
 */
import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { savedViews } from '@/db/schema';
import type { ExplorerFilters } from '@/lib/explorer/types';
import { MAX_VIEWS_PER_USER, normalizeFilters, normalizeFiltersBlob, validateName } from './validation';
import type { SavedView } from './types';

export type SavedViewCommandCode = 'invalid_id' | 'invalid_name' | 'nothing_to_update' | 'cap_reached' | 'duplicate_name' | 'not_found';
export type SavedViewResult<T> = ({ ok: true } & T) | { ok: false; code: SavedViewCommandCode; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a DB error is a Postgres unique-constraint violation (code 23505). */
function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === '23505');
}

function toView(r: typeof savedViews.$inferSelect): SavedView {
  return { id: r.id, name: r.name, filters: normalizeFiltersBlob(r.filters), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

const fail = (code: SavedViewCommandCode, message: string) => ({ ok: false as const, code, message });

export async function createSavedView(userId: string, input: { name: unknown; filters: unknown }): Promise<SavedViewResult<{ view: SavedView }>> {
  const nameResult = validateName(input.name);
  if (!nameResult.ok) return fail('invalid_name', nameResult.error);
  const filters = normalizeFilters(input.filters);
  // Cap. COUNT-then-insert is not atomic: two simultaneous creates from one user can both
  // pass and overshoot by one. Accepted (spec §8.7) — a soft cap; the user can prune.
  const [{ n }] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(savedViews).where(eq(savedViews.userId, userId));
  if (n >= MAX_VIEWS_PER_USER) {
    return fail('cap_reached', `You've reached the ${MAX_VIEWS_PER_USER}-view limit. Delete a saved view to add a new one.`);
  }
  try {
    const [created] = await db.insert(savedViews).values({ userId, name: nameResult.name, filters }).returning();
    return { ok: true, view: toView(created) };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return fail('duplicate_name', `You already have a view named "${nameResult.name}". Choose a different name or update the existing one.`);
    }
    throw e;
  }
}

export async function updateSavedView(userId: string, id: string, input: { name?: unknown; filters?: unknown }): Promise<SavedViewResult<{ view: SavedView }>> {
  if (!UUID_RE.test(id)) return fail('invalid_id', 'invalid view id');
  const updates: { name?: string; filters?: ExplorerFilters; updatedAt: Date } = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const nameResult = validateName(input.name);
    if (!nameResult.ok) return fail('invalid_name', nameResult.error);
    updates.name = nameResult.name;
  }
  if (input.filters !== undefined) updates.filters = normalizeFilters(input.filters);
  if (updates.name === undefined && updates.filters === undefined) return fail('nothing_to_update', 'nothing to update');
  try {
    // Owner-scoped: a foreign id updates nothing and reads as not found (never leaks existence).
    const [updated] = await db.update(savedViews).set(updates).where(and(eq(savedViews.id, id), eq(savedViews.userId, userId))).returning();
    if (!updated) return fail('not_found', 'view not found');
    return { ok: true, view: toView(updated) };
  } catch (e) {
    if (isUniqueViolation(e)) return fail('duplicate_name', 'You already have a view with that name.');
    throw e;
  }
}

export async function deleteSavedView(userId: string, id: string): Promise<SavedViewResult<{ deleted: { id: string; name: string } }>> {
  if (!UUID_RE.test(id)) return fail('invalid_id', 'invalid view id');
  const [deleted] = await db
    .delete(savedViews)
    .where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)))
    .returning({ id: savedViews.id, name: savedViews.name });
  if (!deleted) return fail('not_found', 'view not found');
  return { ok: true, deleted };
}
```

- [ ] **Step 6: Run the command tests**

Run: `pnpm vitest run lib/savedViews/commands.test.ts`
Expected: PASS.

- [ ] **Step 7: Make the routes delegate**

`app/api/explorer/saved-views/route.ts` — keep `GET` exactly as it is; replace `POST` and drop the now-unused imports (`sql`, `savedViews`, `MAX_VIEWS_PER_USER`, `normalizeFilters`, `validateName`, `isUniqueViolation`):

```ts
import { createSavedView } from '@/lib/savedViews/commands';

export async function POST(req: Request) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    return handleAuthError(e);
  }
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; filters?: unknown };
  const result = await createSavedView(user.id, { name: body.name, filters: body.filters });
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.code === 'duplicate_name' ? 409 : 400 });
  return NextResponse.json({ view: result.view });
}
```

`app/api/explorer/saved-views/[id]/route.ts` — replace `PATCH` and `DELETE` bodies; drop `UUID_RE`, `isUniqueViolation`, `normalizeFilters`, `validateName`, `db`, `savedViews`, `eq`/`and` imports:

```ts
import { deleteSavedView, updateSavedView, type SavedViewCommandCode } from '@/lib/savedViews/commands';

const STATUS: Record<SavedViewCommandCode, number> = {
  invalid_id: 400, invalid_name: 400, nothing_to_update: 400, cap_reached: 400, duplicate_name: 409, not_found: 404,
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    return handleAuthError(e);
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; filters?: unknown };
  const result = await updateSavedView(user.id, id, { name: body.name, filters: body.filters });
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: STATUS[result.code] });
  return NextResponse.json({ view: result.view });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    return handleAuthError(e);
  }
  const { id } = await params;
  const result = await deleteSavedView(user.id, id);
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: STATUS[result.code] });
  return NextResponse.json({ ok: true });
}
```

Keep each file's `handleAuthError` and its `runtime = 'nodejs'` export.

- [ ] **Step 8: Run the route tests, the command tests, lint and typecheck**

Run: `pnpm vitest run "app/api/explorer/saved-views" lib/savedViews && pnpm typecheck && pnpm lint`
Expected: PASS, clean (lint catches any import left unused).

- [ ] **Step 9: Commit**

```bash
git add app/api/explorer/saved-views/route.ts app/api/explorer/saved-views/route.test.ts "app/api/explorer/saved-views/[id]/route.ts" "app/api/explorer/saved-views/[id]/route.test.ts" lib/savedViews/commands.ts lib/savedViews/commands.test.ts
git commit -F - <<'MSG'
refactor(saved-views): shared create/update/delete commands, routes delegate; first route tests pin every status and message (spec 2026-09-30 §6.1, §6.4)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 5: Custom-category commands, with the routes pinned first

Same shape as Task 4. Custom categories differ in three ways: names are unique case-insensitively (the index is on `lower(name)`), the PATCH route is a full replace that requires both fields, and the leaf list is bounded (12,000 paths).

**Files:**
- Test (new, pins today's behaviour): `app/api/category-builder/custom/route.test.ts`, `app/api/category-builder/custom/[id]/route.test.ts`
- Create: `lib/customCategories/commands.ts`, `lib/customCategories/commands.test.ts`
- Modify: `lib/customCategories/loadServer.ts` (add `loadCustomCategoryForUser`)
- Modify: `app/api/category-builder/custom/route.ts`, `app/api/category-builder/custom/[id]/route.ts`

> **Landed as ebea281 (2026-09-30).** Both routes were hardened against a `null` JSON body in the same commit (controller addendum, after the Task 4 finding), with null-body tests appended as separate describes. Spec review: compliant. Code-quality review (approve with fixes) → fix round 8165cda: `isUniqueViolation` is now a re-export of the shared `lib/db/pgErrorCode.ts` (the Step 5 version read only the top-level `code`, which drizzle never sets — duplicates answered 500 in production); the duplicate guard is `isUniqueViolation(e) && updates.name !== undefined`; PgDialect owner-scoping pins on COUNT/update/delete plus a new `loadServer.test.ts`; `too_many_leaves` on update; `expectError(res, status, msg)` on every route error case incl. PATCH `too_many_leaves`, the null-body cases and 401s; `lib/customCategories/httpStatus.ts` used by every route. 6 files / 44 tests. Do not reintroduce the top-level-only `code` check shown in Step 5.

- [ ] **Step 1: Route tests against today's routes**

`app/api/category-builder/custom/route.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRequireUser, mockDb } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockDb: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(), currentUser: vi.fn() }));
vi.mock('@/db/client', () => ({ db: mockDb }));
vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({ requireAuthenticatedUser: mockRequireUser }));
vi.mock('@/lib/auth/requireAdmin', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/AuthError')>('@/lib/auth/AuthError');
  return { AuthError: actual.AuthError };
});

import { GET, POST } from './route';
import { AuthError } from '@/lib/auth/AuthError';

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'm@example.com', role: 'standard_user' };
const CAT_ID = '22222222-2222-4222-8222-222222222222';
const row = { id: CAT_ID, userId: USER.id, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T10:00:00Z') };
const dto = { id: CAT_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };
const uniqueViolation = () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

function selectWhere(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}
function selectList(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: vi.fn().mockResolvedValueOnce(rows) }) }) } as never);
}
function insertReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.insert.mockReturnValueOnce({ values: vi.fn().mockReturnValueOnce({ returning }) } as never);
}
const post = (body: unknown) => POST(new Request('https://keywordquarry.com/api/category-builder/custom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

describe('GET /api/category-builder/custom', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('lists the caller\'s categories as DTOs', async () => {
    selectList([row]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ categories: [dto] });
  });
  it('is 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthError('UNAUTHENTICATED', 'Not signed in'));
    expect((await GET()).status).toBe(401);
  });
});

describe('POST /api/category-builder/custom', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('creates and returns the DTO', async () => {
    selectWhere([{ n: 3 }]);
    insertReturning([row]);
    const res = await post({ name: 'Lighting', leafPaths: ['Lighting › Lamps', 'Lighting › Lamps'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ category: dto });
  });
  it('rejects a missing name, an empty leaf list, and too many leaves', async () => {
    expect(await (await post({ leafPaths: ['x'] })).json()).toEqual({ error: 'name must be a string' });
    expect(await (await post({ name: 'L', leafPaths: [] })).json()).toEqual({ error: 'Add at least one leaf category before saving.' });
    const tooMany = Array.from({ length: 12001 }, (_, i) => `Dept › Leaf ${i}`);
    expect(await (await post({ name: 'L', leafPaths: tooMany })).json()).toEqual({ error: `A category can include at most ${(12000).toLocaleString()} leaves.` });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it('refuses the 26th category with the cap sentence', async () => {
    selectWhere([{ n: 25 }]);
    const res = await post({ name: 'L', leafPaths: ['x'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "You've reached the 25-category limit. Delete one to add another." });
  });
  it('maps a unique violation to 409 naming the clash', async () => {
    selectWhere([{ n: 1 }]);
    insertReturning(uniqueViolation());
    const res = await post({ name: 'Lighting', leafPaths: ['x'] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'You already have a category named "Lighting".' });
  });
});
```

`app/api/category-builder/custom/[id]/route.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRequireUser, mockDb } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockDb: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(), currentUser: vi.fn() }));
vi.mock('@/db/client', () => ({ db: mockDb }));
vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({ requireAuthenticatedUser: mockRequireUser }));
vi.mock('@/lib/auth/requireAdmin', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/AuthError')>('@/lib/auth/AuthError');
  return { AuthError: actual.AuthError };
});

import { PATCH, DELETE } from './route';

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'm@example.com', role: 'standard_user' };
const CAT_ID = '22222222-2222-4222-8222-222222222222';
const row = { id: CAT_ID, userId: USER.id, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T11:00:00Z') };
const dto = { id: CAT_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T11:00:00.000Z' };
const uniqueViolation = () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

function updateReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.update.mockReturnValueOnce({ set: vi.fn().mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning }) }) } as never);
}
function deleteReturning(rows: unknown[]) {
  mockDb.delete.mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`https://keywordquarry.com/api/category-builder/custom/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), params(id));
const del = (id: string) => DELETE(new Request(`https://keywordquarry.com/api/category-builder/custom/${id}`, { method: 'DELETE' }), params(id));

describe('PATCH /api/category-builder/custom/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('replaces name and leaves and returns the DTO', async () => {
    updateReturning([row]);
    const res = await patch(CAT_ID, { name: 'Lighting', leafPaths: ['Lighting › Lamps'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ category: dto });
  });
  it('requires a valid id, a name and at least one leaf', async () => {
    expect(await (await patch('nope', { name: 'L', leafPaths: ['x'] })).json()).toEqual({ error: 'invalid category id' });
    expect(await (await patch(CAT_ID, { leafPaths: ['x'] })).json()).toEqual({ error: 'name must be a string' });
    expect(await (await patch(CAT_ID, { name: 'L' })).json()).toEqual({ error: 'A category needs at least one leaf.' });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
  it('is 404 for a foreign id and 409 on a duplicate name', async () => {
    updateReturning([]);
    const missing = await patch(CAT_ID, { name: 'L', leafPaths: ['x'] });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Not found' });
    updateReturning(uniqueViolation());
    const dup = await patch(CAT_ID, { name: 'Taken', leafPaths: ['x'] });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: 'You already have a category named "Taken".' });
  });
});

describe('DELETE /api/category-builder/custom/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('deletes and answers ok; 400 and 404 otherwise', async () => {
    deleteReturning([{ id: CAT_ID, name: 'Lighting', leafPaths: ['x'] }]);
    expect(await (await del(CAT_ID)).json()).toEqual({ ok: true });
    expect((await del('nope')).status).toBe(400);
    deleteReturning([]);
    const res = await del(CAT_ID);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});
```

- [ ] **Step 2: Run them against today's routes**

Run: `pnpm vitest run "app/api/category-builder/custom"`
Expected: PASS. (`GET` goes through `listCustomCategoriesForUser` → `select().from().where().orderBy()`, which `selectList` mocks.)

- [ ] **Step 3: Failing tests — `lib/customCategories/commands.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() } }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/db/client', () => ({ db: mockDb }));

import { createCustomCategory, deleteCustomCategory, updateCustomCategory } from './commands';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CAT_ID = '22222222-2222-4222-8222-222222222222';
const row = { id: CAT_ID, userId: USER_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T10:00:00Z') };
const dto = { id: CAT_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };
const uniqueViolation = () => Object.assign(new Error('dup'), { code: '23505' });

function selectWhere(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}
function insertReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.insert.mockReturnValueOnce({ values: vi.fn().mockReturnValueOnce({ returning }) } as never);
}
function updateReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.update.mockReturnValueOnce({ set: vi.fn().mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning }) }) } as never);
}
function deleteReturning(rows: unknown[]) {
  mockDb.delete.mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('createCustomCategory', () => {
  it('normalises the leaf list (trim, dedupe) and returns the DTO', async () => {
    selectWhere([{ n: 0 }]);
    insertReturning([row]);
    await expect(createCustomCategory(USER_ID, { name: 'Lighting', leafPaths: [' Lighting › Lamps ', 'Lighting › Lamps'] })).resolves.toEqual({ ok: true, category: dto });
    const values = (mockDb.insert.mock.results[0].value as { values: ReturnType<typeof vi.fn> }).values;
    expect(values.mock.calls[0][0]).toEqual({ userId: USER_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'] });
  });
  it('fails closed on a bad name, no leaves, or too many leaves, before any query', async () => {
    await expect(createCustomCategory(USER_ID, { name: 7, leafPaths: ['x'] })).resolves.toEqual({ ok: false, code: 'invalid_name', message: 'name must be a string' });
    await expect(createCustomCategory(USER_ID, { name: 'L', leafPaths: [] })).resolves.toEqual({ ok: false, code: 'no_leaves', message: 'Add at least one leaf category before saving.' });
    await expect(createCustomCategory(USER_ID, { name: 'L', leafPaths: Array.from({ length: 12001 }, (_, i) => `D › ${i}`) })).resolves.toEqual({ ok: false, code: 'too_many_leaves', message: `A category can include at most ${(12000).toLocaleString()} leaves.` });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it('refuses at the cap and reports a duplicate name', async () => {
    selectWhere([{ n: 25 }]);
    await expect(createCustomCategory(USER_ID, { name: 'L', leafPaths: ['x'] })).resolves.toEqual({ ok: false, code: 'cap_reached', message: "You've reached the 25-category limit. Delete one to add another." });
    selectWhere([{ n: 1 }]);
    insertReturning(uniqueViolation());
    await expect(createCustomCategory(USER_ID, { name: 'Lighting', leafPaths: ['x'] })).resolves.toEqual({ ok: false, code: 'duplicate_name', message: 'You already have a category named "Lighting".' });
  });
});

describe('updateCustomCategory', () => {
  it('updates only the fields given and sets updatedAt', async () => {
    updateReturning([row]);
    await expect(updateCustomCategory(USER_ID, CAT_ID, { name: 'Lighting' })).resolves.toEqual({ ok: true, category: dto });
    const set = (mockDb.update.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set;
    expect(set.mock.calls[0][0]).toEqual({ name: 'Lighting', updatedAt: expect.any(Date) });
    updateReturning([row]);
    await updateCustomCategory(USER_ID, CAT_ID, { leafPaths: ['A › B'] });
    const set2 = (mockDb.update.mock.results[1].value as { set: ReturnType<typeof vi.fn> }).set;
    expect(set2.mock.calls[0][0]).toEqual({ leafPaths: ['A › B'], updatedAt: expect.any(Date) });
  });
  it('rejects a malformed id, a bad name, an empty leaf list, and an empty patch without querying', async () => {
    await expect(updateCustomCategory(USER_ID, 'nope', { name: 'x' })).resolves.toEqual({ ok: false, code: 'invalid_id', message: 'invalid category id' });
    await expect(updateCustomCategory(USER_ID, CAT_ID, { name: null })).resolves.toEqual({ ok: false, code: 'invalid_name', message: 'name must be a string' });
    await expect(updateCustomCategory(USER_ID, CAT_ID, { leafPaths: [] })).resolves.toEqual({ ok: false, code: 'no_leaves', message: 'A category needs at least one leaf.' });
    await expect(updateCustomCategory(USER_ID, CAT_ID, {})).resolves.toEqual({ ok: false, code: 'nothing_to_update', message: 'nothing to update' });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
  it('is not_found for a foreign id and duplicate_name on 23505', async () => {
    updateReturning([]);
    await expect(updateCustomCategory(USER_ID, CAT_ID, { name: 'x' })).resolves.toEqual({ ok: false, code: 'not_found', message: 'Not found' });
    updateReturning(uniqueViolation());
    await expect(updateCustomCategory(USER_ID, CAT_ID, { name: 'Taken' })).resolves.toEqual({ ok: false, code: 'duplicate_name', message: 'You already have a category named "Taken".' });
  });
});

describe('deleteCustomCategory', () => {
  it('deletes the caller\'s row and returns id, name and leaf count', async () => {
    deleteReturning([{ id: CAT_ID, name: 'Lighting', leafPaths: ['a', 'b'] }]);
    await expect(deleteCustomCategory(USER_ID, CAT_ID)).resolves.toEqual({ ok: true, deleted: { id: CAT_ID, name: 'Lighting', leafCount: 2 } });
  });
  it('is invalid_id or not_found otherwise', async () => {
    await expect(deleteCustomCategory(USER_ID, 'nope')).resolves.toEqual({ ok: false, code: 'invalid_id', message: 'invalid category id' });
    deleteReturning([]);
    await expect(deleteCustomCategory(USER_ID, CAT_ID)).resolves.toEqual({ ok: false, code: 'not_found', message: 'Not found' });
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm vitest run lib/customCategories/commands.test.ts`
Expected: FAIL — cannot resolve `./commands`.

- [ ] **Step 5: Implement `lib/customCategories/commands.ts` and the loader**

```ts
/**
 * Shared custom-category commands (spec 2026-09-30 §6.2): the API routes and the MCP workspace
 * service both call these. Results, never HTTP responses; every message is the sentence the
 * routes returned before this module existed, verbatim. Leaf modes (replace/add/remove) are
 * resolved by the workspace service before calling `updateCustomCategory` with the full list.
 */
import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';
import { rowToDTO, type CustomCategoryDTO } from './loadServer';
import { MAX_CUSTOM_CATEGORIES, MAX_LEAF_PATHS_PER_CATEGORY, isUniqueViolation, isValidUuid, normalizePaths, validateName } from './validation';

export type CustomCategoryCommandCode =
  | 'invalid_id' | 'invalid_name' | 'no_leaves' | 'too_many_leaves' | 'nothing_to_update' | 'cap_reached' | 'duplicate_name' | 'not_found';
export type CustomCategoryResult<T> = ({ ok: true } & T) | { ok: false; code: CustomCategoryCommandCode; message: string };

const fail = (code: CustomCategoryCommandCode, message: string) => ({ ok: false as const, code, message });
const tooManyLeaves = () => fail('too_many_leaves', `A category can include at most ${MAX_LEAF_PATHS_PER_CATEGORY.toLocaleString()} leaves.`);

export async function createCustomCategory(userId: string, input: { name: unknown; leafPaths: unknown }): Promise<CustomCategoryResult<{ category: CustomCategoryDTO }>> {
  const nameResult = validateName(input.name);
  if (!nameResult.ok) return fail('invalid_name', nameResult.error);
  const leafPaths = normalizePaths(input.leafPaths);
  if (leafPaths.length === 0) return fail('no_leaves', 'Add at least one leaf category before saving.');
  if (leafPaths.length > MAX_LEAF_PATHS_PER_CATEGORY) return tooManyLeaves();
  // Cap. COUNT-then-insert is not atomic (spec §8.7): a soft cap, accepted.
  const [{ n }] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(customCategories).where(eq(customCategories.userId, userId));
  if (n >= MAX_CUSTOM_CATEGORIES) return fail('cap_reached', `You've reached the ${MAX_CUSTOM_CATEGORIES}-category limit. Delete one to add another.`);
  try {
    const [created] = await db.insert(customCategories).values({ userId, name: nameResult.name, leafPaths }).returning();
    return { ok: true, category: rowToDTO(created) };
  } catch (e) {
    if (isUniqueViolation(e)) return fail('duplicate_name', `You already have a category named "${nameResult.name}".`);
    throw e;
  }
}

export async function updateCustomCategory(userId: string, id: string, input: { name?: unknown; leafPaths?: unknown }): Promise<CustomCategoryResult<{ category: CustomCategoryDTO }>> {
  if (!isValidUuid(id)) return fail('invalid_id', 'invalid category id');
  const updates: { name?: string; leafPaths?: string[]; updatedAt: Date } = { updatedAt: new Date() };
  let name: string | undefined;
  if (input.name !== undefined) {
    const nameResult = validateName(input.name);
    if (!nameResult.ok) return fail('invalid_name', nameResult.error);
    name = nameResult.name;
    updates.name = name;
  }
  if (input.leafPaths !== undefined) {
    const leafPaths = normalizePaths(input.leafPaths);
    if (leafPaths.length === 0) return fail('no_leaves', 'A category needs at least one leaf.');
    if (leafPaths.length > MAX_LEAF_PATHS_PER_CATEGORY) return tooManyLeaves();
    updates.leafPaths = leafPaths;
  }
  if (updates.name === undefined && updates.leafPaths === undefined) return fail('nothing_to_update', 'nothing to update');
  try {
    const [updated] = await db.update(customCategories).set(updates).where(and(eq(customCategories.id, id), eq(customCategories.userId, userId))).returning();
    if (!updated) return fail('not_found', 'Not found');
    return { ok: true, category: rowToDTO(updated) };
  } catch (e) {
    if (isUniqueViolation(e)) return fail('duplicate_name', `You already have a category named "${name ?? ''}".`);
    throw e;
  }
}

export async function deleteCustomCategory(userId: string, id: string): Promise<CustomCategoryResult<{ deleted: { id: string; name: string; leafCount: number } }>> {
  if (!isValidUuid(id)) return fail('invalid_id', 'invalid category id');
  const [deleted] = await db
    .delete(customCategories)
    .where(and(eq(customCategories.id, id), eq(customCategories.userId, userId)))
    .returning({ id: customCategories.id, name: customCategories.name, leafPaths: customCategories.leafPaths });
  if (!deleted) return fail('not_found', 'Not found');
  return { ok: true, deleted: { id: deleted.id, name: deleted.name, leafCount: Array.isArray(deleted.leafPaths) ? deleted.leafPaths.length : 0 } };
}
```

Append to `lib/customCategories/loadServer.ts` (add `and` to its drizzle import and `isValidUuid` from `./validation`):

```ts
/** One category by id, scoped to the owner; null when missing, foreign or malformed (never leaks existence). */
export async function loadCustomCategoryForUser(userId: string, id: string): Promise<CustomCategoryDTO | null> {
  if (!isValidUuid(id)) return null;
  const [row] = await db
    .select()
    .from(customCategories)
    .where(and(eq(customCategories.id, id), eq(customCategories.userId, userId)))
    .limit(1);
  return row ? rowToDTO(row) : null;
}
```

- [ ] **Step 6: Run the command tests**

Run: `pnpm vitest run lib/customCategories/commands.test.ts`
Expected: PASS.

- [ ] **Step 7: Make the routes delegate**

`app/api/category-builder/custom/route.ts` — keep `GET`; replace `POST` (drop the `sql`, `customCategories`, `db`, `validateName`, `normalizePaths`, `isUniqueViolation`, `MAX_*` imports; keep `listCustomCategoriesForUser`):

```ts
import { createCustomCategory } from '@/lib/customCategories/commands';

export async function POST(req: Request) {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; leafPaths?: unknown };
  const result = await createCustomCategory(user.id, { name: body.name, leafPaths: body.leafPaths });
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.code === 'duplicate_name' ? 409 : 400 });
  return NextResponse.json({ category: result.category });
}
```

`app/api/category-builder/custom/[id]/route.ts` — replace both handlers. PATCH stays a full replace: a missing name or leaf list is passed as `null` / `[]` so the command answers with the same 400 sentences the route always had.

```ts
import { deleteCustomCategory, updateCustomCategory, type CustomCategoryCommandCode } from '@/lib/customCategories/commands';

const STATUS: Record<CustomCategoryCommandCode, number> = {
  invalid_id: 400, invalid_name: 400, no_leaves: 400, too_many_leaves: 400, nothing_to_update: 400, cap_reached: 400, duplicate_name: 409, not_found: 404,
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; leafPaths?: unknown };
  // Full replace, as always: both fields are required here even though the command accepts a partial.
  const result = await updateCustomCategory(user.id, id, { name: body.name ?? null, leafPaths: body.leafPaths ?? [] });
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: STATUS[result.code] });
  return NextResponse.json({ category: result.category });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  const { id } = await params;
  const result = await deleteCustomCategory(user.id, id);
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: STATUS[result.code] });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 8: Run the route tests, command tests, typecheck, lint**

Run: `pnpm vitest run "app/api/category-builder/custom" lib/customCategories && pnpm typecheck && pnpm lint`
Expected: PASS, clean. (The PATCH "missing name" case now flows through the command: `validateName(null)` → `'name must be a string'`, identical.)

- [ ] **Step 9: Commit**

```bash
git add app/api/category-builder/custom/route.ts app/api/category-builder/custom/route.test.ts "app/api/category-builder/custom/[id]/route.ts" "app/api/category-builder/custom/[id]/route.test.ts" lib/customCategories/commands.ts lib/customCategories/commands.test.ts lib/customCategories/loadServer.ts
git commit -F - <<'MSG'
refactor(custom-categories): shared create/update/delete commands + loadCustomCategoryForUser, routes delegate; route tests pin every status and message (spec 2026-09-30 §6.2, §6.4)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 6: Watchlist commands by text or id

**Files:**
- Create: `lib/watchlist/commands.ts`, `lib/watchlist/commands.test.ts`
- Modify: `lib/watchlist/bulkAdd.ts` (becomes a wrapper), `lib/watchlist/loadServer.ts` (add `listWatchlistWithKeywords`)
- Test (existing, must stay green): `lib/watchlist/bulkAdd.test.ts`

> **Landed as bab2b7d (2026-09-30).** `bulkAdd.test.ts` green unchanged. The wrapper's doc comment carries one extra sentence pointing at the 2026-05-29 bulk-add spec (added by the controller's prompt, not in the block below; accepted). Spec review: compliant. Uppercase ids (`isValidUuid` and `z.uuid()` accept them, Postgres returns lowercase) are handled at the tool schema instead of in this command: Task 7's fix round lowercases `searchTermIds` and every `id` with `z.uuid().toLowerCase()`, and Task 9 does the same for the research `customSelectionSchema`; the paste box only ever passes text. The command stays as written.

- [ ] **Step 1: Failing tests — `lib/watchlist/commands.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDb, mockCount } = vi.hoisted(() => ({
  mockDb: { select: vi.fn(), insert: vi.fn(), delete: vi.fn() },
  mockCount: vi.fn(),
}));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/db/client', () => ({ db: mockDb }));
vi.mock('./loadServer', () => ({ watchlistCountForUser: mockCount }));

import { addToWatchlist, removeFromWatchlist } from './commands';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const KW = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Next `db.select(...).from(...).where(...)` resolves to `rows`. Order matters: text match, then id check, then existing rows. */
function selectWhere(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}
function insertReturns(ids: string[]) {
  mockDb.insert.mockReturnValueOnce({ values: vi.fn().mockReturnValueOnce({ onConflictDoNothing: vi.fn().mockReturnValueOnce({ returning: vi.fn().mockResolvedValueOnce(ids.map((k) => ({ k }))) }) }) } as never);
}
function deleteReturns(ids: string[]) {
  mockDb.delete.mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning: vi.fn().mockResolvedValueOnce(ids.map((k) => ({ k }))) }) } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('addToWatchlist', () => {
  it('matches text and ids, dedupes across both, reports unmatched in the caller\'s words, and inserts what fits', async () => {
    selectWhere([{ id: KW(1), normalized: 'desk lamp' }]);                 // text match: 'desk lamp' found, 'no such thing' not
    selectWhere([{ id: KW(1) }, { id: KW(2) }]);                           // id check: KW(1) (again), KW(2) found; KW(9) not
    selectWhere([{ keywordId: KW(2) }]);                                   // already watching KW(2)
    mockCount.mockResolvedValueOnce(99);                                   // room for one
    insertReturns([KW(1)]);
    const r = await addToWatchlist(USER_ID, { keywords: ['Desk Lamp', 'no such thing'], searchTermIds: [KW(1), KW(2), KW(9)] });
    expect(r).toEqual({ added: 1, alreadyWatching: 1, unmatched: ['no such thing', KW(9)], skippedAtCap: 0 });
  });
  it('skips at the cap in input order and reports the rest', async () => {
    selectWhere([{ id: KW(1), normalized: 'a' }, { id: KW(2), normalized: 'b' }, { id: KW(3), normalized: 'c' }]);
    selectWhere([]);                                                       // none already watching
    mockCount.mockResolvedValueOnce(98);                                   // room for two
    insertReturns([KW(1), KW(2)]);
    const r = await addToWatchlist(USER_ID, { keywords: ['a', 'b', 'c'], searchTermIds: [] });
    expect(r).toEqual({ added: 2, alreadyWatching: 0, unmatched: [], skippedAtCap: 1 });
  });
  it('makes no database call when nothing usable was passed, and reports a malformed id as unmatched', async () => {
    await expect(addToWatchlist(USER_ID, { keywords: ['  '], searchTermIds: ['not-a-uuid'] })).resolves.toEqual({ added: 0, alreadyWatching: 0, unmatched: ['not-a-uuid'], skippedAtCap: 0 });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('removeFromWatchlist', () => {
  it('deletes the matched rows the caller owns and counts the rest as not watching', async () => {
    selectWhere([{ id: KW(1), normalized: 'desk lamp' }]);
    selectWhere([{ id: KW(2) }]);
    deleteReturns([KW(1)]);
    const r = await removeFromWatchlist(USER_ID, { keywords: ['desk lamp', 'ghost'], searchTermIds: [KW(2)] });
    expect(r).toEqual({ removed: 1, notWatching: 1, unmatched: ['ghost'] });
  });
  it('is a no-op without a match', async () => {
    selectWhere([]);
    await expect(removeFromWatchlist(USER_ID, { keywords: ['ghost'], searchTermIds: [] })).resolves.toEqual({ removed: 0, notWatching: 0, unmatched: ['ghost'] });
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/watchlist/commands.test.ts`
Expected: FAIL — cannot resolve `./commands`.

- [ ] **Step 3: Implement `lib/watchlist/commands.ts`**

```ts
/**
 * Shared watchlist commands (spec 2026-09-30 §6.3), by keyword text and/or search-term id.
 * The paste box's `bulkAddToWatchlist` (./bulkAdd.ts) is now a wrapper over `addToWatchlist`.
 * Neither command fails on user input: unmatched text and unknown ids come back verbatim in
 * `unmatched`, the cap is best-effort in input order, removal is owner-scoped and idempotent.
 */
import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { searchTerms, watchlistItems } from '@/db/schema';
import { normalizeForMatch } from '@/lib/analytics/derivedFields';
import { MAX_WATCHED_KEYWORDS, isValidUuid } from './validation';
import { watchlistCountForUser } from './loadServer';

export interface WatchlistSelection {
  keywords: string[];
  searchTermIds: string[];
}
export interface AddToWatchlistResult {
  added: number;
  alreadyWatching: number;
  /** Text that matched no keyword, and ids that exist nowhere, in the caller's own spelling and order. */
  unmatched: string[];
  skippedAtCap: number;
}
export interface RemoveFromWatchlistResult {
  removed: number;
  notWatching: number;
  unmatched: string[];
}

/** Text → ids via the normalized index (one lookup), ids → existence check (one lookup); distinct, input order, text first. */
async function resolveSelection(sel: WatchlistSelection): Promise<{ ids: string[]; unmatched: string[] }> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const unmatched: string[] = [];
  const inputOrder: string[] = [];
  const displayByNormalized = new Map<string, string>();
  for (const raw of sel.keywords) {
    const normalized = normalizeForMatch(raw);
    if (!normalized) continue; // whitespace-only
    if (!displayByNormalized.has(normalized)) {
      displayByNormalized.set(normalized, raw.trim());
      inputOrder.push(normalized);
    }
  }
  if (inputOrder.length > 0) {
    const rows = await db
      .select({ id: searchTerms.id, normalized: searchTerms.searchTermNormalized })
      .from(searchTerms)
      .where(inArray(searchTerms.searchTermNormalized, inputOrder));
    const idByNormalized = new Map(rows.map((r) => [r.normalized, r.id]));
    for (const normalized of inputOrder) {
      const id = idByNormalized.get(normalized);
      if (!id) unmatched.push(displayByNormalized.get(normalized) ?? normalized);
      else if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
  }
  const wanted: string[] = [];
  for (const raw of sel.searchTermIds) {
    if (!isValidUuid(raw)) unmatched.push(raw);
    else if (!wanted.includes(raw)) wanted.push(raw);
  }
  if (wanted.length > 0) {
    const rows = await db.select({ id: searchTerms.id }).from(searchTerms).where(inArray(searchTerms.id, wanted));
    const found = new Set(rows.map((r) => r.id));
    for (const id of wanted) {
      if (!found.has(id)) unmatched.push(id);
      else if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
  }
  return { ids, unmatched };
}

export async function addToWatchlist(userId: string, sel: WatchlistSelection): Promise<AddToWatchlistResult> {
  const { ids, unmatched } = await resolveSelection(sel);
  if (ids.length === 0) return { added: 0, alreadyWatching: 0, unmatched, skippedAtCap: 0 };
  const existing = await db
    .select({ keywordId: watchlistItems.keywordId })
    .from(watchlistItems)
    .where(and(eq(watchlistItems.userId, userId), inArray(watchlistItems.keywordId, ids)));
  const already = new Set(existing.map((r) => r.keywordId));
  let toInsert = ids.filter((id) => !already.has(id));
  const alreadyWatching = ids.length - toInsert.length;
  let skippedAtCap = 0;
  if (toInsert.length > 0) {
    // Best-effort cap: insert what fits in input order, report the rest (spec §8.7 accepts the race).
    const remaining = Math.max(0, MAX_WATCHED_KEYWORDS - (await watchlistCountForUser(userId)));
    if (toInsert.length > remaining) {
      skippedAtCap = toInsert.length - remaining;
      toInsert = toInsert.slice(0, remaining);
    }
  }
  let added = 0;
  if (toInsert.length > 0) {
    const inserted = await db
      .insert(watchlistItems)
      .values(toInsert.map((keywordId) => ({ userId, keywordId })))
      .onConflictDoNothing()
      .returning({ k: watchlistItems.keywordId });
    added = inserted.length;
  }
  return { added, alreadyWatching, unmatched, skippedAtCap };
}

export async function removeFromWatchlist(userId: string, sel: WatchlistSelection): Promise<RemoveFromWatchlistResult> {
  const { ids, unmatched } = await resolveSelection(sel);
  if (ids.length === 0) return { removed: 0, notWatching: 0, unmatched };
  const deleted = await db
    .delete(watchlistItems)
    .where(and(eq(watchlistItems.userId, userId), inArray(watchlistItems.keywordId, ids)))
    .returning({ k: watchlistItems.keywordId });
  return { removed: deleted.length, notWatching: ids.length - deleted.length, unmatched };
}
```

- [ ] **Step 4: Turn `bulkAddToWatchlist` into a wrapper**

Replace the whole of `lib/watchlist/bulkAdd.ts` below its imports with (keep `import 'server-only'`; drop the drizzle/db/schema/normalizeForMatch/loadServer imports; import `HARD_MAX_INPUT` from `./validation` and `addToWatchlist, type AddToWatchlistResult` from `./commands`):

```ts
/** Kept for the paste-box route and its tests; identical to AddToWatchlistResult. */
export type BulkAddResult = AddToWatchlistResult;

/**
 * Thrown when the helper rejects input before any DB work. The route
 * catches this and translates to 400.
 */
export class BulkAddInputError extends Error {
  constructor(public readonly code: 'too_many_keywords', message: string) {
    super(message);
    this.name = 'BulkAddInputError';
  }
}

/**
 * Add a paste-list of keywords to the user's watchlist in one shot — a wrapper over
 * lib/watchlist/commands.ts's addToWatchlist since arc 3 (spec 2026-09-30 §6.3). Same
 * contract as before: idempotent, best-effort cap in input order, unmatched in the user's
 * first spelling, and at most HARD_MAX_INPUT inputs.
 */
export async function bulkAddToWatchlist(userId: string, inputKeywords: string[]): Promise<BulkAddResult> {
  if (inputKeywords.length > HARD_MAX_INPUT) {
    throw new BulkAddInputError('too_many_keywords', `at most ${HARD_MAX_INPUT} keywords allowed (got ${inputKeywords.length})`);
  }
  return addToWatchlist(userId, { keywords: inputKeywords, searchTermIds: [] });
}
```

Append to `lib/watchlist/loadServer.ts` (add `searchTerms` to its schema import):

```ts
export interface WatchlistItemWithKeyword {
  keywordId: string;
  keyword: string;
  addedAt: string;
}

/** The watchlist with each keyword's text, newest first — what the MCP `list_watchlist` tool returns (spec 2026-09-30 §3). */
export async function listWatchlistWithKeywords(userId: string): Promise<WatchlistItemWithKeyword[]> {
  const rows = await db
    .select({ keywordId: watchlistItems.keywordId, keyword: searchTerms.searchTermRaw, addedAt: watchlistItems.addedAt })
    .from(watchlistItems)
    .innerJoin(searchTerms, eq(searchTerms.id, watchlistItems.keywordId))
    .where(eq(watchlistItems.userId, userId))
    .orderBy(desc(watchlistItems.addedAt));
  return rows.map((r) => ({ keywordId: r.keywordId, keyword: r.keyword, addedAt: r.addedAt.toISOString() }));
}
```

- [ ] **Step 5: Run the new and the existing tests, typecheck, lint**

Run: `pnpm vitest run lib/watchlist && pnpm typecheck && pnpm lint`
Expected: PASS — `bulkAdd.test.ts` unchanged and green (same select/insert order for text-only input, same early returns, same `BulkAddInputError`).

- [ ] **Step 6: Commit**

```bash
git add lib/watchlist/commands.ts lib/watchlist/commands.test.ts lib/watchlist/bulkAdd.ts lib/watchlist/loadServer.ts
git commit -F - <<'MSG'
feat(watchlist): add/remove commands by keyword text or id; bulkAddToWatchlist becomes a wrapper; listWatchlistWithKeywords (spec 2026-09-30 §6.3)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 7: Workspace contracts and the eleven tool definitions

**Files:**
- Create: `lib/workspace/contracts.ts`, `lib/workspace/tools.ts`
- Test: `lib/workspace/tools.test.ts`
- Modify (review amendment from Task 2): `lib/research/tools.test.ts` — the same strictness loop over `RESEARCH_TOOLS`

> **Landed as 2f1f863 (2026-09-30).** `searchSpecSchema` via `.omit(...).shape` kept every field description; refined schemas type-check as `inputSchema` without casts. Implementer heads-ups for Task 8: `search.schemaVersion` is optional, so the service fills `1` before `parseSearchInput`; `run()` receives the SDK's parsed output with defaults (`leafMode: 'replace'`, `keywords: []`, `searchTermIds: []`) filled in. Spec review: compliant (an unused `WORKSPACE_TOOL_NAMES` import rightly dropped from tools.ts). Code-quality review (approve with fixes) → fix round 83d6f88: the two update tools carry `DESTRUCTIVE_ANNOTATIONS` (MCP defines `destructiveHint: false` as additive-only; `UPDATE_ANNOTATIONS` became `ADDITIVE_ANNOTATIONS`, used by `add_to_watchlist` only); ids and `searchTermIds` are lowercased with `z.uuid().toLowerCase()`; descriptions reworded (the delete-category consequence for saved views, what `leafMode` does, the returns, and "Clients normally ask the person before this runs."); annotation literals pinned; `Deleted*Response` renamed `Delete*Response`; `emptyInputSchema` re-exported from the research contracts; comment fixes. Deferred: `PREVIEW_LEAF_PATHS` (20) duplicates research's private `PREVIEW_PATHS` (20) — pin or share in a later nits pass. The code blocks below are the pre-fix text.

- [ ] **Step 1: Failing tests — `lib/workspace/tools.test.ts`**

```ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/env', () => ({ env: {} }));
import { DEFAULT_LIMITS } from '@/lib/research/limits';
import { READ_ONLY_ANNOTATIONS } from '@/lib/research/tools';
import type { ResearchActor } from '@/lib/research/service';
import {
  createCustomCategoryInputSchema, createSavedViewInputSchema, updateCustomCategoryInputSchema, updateSavedViewInputSchema,
  watchlistSelectionInputSchema, WORKSPACE_TOOL_NAMES, type WorkspaceService,
} from './contracts';
import { CREATE_ANNOTATIONS, DESTRUCTIVE_ANNOTATIONS, UPDATE_ANNOTATIONS, WORKSPACE_TOOLS, workspaceToolByName } from './tools';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'client_claude', channel: 'mcp' };
const ID = '11111111-1111-4111-8111-111111111111';

describe('WORKSPACE_TOOLS', () => {
  it('lists the eleven tools in order: three read-only lists, then the eight writes that need confirmation', () => {
    expect(WORKSPACE_TOOL_NAMES).toEqual([
      'list_saved_views', 'list_custom_categories', 'list_watchlist',
      'create_saved_view', 'update_saved_view', 'delete_saved_view',
      'create_custom_category', 'update_custom_category', 'delete_custom_category',
      'add_to_watchlist', 'remove_from_watchlist',
    ]);
    expect(WORKSPACE_TOOLS.map((t) => t.name)).toEqual([...WORKSPACE_TOOL_NAMES]);
    expect(Object.isFrozen(WORKSPACE_TOOLS)).toBe(true);
    for (const t of WORKSPACE_TOOLS) {
      expect(Object.isFrozen(t)).toBe(true);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.description(DEFAULT_LIMITS).length).toBeGreaterThan(40);
      expect(t.annotations.openWorldHint).toBe(false);
      expect(t.requiresConfirmation).toBe(!t.annotations.readOnlyHint);
    }
  });
  it('annotates per spec §3: lists read-only, creates non-idempotent, updates and adds idempotent, deletes and removes destructive', () => {
    for (const n of ['list_saved_views', 'list_custom_categories', 'list_watchlist'] as const) expect(workspaceToolByName(n).annotations).toEqual(READ_ONLY_ANNOTATIONS);
    for (const n of ['create_saved_view', 'create_custom_category'] as const) expect(workspaceToolByName(n).annotations).toEqual(CREATE_ANNOTATIONS);
    for (const n of ['update_saved_view', 'update_custom_category', 'add_to_watchlist'] as const) expect(workspaceToolByName(n).annotations).toEqual(UPDATE_ANNOTATIONS);
    for (const n of ['delete_saved_view', 'delete_custom_category', 'remove_from_watchlist'] as const) expect(workspaceToolByName(n).annotations).toEqual(DESTRUCTIVE_ANNOTATIONS);
    expect(DESTRUCTIVE_ANNOTATIONS).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect(workspaceToolByName('delete_saved_view').description(DEFAULT_LIMITS)).toContain('permanently');
    expect(workspaceToolByName('remove_from_watchlist').description(DEFAULT_LIMITS)).toContain('Not permanent');
  });
  it('run() dispatches to the matching service method with the actor and raw args', async () => {
    const service = Object.fromEntries(WORKSPACE_TOOL_NAMES.map((n) => [camel(n), vi.fn(async () => ({ tool: n }))])) as unknown as WorkspaceService;
    for (const n of WORKSPACE_TOOL_NAMES) {
      await expect(workspaceToolByName(n).run(service, actor, { any: 1 })).resolves.toEqual({ tool: n });
      expect((service as unknown as Record<string, ReturnType<typeof vi.fn>>)[camel(n)]).toHaveBeenCalledWith(actor, { any: 1 });
    }
  });
});

/** list_saved_views → listSavedViews, add_to_watchlist → addToWatchlist. */
function camel(n: string): string {
  return n.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

describe('input schemas', () => {
  it('a saved view takes the search criteria, never a cursor, and a name of 1–80 characters', () => {
    expect(createSavedViewInputSchema.safeParse({ name: 'Lamps', search: { schemaVersion: 1, filters: { text: { value: 'lamp' } } } }).success).toBe(true);
    expect(createSavedViewInputSchema.safeParse({ name: 'Lamps', search: { cursor: 'c'.repeat(20) } }).success).toBe(false);
    expect(createSavedViewInputSchema.safeParse({ name: 'Lamps', search: { pageSize: 10 } }).success).toBe(false);
    expect(createSavedViewInputSchema.safeParse({ name: '', search: {} }).success).toBe(false);
    expect(createSavedViewInputSchema.safeParse({ name: 'x'.repeat(81), search: {} }).success).toBe(false);
    expect(createSavedViewInputSchema.safeParse({ name: 'Lamps', search: {}, extra: 1 }).success).toBe(false);
  });
  it('an update needs a name, a search/categories object, or both', () => {
    expect(updateSavedViewInputSchema.safeParse({ id: ID }).success).toBe(false);
    expect(updateSavedViewInputSchema.safeParse({ id: ID, name: 'New' }).success).toBe(true);
    expect(updateSavedViewInputSchema.safeParse({ id: 'nope', name: 'New' }).success).toBe(false);
    expect(updateCustomCategoryInputSchema.safeParse({ id: ID }).success).toBe(false);
    const parsed = updateCustomCategoryInputSchema.safeParse({ id: ID, categories: { leafPaths: ['A › B'] } });
    expect(parsed.success && parsed.data.leafMode).toBe('replace');
    expect(updateCustomCategoryInputSchema.safeParse({ id: ID, categories: { leafPaths: ['A › B'] }, leafMode: 'merge' }).success).toBe(false);
  });
  it('a custom category needs at least one selection or leaf path', () => {
    expect(createCustomCategoryInputSchema.safeParse({ name: 'L', categories: {} }).success).toBe(false);
    expect(createCustomCategoryInputSchema.safeParse({ name: 'L', categories: { selections: [{ kind: 'taxonomy', path: 'Lighting' }] } }).success).toBe(true);
    expect(createCustomCategoryInputSchema.safeParse({ name: 'L', categories: { selections: [{ kind: 'custom', id: ID }] } }).success).toBe(true);
  });
  it('a watchlist call takes 1–100 items across keywords and ids', () => {
    expect(watchlistSelectionInputSchema.safeParse({}).success).toBe(false);
    expect(watchlistSelectionInputSchema.safeParse({ keywords: ['desk lamp'] }).success).toBe(true);
    expect(watchlistSelectionInputSchema.safeParse({ searchTermIds: [ID] }).success).toBe(true);
    expect(watchlistSelectionInputSchema.safeParse({ searchTermIds: ['nope'] }).success).toBe(false);
    expect(watchlistSelectionInputSchema.safeParse({ keywords: Array.from({ length: 60 }, (_, i) => `k${i}`), searchTermIds: Array.from({ length: 41 }, () => ID) }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/workspace/tools.test.ts`
Expected: FAIL — cannot resolve `./contracts` / `./tools`.

- [ ] **Step 3: Create `lib/workspace/contracts.ts`**

```ts
/**
 * Input schemas, response types and the service interface for the eleven workspace tools
 * (spec 2026-09-30 §3). Every input is a `z.strictObject` so a hallucinated key is rejected by
 * the MCP SDK before the tool runs. Types only for the service interface: lib/workspace/tools.ts
 * and lib/workspace/service.ts both depend on this module, never on each other's runtime.
 */
import { z } from 'zod';
import type { ExplorerFilters } from '@/lib/explorer/types';
import { categoriesSchema, searchToolInputSchema } from '@/lib/research/contracts';
import type { ResearchActor } from '@/lib/research/service';
import { MAX_NAME_LENGTH } from '@/lib/savedViews/validation';

export const WORKSPACE_TOOL_NAMES = [
  'list_saved_views',
  'list_custom_categories',
  'list_watchlist',
  'create_saved_view',
  'update_saved_view',
  'delete_saved_view',
  'create_custom_category',
  'update_custom_category',
  'delete_custom_category',
  'add_to_watchlist',
  'remove_from_watchlist',
] as const;
export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export const MAX_WATCHLIST_ITEMS_PER_CALL = 100;
/** How many stored leaf paths a category summary shows (same count as search's previewPaths). */
export const PREVIEW_LEAF_PATHS = 20;
export const LEAF_MODES = ['replace', 'add', 'remove'] as const;
export type LeafMode = (typeof LEAF_MODES)[number];

const nameSchema = z
  .string()
  .trim()
  .min(1, 'name cannot be empty')
  .max(MAX_NAME_LENGTH, `name cannot exceed ${MAX_NAME_LENGTH} characters`)
  .describe(`Up to ${MAX_NAME_LENGTH} characters, unique among this account's items. On DUPLICATE_NAME ask the person for another name; never invent one.`);
const idSchema = z.uuid().describe('The id from a list tool or a create result.');

/** search_keywords' input minus cursor and pageSize — what the AI searched with. A fresh strict object, so a `cursor` key is rejected. */
export const searchSpecSchema = z
  .strictObject(searchToolInputSchema.omit({ cursor: true, pageSize: true }).shape)
  .describe('The exact criteria you searched with: presetIds, filters, sort, comparisonWindow. Never a cursor.');
export type SearchSpec = z.infer<typeof searchSpecSchema>;

const categoriesInputSchema = categoriesSchema
  .refine((c) => c.selections.length > 0 || c.leafPaths.length > 0, { message: 'pass at least one selection or leaf path' })
  .describe('Selections from resolve_categories (taxonomy paths with or without descendants, custom category ids) and/or exact leaf paths; the server expands them to leaves.');

export const emptyInputSchema = z.strictObject({});
export const createSavedViewInputSchema = z.strictObject({ name: nameSchema, search: searchSpecSchema });
export const updateSavedViewInputSchema = z
  .strictObject({ id: idSchema, name: nameSchema.optional(), search: searchSpecSchema.optional() })
  .refine((v) => v.name !== undefined || v.search !== undefined, { message: 'pass a new name, a new search, or both' });
export const deleteSavedViewInputSchema = z.strictObject({ id: idSchema });
export const createCustomCategoryInputSchema = z.strictObject({ name: nameSchema, categories: categoriesInputSchema });
export const updateCustomCategoryInputSchema = z
  .strictObject({
    id: idSchema,
    name: nameSchema.optional(),
    categories: categoriesInputSchema.optional(),
    leafMode: z.enum(LEAF_MODES).default('replace').describe('replace = the category becomes exactly these leaves; add = union with the stored leaves; remove = subtract them.'),
  })
  .refine((v) => v.name !== undefined || v.categories !== undefined, { message: 'pass a new name, categories, or both' });
export const deleteCustomCategoryInputSchema = z.strictObject({ id: idSchema });
const keywordText = z.string().trim().min(1).max(512);
export const watchlistSelectionInputSchema = z
  .strictObject({
    keywords: z.array(keywordText).max(MAX_WATCHLIST_ITEMS_PER_CALL).default([]).describe('Keyword text, matched exactly like the Watchlist page paste box.'),
    searchTermIds: z.array(z.uuid()).max(MAX_WATCHLIST_ITEMS_PER_CALL).default([]).describe('searchTermId values from search rows.'),
  })
  .refine((v) => v.keywords.length + v.searchTermIds.length >= 1, { message: 'pass at least one keyword or searchTermId' })
  .refine((v) => v.keywords.length + v.searchTermIds.length <= MAX_WATCHLIST_ITEMS_PER_CALL, { message: `at most ${MAX_WATCHLIST_ITEMS_PER_CALL} items per call` });

// ---- responses (§3) ----
export interface SavedViewSummary {
  id: string;
  name: string;
  explorerUrl: string;
  /** The stored Explorer filters with defaults stripped (§5.5); {} is the default Explorer. */
  filters: Partial<ExplorerFilters>;
  createdAt: string;
  updatedAt: string;
}
export interface ListSavedViewsResponse { views: SavedViewSummary[]; count: number; limit: number }
export interface SavedViewWriteResponse { view: SavedViewSummary; notes: string[] }
export interface DeleteSavedViewResponse { deleted: { id: string; name: string } }

export interface CustomCategorySummary {
  id: string;
  name: string;
  leafCount: number;
  previewPaths: string[];
  previewComplete: boolean;
  explorerUrl: string;
  createdAt: string;
  updatedAt: string;
}
export interface ListCustomCategoriesResponse { categories: CustomCategorySummary[]; count: number; limit: number }
export interface CustomCategoryWriteResponse { category: CustomCategorySummary; notes: string[] }
export interface DeleteCustomCategoryResponse { deleted: { id: string; name: string; leafCount: number } }

export interface WatchlistEntry { searchTermId: string; keyword: string; keywordUrl: string; addedAt: string }
export interface ListWatchlistResponse { items: WatchlistEntry[]; count: number; limit: number }
export interface AddToWatchlistResponse { added: number; alreadyWatching: number; unmatched: string[]; skippedAtCap: number; watching: number; limit: number }
export interface RemoveFromWatchlistResponse { removed: number; notWatching: number; unmatched: string[]; watching: number; limit: number }

/** One method per tool; every method validates its own `input` (an `unknown` from the wire) and rejects with a ResearchError. */
export interface WorkspaceService {
  listSavedViews(actor: ResearchActor, input: unknown): Promise<ListSavedViewsResponse>;
  listCustomCategories(actor: ResearchActor, input: unknown): Promise<ListCustomCategoriesResponse>;
  listWatchlist(actor: ResearchActor, input: unknown): Promise<ListWatchlistResponse>;
  createSavedView(actor: ResearchActor, input: unknown): Promise<SavedViewWriteResponse>;
  updateSavedView(actor: ResearchActor, input: unknown): Promise<SavedViewWriteResponse>;
  deleteSavedView(actor: ResearchActor, input: unknown): Promise<DeleteSavedViewResponse>;
  createCustomCategory(actor: ResearchActor, input: unknown): Promise<CustomCategoryWriteResponse>;
  updateCustomCategory(actor: ResearchActor, input: unknown): Promise<CustomCategoryWriteResponse>;
  deleteCustomCategory(actor: ResearchActor, input: unknown): Promise<DeleteCustomCategoryResponse>;
  addToWatchlist(actor: ResearchActor, input: unknown): Promise<AddToWatchlistResponse>;
  removeFromWatchlist(actor: ResearchActor, input: unknown): Promise<RemoveFromWatchlistResponse>;
}
```

- [ ] **Step 4: Create `lib/workspace/tools.ts`**

```ts
/**
 * The eleven workspace tools (spec 2026-09-30 §3), the same frozen-definition shape as
 * lib/research/tools.ts. Registered on the MCP server only while MCP_WRITE_ENABLED is "1"
 * (lib/mcp/handler.ts); never handed to Ask AI (lib/ask/tools.ts builds from RESEARCH_TOOLS).
 * Descriptions are what Claude and ChatGPT show in their approval prompt, so they stay plain.
 */
import { MAX_CUSTOM_CATEGORIES, MAX_LEAF_PATHS_PER_CATEGORY } from '@/lib/customCategories/validation';
import { READ_ONLY_ANNOTATIONS, type ToolDefinition } from '@/lib/research/tools';
import { MAX_VIEWS_PER_USER } from '@/lib/savedViews/validation';
import { MAX_WATCHED_KEYWORDS } from '@/lib/watchlist/validation';
import {
  createCustomCategoryInputSchema, createSavedViewInputSchema, deleteCustomCategoryInputSchema, deleteSavedViewInputSchema, emptyInputSchema,
  MAX_WATCHLIST_ITEMS_PER_CALL, PREVIEW_LEAF_PATHS, updateCustomCategoryInputSchema, updateSavedViewInputSchema, watchlistSelectionInputSchema,
  WORKSPACE_TOOL_NAMES, type WorkspaceService, type WorkspaceToolName,
} from './contracts';

export type WorkspaceToolDefinition = ToolDefinition<WorkspaceService, WorkspaceToolName>;

/** A create is not idempotent: calling it twice makes two items (or a DUPLICATE_NAME). */
export const CREATE_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const);
/** Updates and watchlist adds converge: repeating them changes nothing more. */
export const UPDATE_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const);
/** Deletes and removals: clients flag these as destructive in their prompts. */
export const DESTRUCTIVE_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const);

const ASKS = 'The client asks the person before this runs.';

function frozenTool(def: WorkspaceToolDefinition): WorkspaceToolDefinition {
  return Object.freeze(def);
}

export const WORKSPACE_TOOLS: ReadonlyArray<WorkspaceToolDefinition> = Object.freeze([
  frozenTool({
    name: 'list_saved_views',
    title: 'List saved views',
    description: () => `This account's saved Explorer views (up to ${MAX_VIEWS_PER_USER}): id, name, Explorer link and the stored filters in compact form. Use the id for update_saved_view and delete_saved_view.`,
    inputSchema: emptyInputSchema,
    run: (service, actor, args) => service.listSavedViews(actor, args),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
  }),
  frozenTool({
    name: 'list_custom_categories',
    title: 'List custom categories',
    description: () => `This account's custom categories (up to ${MAX_CUSTOM_CATEGORIES}): id, name, leaf count, the first ${PREVIEW_LEAF_PATHS} leaf paths and an Explorer link. Use the id for update_custom_category, delete_custom_category, or as a custom selection in search_keywords.`,
    inputSchema: emptyInputSchema,
    run: (service, actor, args) => service.listCustomCategories(actor, args),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
  }),
  frozenTool({
    name: 'list_watchlist',
    title: 'List watchlist',
    description: () => `The keywords this account watches (up to ${MAX_WATCHED_KEYWORDS}), newest first, with their ids, links and the date added. The weekly digest email reports movement on them.`,
    inputSchema: emptyInputSchema,
    run: (service, actor, args) => service.listWatchlist(actor, args),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
  }),
  frozenTool({
    name: 'create_saved_view',
    title: 'Create saved view',
    description: () => `Saves the exact criteria you searched with as a named Explorer view: pass the same presetIds, filters, sort and comparisonWindow (never a cursor). Returns the view with its link, and notes for anything the Explorer could not carry over; relay the notes to the person. ${ASKS}`,
    inputSchema: createSavedViewInputSchema,
    run: (service, actor, args) => service.createSavedView(actor, args),
    annotations: CREATE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'update_saved_view',
    title: 'Update saved view',
    description: () => `Renames a saved view and/or replaces its filters with a new search (no merge). Takes the id from list_saved_views. Returns the view with its link and notes. ${ASKS}`,
    inputSchema: updateSavedViewInputSchema,
    run: (service, actor, args) => service.updateSavedView(actor, args),
    annotations: UPDATE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'delete_saved_view',
    title: 'Delete saved view',
    description: () => `Deletes one saved view by id, permanently. Confirm the view's name with the person first; list_saved_views has the ids. ${ASKS}`,
    inputSchema: deleteSavedViewInputSchema,
    run: (service, actor, args) => service.deleteSavedView(actor, args),
    annotations: DESTRUCTIVE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'create_custom_category',
    title: 'Create custom category',
    description: () => `Creates a custom category from category selections (from resolve_categories) and/or exact leaf paths; the server expands selections to their leaves, up to ${MAX_LEAF_PATHS_PER_CATEGORY.toLocaleString('en-US')}. Returns id, leaf count, preview paths and an Explorer link. ${ASKS}`,
    inputSchema: createCustomCategoryInputSchema,
    run: (service, actor, args) => service.createCustomCategory(actor, args),
    annotations: CREATE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'update_custom_category',
    title: 'Update custom category',
    description: () => `Renames a custom category and/or changes its leaves with leafMode replace (default), add or remove, using the same categories object create_custom_category takes. Takes the id from list_custom_categories. ${ASKS}`,
    inputSchema: updateCustomCategoryInputSchema,
    run: (service, actor, args) => service.updateCustomCategory(actor, args),
    annotations: UPDATE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'delete_custom_category',
    title: 'Delete custom category',
    description: () => `Deletes one custom category by id, permanently; a saved view that referenced it simply stops matching it. Confirm the category's name with the person first. ${ASKS}`,
    inputSchema: deleteCustomCategoryInputSchema,
    run: (service, actor, args) => service.deleteCustomCategory(actor, args),
    annotations: DESTRUCTIVE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'add_to_watchlist',
    title: 'Add to watchlist',
    description: () => `Adds up to ${MAX_WATCHLIST_ITEMS_PER_CALL} keywords, by text and/or searchTermId from search rows, to the watchlist (cap ${MAX_WATCHED_KEYWORDS}). Reports added, already watching, unmatched, and skipped at the cap. Re-adding is harmless. ${ASKS}`,
    inputSchema: watchlistSelectionInputSchema,
    run: (service, actor, args) => service.addToWatchlist(actor, args),
    annotations: UPDATE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'remove_from_watchlist',
    title: 'Remove from watchlist',
    description: () => `Removes up to ${MAX_WATCHLIST_ITEMS_PER_CALL} keywords, by text and/or searchTermId, from the watchlist. Not permanent: a removed keyword can be added again. Reports removed, not watching, and unmatched. ${ASKS}`,
    inputSchema: watchlistSelectionInputSchema,
    run: (service, actor, args) => service.removeFromWatchlist(actor, args),
    annotations: DESTRUCTIVE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
]);

export function workspaceToolByName(name: WorkspaceToolName): WorkspaceToolDefinition {
  const t = WORKSPACE_TOOLS.find((d) => d.name === name);
  if (!t) throw new Error(`unknown workspace tool ${name}`);
  return t;
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm vitest run lib/workspace/tools.test.ts && pnpm typecheck`
Expected: PASS. If zod's `.omit(...).shape` loses a field description or `.strictObject` rejects the shape's type, fall back to building `searchSpecSchema` as `z.strictObject({ schemaVersion: shape.schemaVersion, presetIds: shape.presetIds, filters: shape.filters, sort: shape.sort, comparisonWindow: shape.comparisonWindow })` where `shape = searchToolInputSchema.shape`; the `cursor`-rejection test stays the arbiter.

- [ ] **Step 6: Commit**

```bash
git add lib/workspace/contracts.ts lib/workspace/tools.ts lib/workspace/tools.test.ts
git commit -F - <<'MSG'
feat(workspace): input schemas, response types, WorkspaceService interface and the eleven tool definitions (spec 2026-09-30 §3)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 8: The workspace service

**Files:**
- Create: `lib/workspace/service.ts`
- Test: `lib/workspace/service.test.ts`

> **Landed as 2073e14 (2026-09-30).** `service.ts` is byte-identical to Step 3 as amended by the reviews (errFields-only failure log, remove mode subtracting explicit paths verbatim, `Delete*Response` names). One typing fix in the test, now reflected below: `ReturnType<typeof vi.spyOn>` resolves to `any` under vitest 4.1.4 and made three callback parameters implicitly `any` under `pnpm typecheck`, so the spy is typed `MockInstance<typeof console.log>`. 15 tests; `lib/workspace` 3 files / 46 tests. Spec review: compliant (four notes, all folded into the fix round or the spec: §7's leaf-cap row, the unreachable cursor guard, §11.5 test gaps, the watchlist count read). Code-quality review (approve with fixes) → fix round 12496ad, re-reviewed and approved: `logged()` never rethrows the raw error (ResearchErrors pass through; anything else is logged with `errFields` and replaced by `poolBusyError()` or a fresh `DATA_UNAVAILABLE` carrying `SAFE_TOOL_FAILURE`'s sentence and no `cause` — the shared classifier would otherwise log a DrizzleQueryError's message and stack, i.e. the bound params); `SavedViewSummary` gains `leafCount` and `previewComplete` and `filters.leafPaths` is previewed to the first 20 (spec §3, §5.5); `recorded()` runs before the trailing watchlist count read; `INFRA_CODES` (`DATA_UNAVAILABLE`, `QUERY_TIMEOUT`) log as `failed`; `toResearchError` is exhaustive with a `never` guard; the leaf-mode block is the exported pure `applyLeafMode`; new tests: reserve-rejects, `invocationCallOrder`, a write's schema failure before reserve, `deleteCustomCategory` ok + the exact NOT_FOUND sentence, 199/200 allowed, a 2,001-leaf department (pins the 12,000 cap against the search's 2,000). `lib/workspace` 3 files / 65 tests. The code blocks below are the pre-fix text; §5.2's later mixed-scope rule (Task 9 code review) also simplifies `convertSearch` — see the Task 9 note.

- [ ] **Step 1: Failing tests — `lib/workspace/service.test.ts`**

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test', APP_PUBLIC_URL: 'https://keywordquarry.com' } }));
vi.mock('@/db/client', () => ({ db: {} }));

import { DrizzleQueryError } from 'drizzle-orm';
import { createWorkspaceService, type WorkspaceServiceDeps } from './service';
import { buildCategoryCatalog } from '@/lib/research/categories';
import { DEFAULT_LIMITS } from '@/lib/research/limits';
import type { ResearchActor } from '@/lib/research/service';
import { normalizeFilters } from '@/lib/savedViews/validation';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'client_claude', channel: 'mcp' };
const VIEW_ID = '11111111-1111-4111-8111-111111111111';
const CAT_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOM_ID = '33333333-3333-4333-8333-333333333333';
const KW = '44444444-4444-4444-8444-444444444444';
const catalog = buildCategoryCatalog({ snapshotVersion: 'snap', datasetWeek: '2026-09-26' }, [
  { categoryPath: 'Lighting › Lamps', allCount: 10 },
  { categoryPath: 'Lighting › Ceiling Lights', allCount: 5 },
]);
const view = { id: VIEW_ID, name: 'Lamps', filters: normalizeFilters({ q: 'lamp' }), createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };
const category = { id: CAT_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps', 'Old › Leaf'], createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };

function makeDeps(over: Partial<WorkspaceServiceDeps> = {}): WorkspaceServiceDeps {
  return {
    limits: { ...DEFAULT_LIMITS },
    appUrl: 'https://keywordquarry.com',
    now: () => new Date('2026-09-30T12:00:00Z'),
    reserve: vi.fn(async () => ({ requests: 1, rows: 0 })),
    record: vi.fn(),
    countWritesToday: vi.fn(async () => 3),
    bumpWrite: vi.fn(),
    categories: { loadCatalog: async () => catalog, loadCustomRows: async () => [{ id: CUSTOM_ID, leafPaths: ['Lighting › Lamps'] }], listCustom: async () => [] },
    savedViews: {
      list: vi.fn(async () => [view]),
      create: vi.fn(async () => ({ ok: true as const, view })),
      update: vi.fn(async () => ({ ok: true as const, view })),
      delete: vi.fn(async () => ({ ok: true as const, deleted: { id: VIEW_ID, name: 'Lamps' } })),
    },
    customCategories: {
      list: vi.fn(async () => [category]),
      load: vi.fn(async () => category),
      create: vi.fn(async () => ({ ok: true as const, category })),
      update: vi.fn(async () => ({ ok: true as const, category })),
      delete: vi.fn(async () => ({ ok: true as const, deleted: { id: CAT_ID, name: 'Lighting', leafCount: 2 } })),
    },
    watchlist: {
      list: vi.fn(async () => [{ keywordId: KW, keyword: 'desk lamp', addedAt: '2026-09-30T09:00:00.000Z' }]),
      count: vi.fn(async () => 7),
      add: vi.fn(async () => ({ added: 1, alreadyWatching: 0, unmatched: [], skippedAtCap: 0 })),
      remove: vi.fn(async () => ({ removed: 1, notWatching: 0, unmatched: [] })),
    },
    ...over,
  };
}

let log: MockInstance<typeof console.log>; // ReturnType<typeof vi.spyOn> resolves to `any` under vitest 4.1.4 and would untype the callbacks below
beforeEach(() => { log = vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => log.mockRestore());
const lines = () => log.mock.calls.filter((c) => c[0] === '[workspace]').map((c) => JSON.parse(String(c[1])) as Record<string, unknown>);

describe('list tools', () => {
  it('reserve → list → record, never the write counter; summaries carry links and compact filters', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    const res = await svc.listSavedViews(actor, {});
    expect(deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', channel: 'mcp', rows: 0 }));
    expect(res).toEqual({ views: [{ id: VIEW_ID, name: 'Lamps', explorerUrl: `https://keywordquarry.com/explorer?view=${VIEW_ID}`, filters: { q: 'lamp' }, createdAt: view.createdAt, updatedAt: view.updatedAt }], count: 1, limit: 5 });
    expect(deps.record).toHaveBeenCalledWith('u1', 0, 'mcp');
    expect(deps.countWritesToday).not.toHaveBeenCalled();
    expect(deps.bumpWrite).not.toHaveBeenCalled();
    const cats = await svc.listCustomCategories(actor, {});
    expect(cats).toEqual({ categories: [{ id: CAT_ID, name: 'Lighting', leafCount: 2, previewPaths: ['Lighting › Lamps', 'Old › Leaf'], previewComplete: true, explorerUrl: `https://keywordquarry.com/explorer?custom=${CAT_ID}`, createdAt: category.createdAt, updatedAt: category.updatedAt }], count: 1, limit: 25 });
    const wl = await svc.listWatchlist(actor, {});
    expect(wl).toEqual({ items: [{ searchTermId: KW, keyword: 'desk lamp', keywordUrl: `https://keywordquarry.com/explorer/keyword/${KW}`, addedAt: '2026-09-30T09:00:00.000Z' }], count: 1, limit: 100 });
    expect(lines().map((l) => l.outcome)).toEqual(['ok', 'ok', 'ok']);
  });
  it('rejects an unexpected key before reserving', async () => {
    const deps = makeDeps();
    await expect(createWorkspaceService(deps).listSavedViews(actor, { page: 2 })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
    expect(deps.reserve).not.toHaveBeenCalled();
  });
});

describe('create_saved_view', () => {
  const search = {
    schemaVersion: 1, comparisonWindow: '1w',
    filters: { text: { value: 'lamp' }, categories: { selections: [{ kind: 'taxonomy', path: 'Lighting', includeDescendants: true }, { kind: 'custom', id: CUSTOM_ID }] } },
  };
  it('validates → reserves → checks the daily cap → converts through the search\'s own validation → saves → records and bumps', async () => {
    const deps = makeDeps();
    const res = await createWorkspaceService(deps).createSavedView(actor, { name: 'Lamps', search });
    expect(deps.reserve).toHaveBeenCalledTimes(1);
    expect(deps.countWritesToday).toHaveBeenCalledWith('u1');
    const [uid, input] = (deps.savedViews.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { name: string; filters: Record<string, unknown> }];
    expect(uid).toBe('u1');
    expect(input.name).toBe('Lamps');
    // Taxonomy selections expand to their leaves; the custom selection passes to the Explorer by id.
    expect(input.filters).toMatchObject({ ...EXPLORER_DEFAULTS, window: '1w', q: 'lamp', leafPaths: ['Lighting › Ceiling Lights', 'Lighting › Lamps'], customCategoryIds: [CUSTOM_ID], category: null });
    expect(res).toEqual({ view: expect.objectContaining({ id: VIEW_ID, explorerUrl: `https://keywordquarry.com/explorer?view=${VIEW_ID}` }), notes: [] });
    expect(deps.record).toHaveBeenCalledWith('u1', 0, 'mcp');
    expect(deps.bumpWrite).toHaveBeenCalledWith('u1');
    expect(lines()[0]).toMatchObject({ tool: 'create_saved_view', outcome: 'ok', userId: 'u1' });
    expect(JSON.stringify(lines())).not.toContain('Lamps');
  });
  it('fills schemaVersion when the AI omits it, and refuses a cursor', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    await expect(svc.createSavedView(actor, { name: 'L', search: { filters: { text: { value: 'lamp' } } } })).resolves.toBeTruthy();
    await expect(svc.createSavedView(actor, { name: 'L', search: { cursor: 'c'.repeat(20) } })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
  });
  it('an unknown category path fails like search does, before any save', async () => {
    const deps = makeDeps();
    await expect(createWorkspaceService(deps).createSavedView(actor, { name: 'L', search: { filters: { categories: { leafPaths: ['Nope › Nothing'] } } } })).rejects.toMatchObject({ code: 'CATEGORY_NOT_AVAILABLE' });
    expect(deps.savedViews.create).not.toHaveBeenCalled();
    expect(deps.bumpWrite).not.toHaveBeenCalled();
  });
  it('the 201st write of the day is RATE_LIMITED until Eastern midnight and never reaches a command', async () => {
    const deps = makeDeps({ countWritesToday: vi.fn(async () => 200) });
    await expect(createWorkspaceService(deps).createSavedView(actor, { name: 'L', search: {} })).rejects.toMatchObject({
      code: 'RATE_LIMITED', retryable: true, message: 'Daily limit of 200 saves reached. Try again tomorrow.', retryAfterSeconds: 16 * 3600,
    });
    expect(deps.savedViews.create).not.toHaveBeenCalled();
    expect(deps.bumpWrite).not.toHaveBeenCalled();
    expect(lines()[0]).toMatchObject({ outcome: 'refused', code: 'RATE_LIMITED' });
  });
  it('maps command failures to the workspace error codes and does not bump', async () => {
    const dup = makeDeps({ savedViews: { ...makeDeps().savedViews, create: vi.fn(async () => ({ ok: false as const, code: 'duplicate_name' as const, message: 'You already have a view named "Lamps". Choose a different name or update the existing one.' })) } });
    await expect(createWorkspaceService(dup).createSavedView(actor, { name: 'Lamps', search: {} })).rejects.toMatchObject({ code: 'DUPLICATE_NAME', message: expect.stringContaining('already have a view named') });
    expect(dup.bumpWrite).not.toHaveBeenCalled();
    const cap = makeDeps({ savedViews: { ...makeDeps().savedViews, create: vi.fn(async () => ({ ok: false as const, code: 'cap_reached' as const, message: "You've reached the 5-view limit. Delete a saved view to add a new one." })) } });
    await expect(createWorkspaceService(cap).createSavedView(actor, { name: 'Sixth', search: {} })).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
  });
});

describe('update and delete saved view', () => {
  it('a rename passes only the name; a new search replaces the filters wholesale', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    await svc.updateSavedView(actor, { id: VIEW_ID, name: 'New' });
    expect(deps.savedViews.update).toHaveBeenLastCalledWith('u1', VIEW_ID, { name: 'New', filters: undefined });
    await svc.updateSavedView(actor, { id: VIEW_ID, search: { filters: { text: { value: 'floor lamp' } } } });
    const [, , input] = (deps.savedViews.update as ReturnType<typeof vi.fn>).mock.lastCall as [string, string, { name?: string; filters: Record<string, unknown> }];
    expect(input.name).toBeUndefined();
    expect(input.filters).toMatchObject({ q: 'floor lamp' });
  });
  it('a foreign or missing id is NOT_FOUND with the account-scoped sentence', async () => {
    const deps = makeDeps({ savedViews: { ...makeDeps().savedViews, delete: vi.fn(async () => ({ ok: false as const, code: 'not_found' as const, message: 'view not found' })) } });
    await expect(createWorkspaceService(deps).deleteSavedView(actor, { id: VIEW_ID })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'No saved view with that id belongs to this account.' });
  });
  it('delete returns what it removed', async () => {
    const deps = makeDeps();
    await expect(createWorkspaceService(deps).deleteSavedView(actor, { id: VIEW_ID })).resolves.toEqual({ deleted: { id: VIEW_ID, name: 'Lamps' } });
    expect(deps.bumpWrite).toHaveBeenCalledWith('u1');
  });
});

describe('custom categories', () => {
  it('create expands selections against the catalog with the 12,000-leaf cap and stores the leaves', async () => {
    const deps = makeDeps();
    const res = await createWorkspaceService(deps).createCustomCategory(actor, { name: 'Lighting', categories: { selections: [{ kind: 'taxonomy', path: 'Lighting', includeDescendants: true }] } });
    expect(deps.customCategories.create).toHaveBeenCalledWith('u1', { name: 'Lighting', leafPaths: ['Lighting › Ceiling Lights', 'Lighting › Lamps'] });
    expect(res).toEqual({ category: expect.objectContaining({ id: CAT_ID, leafCount: 2, previewComplete: true, explorerUrl: `https://keywordquarry.com/explorer?custom=${CAT_ID}` }), notes: [] });
  });
  it('update resolves leafMode add / remove / replace against the stored leaves (remove subtracts explicit paths verbatim), and is NOT_FOUND for a missing category', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    const ceiling = { selections: [{ kind: 'taxonomy', path: 'Lighting › Ceiling Lights', includeDescendants: false }] };
    await svc.updateCustomCategory(actor, { id: CAT_ID, categories: ceiling, leafMode: 'add' });
    expect(deps.customCategories.update).toHaveBeenLastCalledWith('u1', CAT_ID, { name: undefined, leafPaths: ['Lighting › Lamps', 'Old › Leaf', 'Lighting › Ceiling Lights'] });
    await svc.updateCustomCategory(actor, { id: CAT_ID, categories: { leafPaths: ['Lighting › Lamps'] }, leafMode: 'remove' });
    expect(deps.customCategories.update).toHaveBeenLastCalledWith('u1', CAT_ID, { name: undefined, leafPaths: ['Old › Leaf'] });
    // A stale stored leaf (not in the catalog) is still removable: explicit paths are subtracted verbatim.
    await svc.updateCustomCategory(actor, { id: CAT_ID, categories: { leafPaths: ['Old › Leaf'] }, leafMode: 'remove' });
    expect(deps.customCategories.update).toHaveBeenLastCalledWith('u1', CAT_ID, { name: undefined, leafPaths: ['Lighting › Lamps'] });
    await svc.updateCustomCategory(actor, { id: CAT_ID, name: 'Ceilings', categories: ceiling });
    expect(deps.customCategories.update).toHaveBeenLastCalledWith('u1', CAT_ID, { name: 'Ceilings', leafPaths: ['Lighting › Ceiling Lights'] });
    await svc.updateCustomCategory(actor, { id: CAT_ID, name: 'Renamed' });
    expect(deps.customCategories.update).toHaveBeenLastCalledWith('u1', CAT_ID, { name: 'Renamed', leafPaths: undefined });
    expect(deps.customCategories.load).toHaveBeenCalledTimes(4);
    const missing = makeDeps({ customCategories: { ...makeDeps().customCategories, load: vi.fn(async () => null) } });
    await expect(createWorkspaceService(missing).updateCustomCategory(actor, { id: CAT_ID, categories: ceiling })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(missing.customCategories.update).not.toHaveBeenCalled();
  });
  it('a leaf list that empties out is INVALID_FILTERS from the command', async () => {
    const deps = makeDeps({ customCategories: { ...makeDeps().customCategories, update: vi.fn(async () => ({ ok: false as const, code: 'no_leaves' as const, message: 'A category needs at least one leaf.' })) } });
    await expect(createWorkspaceService(deps).updateCustomCategory(actor, { id: CAT_ID, categories: { leafPaths: ['Lighting › Lamps', 'Old › Leaf'] }, leafMode: 'remove' })).rejects.toMatchObject({ code: 'INVALID_FILTERS', message: 'A category needs at least one leaf.' });
  });
});

describe('watchlist', () => {
  it('add and remove pass both selections through, then report the live count and the cap', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    await expect(svc.addToWatchlist(actor, { keywords: ['desk lamp'], searchTermIds: [KW] })).resolves.toEqual({ added: 1, alreadyWatching: 0, unmatched: [], skippedAtCap: 0, watching: 7, limit: 100 });
    expect(deps.watchlist.add).toHaveBeenCalledWith('u1', { keywords: ['desk lamp'], searchTermIds: [KW] });
    await expect(svc.removeFromWatchlist(actor, { keywords: ['desk lamp'] })).resolves.toEqual({ removed: 1, notWatching: 0, unmatched: [], watching: 7, limit: 100 });
    expect(deps.bumpWrite).toHaveBeenCalledTimes(2);
  });
  it('an unexpected failure is logged as failed with the error name only, and rethrown', async () => {
    // The production shape: drizzle wraps the driver error, whose SQLSTATE sits on `cause`; the wrapper's
    // message embeds the bound params (here an email), which must never reach the log.
    const wrapped = new DrizzleQueryError('insert into "watchlist_items" ("user_id", "keyword_id") values ($1, $2)', ['u1', 'u1@example.com'], Object.assign(new Error('relation "watchlist_items" does not exist'), { code: '42P01' }));
    const deps = makeDeps({ watchlist: { ...makeDeps().watchlist, add: vi.fn(async () => { throw wrapped; }) } });
    await expect(createWorkspaceService(deps).addToWatchlist(actor, { keywords: ['x'] })).rejects.toBe(wrapped);
    expect(lines()[0]).toEqual(expect.objectContaining({ tool: 'add_to_watchlist', outcome: 'failed', error: 'Error', code: '42P01', userId: 'u1' }));
    expect(JSON.stringify(lines())).not.toContain('example.com');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/workspace/service.test.ts`
Expected: FAIL — cannot resolve `./service`.

- [ ] **Step 3: Implement `lib/workspace/service.ts`**

```ts
/**
 * The workspace service (spec 2026-09-30 §8, §10): one method per tool. Every call runs
 * validate → reserve (the per-minute bucket, rows 0) → daily write cap (writes only) → command →
 * record (mcp_request; writes also bump mcp_write) → one log line. Everything is injected so
 * unit tests never touch a database; defaultWorkspaceDeps() wires production.
 */
import { bumpUserActivity } from '@/lib/activity/bump';
import { secondsUntilNextEtDay } from '@/lib/activity/etDay';
import { errFields } from '@/lib/ask/logSafe';
import { countUserActivityToday } from '@/lib/activity/readToday';
import * as categoryCommands from '@/lib/customCategories/commands';
import { listCustomCategoriesForUser, loadCustomCategoryForUser, type CustomCategoryDTO } from '@/lib/customCategories/loadServer';
import { MAX_CUSTOM_CATEGORIES, MAX_LEAF_PATHS_PER_CATEGORY } from '@/lib/customCategories/validation';
import { env } from '@/lib/env';
import type { ExplorerFilters } from '@/lib/explorer/types';
import { applyPresets } from '@/lib/research/catalog';
import { defaultCategoryDeps, resolveScope, type CategoryDeps } from '@/lib/research/categories';
import { invalid, parseSearchInput, type Filters } from '@/lib/research/contracts';
import { ResearchError } from '@/lib/research/errors';
import { researchLimits, type ResearchLimits } from '@/lib/research/limits';
import { keywordUrlFor } from '@/lib/research/links';
import type { ResearchActor } from '@/lib/research/service';
import { recordResearchActivity, reserveResearchRequest } from '@/lib/research/usage';
import * as savedViewCommands from '@/lib/savedViews/commands';
import { listSavedViewsForUser } from '@/lib/savedViews/loadServer';
import type { SavedView } from '@/lib/savedViews/types';
import { MAX_VIEWS_PER_USER } from '@/lib/savedViews/validation';
import * as watchlistCommands from '@/lib/watchlist/commands';
import { listWatchlistWithKeywords, watchlistCountForUser } from '@/lib/watchlist/loadServer';
import { MAX_WATCHED_KEYWORDS } from '@/lib/watchlist/validation';
import {
  createCustomCategoryInputSchema, createSavedViewInputSchema, deleteCustomCategoryInputSchema, deleteSavedViewInputSchema, emptyInputSchema,
  PREVIEW_LEAF_PATHS, updateCustomCategoryInputSchema, updateSavedViewInputSchema, watchlistSelectionInputSchema,
  type AddToWatchlistResponse, type CustomCategorySummary, type CustomCategoryWriteResponse, type DeleteCustomCategoryResponse,
  type DeleteSavedViewResponse, type ListCustomCategoriesResponse, type ListSavedViewsResponse, type ListWatchlistResponse,
  type RemoveFromWatchlistResponse, type SavedViewSummary, type SavedViewWriteResponse, type SearchSpec, type WorkspaceService, type WorkspaceToolName,
} from './contracts';
import { compactExplorerFilters, customCategoryUrlFor, savedViewUrlFor, toExplorerFilters } from './explorerFilters';

export interface WorkspaceServiceDeps {
  limits: ResearchLimits;
  appUrl: string;
  now: () => Date;
  reserve: typeof reserveResearchRequest;
  record: typeof recordResearchActivity;
  /** Today's (ET) mcp_write count for the account. */
  countWritesToday: (userId: string) => Promise<number>;
  /** Fire-and-forget +1 on mcp_write. */
  bumpWrite: (userId: string) => void;
  categories: CategoryDeps;
  savedViews: {
    list: typeof listSavedViewsForUser;
    create: typeof savedViewCommands.createSavedView;
    update: typeof savedViewCommands.updateSavedView;
    delete: typeof savedViewCommands.deleteSavedView;
  };
  customCategories: {
    list: typeof listCustomCategoriesForUser;
    load: typeof loadCustomCategoryForUser;
    create: typeof categoryCommands.createCustomCategory;
    update: typeof categoryCommands.updateCustomCategory;
    delete: typeof categoryCommands.deleteCustomCategory;
  };
  watchlist: {
    list: typeof listWatchlistWithKeywords;
    count: typeof watchlistCountForUser;
    add: typeof watchlistCommands.addToWatchlist;
    remove: typeof watchlistCommands.removeFromWatchlist;
  };
}

export function defaultWorkspaceDeps(): WorkspaceServiceDeps {
  return {
    limits: researchLimits(),
    appUrl: env.APP_PUBLIC_URL,
    now: () => new Date(),
    reserve: reserveResearchRequest,
    record: recordResearchActivity,
    countWritesToday: (userId) => countUserActivityToday(userId, 'mcp_write'),
    bumpWrite: (userId) => {
      void bumpUserActivity(userId, 'mcp_write');
    },
    categories: defaultCategoryDeps,
    savedViews: { list: listSavedViewsForUser, create: savedViewCommands.createSavedView, update: savedViewCommands.updateSavedView, delete: savedViewCommands.deleteSavedView },
    customCategories: {
      list: listCustomCategoriesForUser, load: loadCustomCategoryForUser,
      create: categoryCommands.createCustomCategory, update: categoryCommands.updateCustomCategory, delete: categoryCommands.deleteCustomCategory,
    },
    watchlist: { list: listWatchlistWithKeywords, count: watchlistCountForUser, add: watchlistCommands.addToWatchlist, remove: watchlistCommands.removeFromWatchlist },
  };
}

let singleton: WorkspaceService | null = null;
/** One shared service per process, built from the production deps on first use. */
export function defaultWorkspaceService(): WorkspaceService {
  if (!singleton) singleton = createWorkspaceService(defaultWorkspaceDeps());
  return singleton;
}
/** Test-only. */
export function resetWorkspaceServiceForTests(): void {
  singleton = null;
}

const NOT_FOUND_MESSAGE = {
  view: 'No saved view with that id belongs to this account.',
  category: 'No custom category with that id belongs to this account.',
} as const;

type CommandFailure = { ok: false; code: savedViewCommands.SavedViewCommandCode | categoryCommands.CustomCategoryCommandCode; message: string };

/** §7: command result codes → ResearchError codes. Messages are the app's own sentences, except NOT_FOUND, which names the account scope. */
function toResearchError(r: CommandFailure, kind: keyof typeof NOT_FOUND_MESSAGE): ResearchError {
  switch (r.code) {
    case 'cap_reached':
    case 'too_many_leaves':
      return new ResearchError('LIMIT_REACHED', r.message);
    case 'duplicate_name':
      return new ResearchError('DUPLICATE_NAME', r.message);
    case 'not_found':
      return new ResearchError('NOT_FOUND', NOT_FOUND_MESSAGE[kind]);
    default:
      // invalid_id / invalid_name / nothing_to_update / no_leaves — input problems the schemas mostly prevent.
      return new ResearchError('INVALID_FILTERS', r.message);
  }
}

/** §8.6: one line per call — tool, outcome, code or error name, account id, timing. Never names, keywords or paths. */
function logged<T>(tool: WorkspaceToolName, actor: ResearchActor, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const line = (fields: Record<string, unknown>) =>
    console.log('[workspace]', JSON.stringify({ tool, ...fields, userId: actor.localUserId, durationMs: Date.now() - started }));
  return fn().then(
    (out) => {
      line({ outcome: 'ok' });
      return out;
    },
    (e: unknown) => {
      if (e instanceof ResearchError) line({ outcome: 'refused', code: e.code });
      else {
        // A DrizzleQueryError's own name is just "Error" and its message embeds the bound params, so log
        // the unwrapped name and SQLSTATE only (lib/ask/logSafe.ts reads the cause) — never a message.
        const { error, code } = errFields(e);
        line({ outcome: 'failed', error, ...(code ? { code } : {}) });
      }
      throw e;
    },
  );
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  const reserve = (actor: ResearchActor) =>
    deps.reserve({ userId: actor.localUserId, channel: actor.channel, rows: 0, now: deps.now(), limits: deps.limits });

  /** §8.1–8.2: the minute bucket, then the daily write cap. */
  async function beforeWrite(actor: ResearchActor): Promise<void> {
    await reserve(actor);
    const today = await deps.countWritesToday(actor.localUserId);
    if (today >= deps.limits.writesPerDay) {
      throw new ResearchError('RATE_LIMITED', `Daily limit of ${deps.limits.writesPerDay} saves reached. Try again tomorrow.`, {
        retryable: true,
        retryAfterSeconds: secondsUntilNextEtDay(deps.now()),
      });
    }
  }

  function recorded(actor: ResearchActor, write: boolean): void {
    deps.record(actor.localUserId, 0, actor.channel);
    if (write) deps.bumpWrite(actor.localUserId);
  }

  const viewSummary = (v: SavedView): SavedViewSummary => ({
    id: v.id, name: v.name, explorerUrl: savedViewUrlFor(deps.appUrl, v.id), filters: compactExplorerFilters(v.filters), createdAt: v.createdAt, updatedAt: v.updatedAt,
  });
  const categorySummary = (c: CustomCategoryDTO): CustomCategorySummary => ({
    id: c.id, name: c.name, leafCount: c.leafPaths.length, previewPaths: c.leafPaths.slice(0, PREVIEW_LEAF_PATHS), previewComplete: c.leafPaths.length <= PREVIEW_LEAF_PATHS,
    explorerUrl: customCategoryUrlFor(deps.appUrl, c.id), createdAt: c.createdAt, updatedAt: c.updatedAt,
  });

  /** §5.1: the search's own validation (schema → presets → full scope), then the taxonomy-only leaves for the converter. */
  async function convertSearch(userId: string, search: SearchSpec): Promise<{ filters: ExplorerFilters; notes: string[] }> {
    const parsed = parseSearchInput({ schemaVersion: 1, ...search });
    if (parsed.kind === 'continuation') throw new ResearchError('INVALID_FILTERS', 'Pass the search criteria, never a cursor.');
    const { filters, sort, comparisonWindow } = applyPresets(parsed.request);
    const full = await resolveScope(userId, filters.categories, deps.limits.maxExpandedLeaves, deps.categories);
    const hasCustom = filters.categories.selections.some((s) => s.kind === 'custom');
    const taxonomyOnly: Filters['categories'] = { selections: filters.categories.selections.filter((s) => s.kind === 'taxonomy'), leafPaths: filters.categories.leafPaths };
    const leaves = hasCustom ? (await resolveScope(userId, taxonomyOnly, deps.limits.maxExpandedLeaves, deps.categories)).leaves : full.leaves;
    return toExplorerFilters({ filters, sort, window: comparisonWindow, leaves });
  }

  /** §6.2: a category may hold a whole department, so the cap here is the column's, not the search's. */
  async function expandForCategory(userId: string, categories: Filters['categories']): Promise<string[]> {
    return (await resolveScope(userId, categories, MAX_LEAF_PATHS_PER_CATEGORY, deps.categories)).leaves;
  }

  async function listSavedViews(actor: ResearchActor, input: unknown): Promise<ListSavedViewsResponse> {
    const p = emptyInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await reserve(actor);
    const views = (await deps.savedViews.list(actor.localUserId)).map(viewSummary);
    recorded(actor, false);
    return { views, count: views.length, limit: MAX_VIEWS_PER_USER };
  }

  async function listCustomCategories(actor: ResearchActor, input: unknown): Promise<ListCustomCategoriesResponse> {
    const p = emptyInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await reserve(actor);
    const categories = (await deps.customCategories.list(actor.localUserId)).map(categorySummary);
    recorded(actor, false);
    return { categories, count: categories.length, limit: MAX_CUSTOM_CATEGORIES };
  }

  async function listWatchlist(actor: ResearchActor, input: unknown): Promise<ListWatchlistResponse> {
    const p = emptyInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await reserve(actor);
    const items = (await deps.watchlist.list(actor.localUserId)).map((i) => ({
      searchTermId: i.keywordId, keyword: i.keyword, keywordUrl: keywordUrlFor(deps.appUrl, i.keywordId), addedAt: i.addedAt,
    }));
    recorded(actor, false);
    return { items, count: items.length, limit: MAX_WATCHED_KEYWORDS };
  }

  async function createSavedView(actor: ResearchActor, input: unknown): Promise<SavedViewWriteResponse> {
    const p = createSavedViewInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    const { filters, notes } = await convertSearch(actor.localUserId, p.data.search);
    const r = await deps.savedViews.create(actor.localUserId, { name: p.data.name, filters });
    if (!r.ok) throw toResearchError(r, 'view');
    recorded(actor, true);
    return { view: viewSummary(r.view), notes };
  }

  async function updateSavedView(actor: ResearchActor, input: unknown): Promise<SavedViewWriteResponse> {
    const p = updateSavedViewInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    let filters: ExplorerFilters | undefined;
    let notes: string[] = [];
    if (p.data.search) ({ filters, notes } = await convertSearch(actor.localUserId, p.data.search));
    const r = await deps.savedViews.update(actor.localUserId, p.data.id, { name: p.data.name, filters });
    if (!r.ok) throw toResearchError(r, 'view');
    recorded(actor, true);
    return { view: viewSummary(r.view), notes };
  }

  async function deleteSavedView(actor: ResearchActor, input: unknown): Promise<DeleteSavedViewResponse> {
    const p = deleteSavedViewInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    const r = await deps.savedViews.delete(actor.localUserId, p.data.id);
    if (!r.ok) throw toResearchError(r, 'view');
    recorded(actor, true);
    return { deleted: r.deleted };
  }

  async function createCustomCategory(actor: ResearchActor, input: unknown): Promise<CustomCategoryWriteResponse> {
    const p = createCustomCategoryInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    const leafPaths = await expandForCategory(actor.localUserId, p.data.categories);
    const r = await deps.customCategories.create(actor.localUserId, { name: p.data.name, leafPaths });
    if (!r.ok) throw toResearchError(r, 'category');
    recorded(actor, true);
    return { category: categorySummary(r.category), notes: [] };
  }

  async function updateCustomCategory(actor: ResearchActor, input: unknown): Promise<CustomCategoryWriteResponse> {
    const p = updateCustomCategoryInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    let leafPaths: string[] | undefined;
    if (p.data.categories) {
      const existing = await deps.customCategories.load(actor.localUserId, p.data.id);
      if (!existing) throw new ResearchError('NOT_FOUND', NOT_FOUND_MESSAGE.category);
      if (p.data.leafMode === 'remove') {
        // Explicit paths are subtracted verbatim: a stale stored leaf must be removable even when the
        // catalog no longer has it (resolveScope would reject it). Only selections go through the catalog.
        const expanded = p.data.categories.selections.length > 0
          ? await expandForCategory(actor.localUserId, { selections: p.data.categories.selections, leafPaths: [] })
          : [];
        const drop = new Set([...p.data.categories.leafPaths.map((path) => path.trim()), ...expanded]);
        leafPaths = existing.leafPaths.filter((path) => !drop.has(path));
      } else {
        const expansion = await expandForCategory(actor.localUserId, p.data.categories);
        leafPaths = p.data.leafMode === 'replace' ? expansion : [...new Set([...existing.leafPaths, ...expansion])];
      }
    }
    const r = await deps.customCategories.update(actor.localUserId, p.data.id, { name: p.data.name, leafPaths });
    if (!r.ok) throw toResearchError(r, 'category');
    recorded(actor, true);
    return { category: categorySummary(r.category), notes: [] };
  }

  async function deleteCustomCategory(actor: ResearchActor, input: unknown): Promise<DeleteCustomCategoryResponse> {
    const p = deleteCustomCategoryInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    const r = await deps.customCategories.delete(actor.localUserId, p.data.id);
    if (!r.ok) throw toResearchError(r, 'category');
    recorded(actor, true);
    return { deleted: r.deleted };
  }

  async function addToWatchlist(actor: ResearchActor, input: unknown): Promise<AddToWatchlistResponse> {
    const p = watchlistSelectionInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    const r = await deps.watchlist.add(actor.localUserId, { keywords: p.data.keywords, searchTermIds: p.data.searchTermIds });
    const watching = await deps.watchlist.count(actor.localUserId);
    recorded(actor, true);
    return { ...r, watching, limit: MAX_WATCHED_KEYWORDS };
  }

  async function removeFromWatchlist(actor: ResearchActor, input: unknown): Promise<RemoveFromWatchlistResponse> {
    const p = watchlistSelectionInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    const r = await deps.watchlist.remove(actor.localUserId, { keywords: p.data.keywords, searchTermIds: p.data.searchTermIds });
    const watching = await deps.watchlist.count(actor.localUserId);
    recorded(actor, true);
    return { ...r, watching, limit: MAX_WATCHED_KEYWORDS };
  }

  return {
    listSavedViews: (a, i) => logged('list_saved_views', a, () => listSavedViews(a, i)),
    listCustomCategories: (a, i) => logged('list_custom_categories', a, () => listCustomCategories(a, i)),
    listWatchlist: (a, i) => logged('list_watchlist', a, () => listWatchlist(a, i)),
    createSavedView: (a, i) => logged('create_saved_view', a, () => createSavedView(a, i)),
    updateSavedView: (a, i) => logged('update_saved_view', a, () => updateSavedView(a, i)),
    deleteSavedView: (a, i) => logged('delete_saved_view', a, () => deleteSavedView(a, i)),
    createCustomCategory: (a, i) => logged('create_custom_category', a, () => createCustomCategory(a, i)),
    updateCustomCategory: (a, i) => logged('update_custom_category', a, () => updateCustomCategory(a, i)),
    deleteCustomCategory: (a, i) => logged('delete_custom_category', a, () => deleteCustomCategory(a, i)),
    addToWatchlist: (a, i) => logged('add_to_watchlist', a, () => addToWatchlist(a, i)),
    removeFromWatchlist: (a, i) => logged('remove_from_watchlist', a, () => removeFromWatchlist(a, i)),
  };
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run lib/workspace && pnpm typecheck`
Expected: PASS. Two things to watch: `resolveScope` sorts leaves by code unit, so the expected order in the tests is `'Lighting › Ceiling Lights'` before `'Lighting › Lamps'`; and `parseSearchInput` must receive `schemaVersion: 1` when the AI omitted it (the spread keeps an explicit `1`).

- [ ] **Step 5: Commit**

```bash
git add lib/workspace/service.ts lib/workspace/service.test.ts
git commit -F - <<'MSG'
feat(workspace): WorkspaceService — validate, reserve, daily write cap, commands, record, log (spec 2026-09-30 §8, §10)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 9: `explorerUrl` on every search answer

**Files:**
- Modify: `lib/research/contracts.ts` (the `SearchResponse` interface, after `resolvedCategoryScope`)
- Modify: `lib/research/service.ts` (`search()`, after `resolveScope`, and the `build()` return)
- Modify: `lib/research/service.test.ts` (new describe), `lib/mcp/tools/registerResearchTools.test.ts:85` (the search mock gains the two fields)
- Modify (review amendment): `lib/research/contracts.ts` `customSelectionSchema` and `lib/research/contracts.test.ts`

> **Amendment (2026-09-30, from the Task 7 code review):** this task also lowercases the research `customSelectionSchema` id — `z.strictObject({ kind: z.literal('custom'), id: z.uuid().toLowerCase() })` — because `resolveScope` matches custom ids in JavaScript against the lowercase ids Postgres returns, and the workspace schemas already lowercase theirs. A test appended to `lib/research/contracts.test.ts` parses `{ kind: 'custom', id: 'ABCDEF12-ABCD-4ABC-8ABC-ABCDEF123456' }` through `filtersSchema` and expects the lowercase id (and rejects `'not-a-uuid'`). The commit subject becomes `feat(research): explorerUrl + explorerNotes on every search_keywords answer; custom-selection ids lowercased at the schema (spec 2026-09-30 §3, §3.2)` and `lib/research/contracts.ts`/`contracts.test.ts` join the `git add` list.

- [ ] **Step 1: Failing tests — append to `lib/research/service.test.ts`**

Add these imports at the top of the file:

```ts
import { parseExplorerFilters } from '@/lib/explorer/parseFilters';
import { searchParamsToLike } from '@/lib/explorer/export/query';
import { NOTE_DELTA, NOTE_LINK_TOO_LONG } from '@/lib/workspace/explorerFilters';
```

and this describe at the end:

```ts
describe('search: the Explorer link (spec 2026-09-30 §3.2)', () => {
  it('carries a link that opens the Explorer with the same filters, sort and window, and no notes when exact', async () => {
    const res = await createResearchService(makeDeps()).search(actor, {
      schemaVersion: 1, comparisonWindow: '1w',
      filters: { estimatedMonthlySearches: { gt: 10000 }, categories: { selections: [{ kind: 'taxonomy', path: 'A', includeDescendants: true }] } },
    });
    expect(res.explorerUrl).toMatch(/^https:\/\/keywordquarry\.com\/explorer\?/);
    const parsed = parseExplorerFilters(searchParamsToLike(new URL(res.explorerUrl!).searchParams));
    // 'A' is a whole department: the probe dropped the broad-category shortcut (spec §5.2), so it expands to its leaves.
    expect(parsed).toMatchObject({ window: '1w', volMin: 10001, category: null, leafPaths: ['A › B', 'A › C'], sort: 'rank' });
    expect(res.explorerNotes).toEqual([]);
  });
  it('lists the leaves of a taxonomy selection but passes a custom selection by id', async () => {
    const custom = '33333333-3333-4333-8333-333333333333';
    const deps = makeDeps({ categories: { loadCatalog: async () => catalog, loadCustomRows: async () => [{ id: custom, leafPaths: ['A › C'] }], listCustom: async () => [] } });
    const res = await createResearchService(deps).search(actor, {
      schemaVersion: 1,
      filters: { categories: { selections: [{ kind: 'taxonomy', path: 'A › B', includeDescendants: true }, { kind: 'custom', id: custom }] } },
    });
    const parsed = parseExplorerFilters(searchParamsToLike(new URL(res.explorerUrl!).searchParams));
    expect(parsed).toMatchObject({ leafPaths: ['A › B'], customCategoryIds: [custom] });
  });
  it('notes what the link cannot carry, and omits the link past the URL cap', async () => {
    const delta = await createResearchService(makeDeps()).search(actor, { schemaVersion: 1, presetIds: ['growing_4w_v1'] });
    expect(delta.explorerNotes).toEqual([NOTE_DELTA]);
    expect(delta.explorerUrl).toContain('sort=imp');
    const paths = Array.from({ length: 400 }, (_, i) => `Department › Section ${i} › A fairly long leaf category name ${i}`);
    const wide = buildCategoryCatalog({ snapshotVersion: 'snap-a', datasetWeek: '2026-09-12' }, paths.map((categoryPath) => ({ categoryPath, allCount: 1 })));
    const long = await createResearchService(makeDeps({ categories: { loadCatalog: async () => wide, loadCustomRows: async () => [], listCustom: async () => [] } }))
      .search(actor, { schemaVersion: 1, filters: { categories: { leafPaths: paths } } });
    expect(long.explorerUrl).toBeNull();
    expect(long.explorerNotes).toEqual([NOTE_LINK_TOO_LONG]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/research/service.test.ts`
Expected: the three new tests FAIL (`explorerUrl` undefined); the rest PASS.

- [ ] **Step 3: Implement**

`lib/research/contracts.ts`, inside `SearchResponse` after `resolvedCategoryScope: ResolvedScope;`:

```ts
  /** The Explorer opened with this search's filters, sort and window (spec 2026-09-30 §3.2, §5), or null when the link would exceed the URL cap (§5.6). */
  explorerUrl: string | null;
  /** What the link could not carry, or why it is null; empty when the link is exact. */
  explorerNotes: string[];
```

`lib/research/service.ts`: add the import

```ts
import { explorerUrlFor, NOTE_LINK_TOO_LONG, toExplorerFilters } from '@/lib/workspace/explorerFilters';
```

and, in `search()`, right after `const scope = await resolveScope(...)`:

```ts
    // Spec 2026-09-30 §3.2: the Explorer link for this exact search. Custom selections reach the
    // Explorer by id, so the link's leaf list comes from the taxonomy selections and explicit leaf
    // paths only — a second resolution against the same cached catalog when a custom selection is
    // present (a subset of `scope`, so it cannot fail where the search itself succeeded).
    const hasCustom = filters.categories.selections.some((s) => s.kind === 'custom');
    const explorerLeaves = hasCustom
      ? (await resolveScope(
          actor.localUserId,
          { selections: filters.categories.selections.filter((s) => s.kind === 'taxonomy'), leafPaths: filters.categories.leafPaths },
          deps.limits.maxExpandedLeaves,
          deps.categories,
        )).leaves
      : scope.leaves;
    const explorer = toExplorerFilters({ filters, sort, window: comparisonWindow, leaves: explorerLeaves });
    const explorerUrl = explorerUrlFor(deps.appUrl, explorer.filters);
    const explorerNotes = explorerUrl === null ? [...explorer.notes, NOTE_LINK_TOO_LONG] : explorer.notes;
```

and in `build()`'s returned object, after `resolvedCategoryScope: scope.scope,`:

```ts
        explorerUrl,
        explorerNotes,
```

`lib/mcp/tools/registerResearchTools.test.ts`: in the `search` mock's returned object, after the `resolvedCategoryScope` line add

```ts
      explorerUrl: 'https://keywordquarry.com/explorer?window=4w&sort=rank',
      explorerNotes: [],
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run lib/research/service.test.ts lib/mcp/tools/registerResearchTools.test.ts lib/ask && pnpm typecheck`
Expected: PASS. (Ask AI's chat receives the same field in its tool results; no change there.)

- [ ] **Step 5: Commit**

```bash
git add lib/research/contracts.ts lib/research/service.ts lib/research/service.test.ts lib/mcp/tools/registerResearchTools.test.ts
git commit -F - <<'MSG'
feat(research): explorerUrl + explorerNotes on every search_keywords answer (spec 2026-09-30 §3.2)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 10: Guide section, server instructions, registration and the flag-gated handler

**Files:**
- Modify: `lib/research/contracts.ts` (`GuideResponse`), `lib/research/catalog.ts` (`GUIDE_VERSION`, `buildGuide`), `lib/research/catalog.test.ts`
- Modify: `lib/research/service.ts` (`ResearchServiceDeps.workspaceEnabled`, `guide()`), `lib/research/service.test.ts` (`makeDeps`, `guideVersion`)
- Create: `lib/mcp/tools/registerWorkspaceTools.ts`, `lib/mcp/tools/registerWorkspaceTools.test.ts`
- Modify: `lib/mcp/handler.ts`, `app/api/mcp/route.test.ts`, `lib/ask/tools.test.ts`

- [ ] **Step 1: Failing tests**

Append to `lib/research/catalog.test.ts` (add `GUIDE_VERSION, WORKSPACE_RULES` to the import from `./catalog`):

```ts
describe('buildGuide workspace section (spec 2026-09-30 §9.1)', () => {
  it('is absent unless asked for, and then carries the rules and the caps', () => {
    expect(GUIDE_VERSION).toBe(2);
    const off = buildGuide({ datasetWeek: '2026-09-12', audience: 'all', limits: DEFAULT_LIMITS });
    expect(off.guideVersion).toBe(2);
    expect(off.workspace).toBeUndefined();
    const on = buildGuide({ datasetWeek: '2026-09-12', audience: 'all', limits: { ...DEFAULT_LIMITS, writesPerDay: 42 }, workspace: true });
    expect(on.workspace).toEqual({ rules: WORKSPACE_RULES, caps: { savedViews: 5, customCategories: 25, watchedKeywords: 100, leavesPerCategory: 12000, writesPerDay: 42 } });
    expect(WORKSPACE_RULES.some((r) => r.includes('Never create, change or delete anything the person did not ask for'))).toBe(true);
    expect(WORKSPACE_RULES.some((r) => r.includes('DUPLICATE_NAME'))).toBe(true);
    expect(WORKSPACE_RULES.some((r) => r.includes('explorerUrl'))).toBe(true);
  });
});
```

In `lib/research/service.test.ts`: change `guideVersion: 1` on the provenance assertion to `guideVersion: 2`; add `workspaceEnabled: () => false,` to `makeDeps()` (after `audience`); and append:

```ts
describe('guide: workspace section', () => {
  it('is present for an MCP actor when the flag is on, never for the chat actor', async () => {
    const on = createResearchService(makeDeps({ workspaceEnabled: () => true }));
    expect((await on.guide(actor)).workspace).toBeDefined();
    expect((await on.guide({ ...actor, clientId: 'ask-ai', channel: 'chat' })).workspace).toBeUndefined();
    const off = createResearchService(makeDeps({ workspaceEnabled: () => false }));
    expect((await off.guide(actor)).workspace).toBeUndefined();
  });
});
```

Create `lib/mcp/tools/registerWorkspaceTools.test.ts`:

```ts
// lib/mcp/tools/registerWorkspaceTools.test.ts
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/env', () => ({ env: {} }));

import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { registerWorkspaceTools } from './registerWorkspaceTools';
import { DEFAULT_LIMITS } from '@/lib/research/limits';
import { ResearchError } from '@/lib/research/errors';
import type { ResearchActor } from '@/lib/research/service';
import { WORKSPACE_TOOLS } from '@/lib/workspace/tools';
import { WORKSPACE_TOOL_NAMES, type WorkspaceService } from '@/lib/workspace/contracts';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'client_claude', channel: 'mcp' };
const service = {
  listSavedViews: vi.fn(async () => ({ views: [], count: 0, limit: 5 })),
  listCustomCategories: vi.fn(async () => ({ categories: [], count: 0, limit: 25 })),
  listWatchlist: vi.fn(async () => ({ items: [], count: 0, limit: 100 })),
  createSavedView: vi.fn(async () => { throw new ResearchError('DUPLICATE_NAME', 'You already have a view named "Lamps". Choose a different name or update the existing one.'); }),
  updateSavedView: vi.fn(), deleteSavedView: vi.fn(), createCustomCategory: vi.fn(), updateCustomCategory: vi.fn(), deleteCustomCategory: vi.fn(),
  addToWatchlist: vi.fn(async () => ({ added: 1, alreadyWatching: 0, unmatched: [], skippedAtCap: 0, watching: 1, limit: 100 })),
  removeFromWatchlist: vi.fn(),
} as unknown as WorkspaceService;

describe('workspace tools over an in-memory MCP connection', () => {
  const client = new Client({ name: 'test', version: '0' });
  const server = new McpServer({ name: 'keywordquarry-test', version: '0' });
  beforeAll(async () => {
    registerWorkspaceTools(server, service, { actorFor: () => actor, limits: DEFAULT_LIMITS });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('lists exactly the eleven tools with the shared module\'s names, titles, descriptions and annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...WORKSPACE_TOOL_NAMES]);
    expect(tools.map((t) => [t.name, t.title, t.description, t.annotations])).toEqual(WORKSPACE_TOOLS.map((d) => [d.name, d.title, d.description(DEFAULT_LIMITS), d.annotations]));
    expect(tools.find((t) => t.name === 'list_saved_views')!.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'delete_saved_view')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const create = tools.find((t) => t.name === 'create_saved_view')!.inputSchema as { properties: Record<string, unknown>; additionalProperties: unknown };
    expect(Object.keys(create.properties).sort()).toEqual(['name', 'search']);
    expect(create.additionalProperties).toBe(false);
  });

  it('calls the service with the gate-supplied actor and returns structured content', async () => {
    const r = await client.callTool({ name: 'add_to_watchlist', arguments: { keywords: ['desk lamp'] } });
    expect(r.isError).toBeFalsy();
    expect(service.addToWatchlist).toHaveBeenCalledWith(actor, { keywords: ['desk lamp'], searchTermIds: [] });
    expect(r.structuredContent).toMatchObject({ added: 1, watching: 1 });
  });

  it('maps a ResearchError to an MCP tool error with its code and message', async () => {
    const r = await client.callTool({ name: 'create_saved_view', arguments: { name: 'Lamps', search: {} } });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ error: { code: 'DUPLICATE_NAME', message: 'You already have a view named "Lamps". Choose a different name or update the existing one.', retryable: false } });
  });

  it('rejects a schema-invalid call via the SDK before the service ever runs', async () => {
    const r = await client.callTool({ name: 'delete_saved_view', arguments: { id: 'nope' } });
    expect(r.isError).toBe(true);
    expect(service.deleteSavedView).not.toHaveBeenCalled();
    const cursor = await client.callTool({ name: 'create_saved_view', arguments: { name: 'x', search: { cursor: 'c'.repeat(20) } } });
    expect(cursor.isError).toBe(true);
    expect(service.createSavedView).toHaveBeenCalledTimes(1); // only the DUPLICATE_NAME call above
  });
});
```

Append to `app/api/mcp/route.test.ts`. First add a hoisted fake and its mock next to the existing ones (top of file):

```ts
const { fakeWorkspace } = vi.hoisted(() => ({
  fakeWorkspace: {
    listSavedViews: vi.fn(async () => ({ views: [], count: 0, limit: 5 })),
    listCustomCategories: vi.fn(), listWatchlist: vi.fn(), createSavedView: vi.fn(), updateSavedView: vi.fn(), deleteSavedView: vi.fn(),
    createCustomCategory: vi.fn(), updateCustomCategory: vi.fn(), deleteCustomCategory: vi.fn(), addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn(),
  },
}));
vi.mock('@/lib/workspace/service', () => ({ defaultWorkspaceService: () => fakeWorkspace }));
```

then, in the existing "lists the six read-only tools" test, add after the tools assertion:

```ts
      expect(client.getInstructions()).not.toContain('Workspace tools');
```

and a new describe at the end of the file (the handler reads the flag and builds its instructions when the module loads, so this block re-imports it):

```ts
describe('/api/mcp with MCP_WRITE_ENABLED=1 (spec 2026-09-30 §2)', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    envMock.env.MCP_ENABLED = '1';
    envMock.env.MCP_WRITE_ENABLED = '1';
    delete envMock.env.MCP_AUDIENCE;
    delete envMock.env.MCP_ALLOWED_CLIENT_IDS;
    mockAuth.mockResolvedValue(clerkOauth());
    mockFindFirst.mockResolvedValue(adminRow);
    mockGetConnection.mockResolvedValue(null);
    mockDatasetWeek.mockResolvedValue('2026-09-12');
    for (const m of ['log', 'warn', 'error'] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => {
    delete envMock.env.MCP_WRITE_ENABLED;
    spies.splice(0).forEach((s) => s.mockRestore());
  });

  it('lists the five research tools, whoami and the eleven workspace tools, says so in the instructions, and runs a workspace tool with the gate-supplied actor', async () => {
    const route = await import('./route');
    const fetchFresh = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const req = new Request(typeof input === 'string' ? input : input.toString(), init);
      return req.method === 'POST' ? route.POST(req) : req.method === 'GET' ? route.GET(req) : new Response(null, { status: 405 });
    };
    const client = new Client({ name: 'route-test-writes', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(URL_MCP), { fetch: fetchFresh, requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(17);
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_saved_views', 'create_saved_view', 'delete_custom_category', 'remove_from_watchlist', 'whoami', 'search_keywords']));
      expect(client.getInstructions()).toContain('Workspace tools');
      const r = await client.callTool({ name: 'list_saved_views', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(fakeWorkspace.listSavedViews).toHaveBeenCalledWith({ localUserId: 'uuid-admin', clerkUserId: 'user_clerk_1', clientId: 'client_claude', channel: 'mcp' }, {});
      expect(r.structuredContent).toEqual({ views: [], count: 0, limit: 5 });
    } finally {
      await client.close().catch(() => {});
    }
  });
});
```

Append to `lib/ask/tools.test.ts` (import `WORKSPACE_TOOL_NAMES` from `@/lib/workspace/contracts`):

```ts
  it('never exposes a workspace tool (spec 2026-09-30 §2: the chat stays read-only)', () => {
    for (const name of WORKSPACE_TOOL_NAMES) expect(tools[name]).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run lib/research/catalog.test.ts lib/research/service.test.ts lib/mcp/tools/registerWorkspaceTools.test.ts app/api/mcp/route.test.ts lib/ask/tools.test.ts`
Expected: the new tests FAIL (`GUIDE_VERSION` is 1, `workspace` missing, no `registerWorkspaceTools`, 6 tools instead of 17); the Ask AI parity test passes already.

- [ ] **Step 3: Implement the guide**

`lib/research/contracts.ts`, inside `GuideResponse` after `errorCodes: string[];`:

```ts
  /** Present only on a channel with the workspace (write) tools — the MCP with MCP_WRITE_ENABLED (spec 2026-09-30 §9.1). */
  workspace?: {
    rules: string[];
    caps: { savedViews: number; customCategories: number; watchedKeywords: number; leavesPerCategory: number; writesPerDay: number };
  };
```

`lib/research/catalog.ts`: set `export const GUIDE_VERSION = 2;`, add the imports

```ts
import { MAX_CUSTOM_CATEGORIES, MAX_LEAF_PATHS_PER_CATEGORY } from '@/lib/customCategories/validation';
import { MAX_VIEWS_PER_USER } from '@/lib/savedViews/validation';
import { MAX_WATCHED_KEYWORDS } from '@/lib/watchlist/validation';
```

add, above `buildGuide`:

```ts
/** Spec 2026-09-30 §9.1. Same voice as categoryRules: short imperative lines the AI follows. */
export const WORKSPACE_RULES: readonly string[] = Object.freeze([
  'Run the search first, show the results, then save. Pass the exact search object (presetIds, filters, sort, comparisonWindow) to create_saved_view; never a cursor. Relay every entry in notes to the person.',
  'Every search answer carries explorerUrl: the Explorer opened with the same filters. Offer it when the person wants to see or refine the results in the app.',
  'Resolve category words with resolve_categories first and pass the returned selections to create_custom_category or update_custom_category; the server expands them to leaves.',
  'Edits and deletes take ids from list_saved_views, list_custom_categories or list_watchlist. Confirm the item\'s name with the person before deleting. Deleting is permanent; removing from the watchlist is not.',
  'Names must be unique per account. On DUPLICATE_NAME, ask the person for a different name; never invent one.',
  `Caps: ${MAX_VIEWS_PER_USER} saved views, ${MAX_CUSTOM_CATEGORIES} custom categories, ${MAX_WATCHED_KEYWORDS} watched keywords. At a cap, tell the person what they could remove; do not delete anything to make room unless they say so.`,
  'Never create, change or delete anything the person did not ask for in this conversation.',
]);
```

change the signature to `export function buildGuide(ctx: { datasetWeek: string | null; audience: 'admin' | 'all'; limits: ResearchLimits; workspace?: boolean }): GuideResponse {`, and add to the returned object after `errorCodes: [...RESEARCH_ERROR_CODES],`:

```ts
    ...(ctx.workspace
      ? {
          workspace: {
            rules: [...WORKSPACE_RULES],
            caps: {
              savedViews: MAX_VIEWS_PER_USER,
              customCategories: MAX_CUSTOM_CATEGORIES,
              watchedKeywords: MAX_WATCHED_KEYWORDS,
              leavesPerCategory: MAX_LEAF_PATHS_PER_CATEGORY,
              writesPerDay: ctx.limits.writesPerDay,
            },
          },
        }
      : {}),
```

`lib/research/service.ts`: add `import { mcpAudience, mcpWriteEnabled } from '@/lib/mcp/config';` (extending the existing import), add to `ResearchServiceDeps` after `audience`:

```ts
  /** Whether the workspace (write) tools are on — the guide describes them only then, and only to the MCP channel (spec 2026-09-30 §9.1). */
  workspaceEnabled: () => boolean;
```

set `workspaceEnabled: mcpWriteEnabled,` in `defaultResearchDeps()` after `audience: mcpAudience,`, and in `guide()` replace the `buildGuide(...)` call with:

```ts
    const response = buildGuide({
      datasetWeek: meta?.currentWeekEndDate ?? null,
      audience: deps.audience(),
      limits: deps.limits,
      workspace: actor.channel === 'mcp' && deps.workspaceEnabled(),
    });
```

- [ ] **Step 4: Implement the registration and the handler**

Create `lib/mcp/tools/registerWorkspaceTools.ts`:

```ts
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { researchLimits, type ResearchLimits } from '@/lib/research/limits';
import type { ResearchActor } from '@/lib/research/service';
import type { WorkspaceService } from '@/lib/workspace/contracts';
import { WORKSPACE_TOOLS } from '@/lib/workspace/tools';
import { registerDefinitions } from './registerDefinitions';
import { actorFromContext } from './toolResult';

export interface RegisterWorkspaceToolsOptions {
  actorFor?: (ctx: ServerContext) => ResearchActor;
  limits?: ResearchLimits;
}

/**
 * Registers the eleven workspace tools (lib/workspace/tools.ts) on `server` through the same
 * adapter as the research tools. lib/mcp/handler.ts calls this only while MCP_WRITE_ENABLED is
 * "1" (spec 2026-09-30 §2); Ask AI never does.
 */
export function registerWorkspaceTools(server: McpServer, service: WorkspaceService, opts: RegisterWorkspaceToolsOptions = {}): void {
  registerDefinitions(server, WORKSPACE_TOOLS, service, opts.actorFor ?? actorFromContext, opts.limits ?? researchLimits());
}
```

`lib/mcp/handler.ts`: add the imports

```ts
import { defaultWorkspaceService } from '@/lib/workspace/service';
import { MCP_SCOPE, MCP_SERVER_INFO, mcpAllowedClientIds, mcpAudience, mcpResourceUrl, mcpWriteEnabled } from './config';
import { registerWorkspaceTools } from './tools/registerWorkspaceTools';
```

(merge the `./config` line with the existing one), then replace the `createMcpHandler(...)` call with:

```ts
const BASE_INSTRUCTIONS =
  'KeywordQuarry research tools (beta). Call get_research_guide once per conversation; use resolve_categories before any category-scoped search; search_keywords takes exact filters and pages with {cursor} only; get_keyword_details and get_keyword_history read one keyword. Search volumes are estimates, capped results are labelled, and null means unknown, never zero.';
/** Spec 2026-09-30 §9.2. */
const WORKSPACE_INSTRUCTIONS =
  "Workspace tools (list/create/update/delete saved views and custom categories, add to and remove from the watchlist) change this account's own data; clients normally ask the person before each write; confirm names and deletions.";

const mcp = createMcpHandler(
  (server) => {
    registerWhoami(server);
    try {
      registerResearchTools(server, defaultResearchService());
    } catch (e) {
      // A research-deps failure (e.g. the pool cannot be constructed) must not take the whole
      // connection down: whoami stays registered and keeps serving as a diagnostic even when
      // the five research tools cannot be.
      console.error('[mcp]', JSON.stringify({ outcome: 'research_tools_unavailable', error: e instanceof Error ? e.message : String(e) }));
    }
    if (mcpWriteEnabled()) {
      try {
        registerWorkspaceTools(server, defaultWorkspaceService());
      } catch (e) {
        // Same fail-soft rule; the name only (a DrizzleQueryError's message can embed SQL params).
        console.error('[mcp]', JSON.stringify({ outcome: 'workspace_tools_unavailable', error: e instanceof Error ? e.name : String(e) }));
      }
    }
  },
  {
    serverInfo: MCP_SERVER_INFO,
    instructions: mcpWriteEnabled() ? `${BASE_INSTRUCTIONS} ${WORKSPACE_INSTRUCTIONS}` : BASE_INSTRUCTIONS,
  },
);
```

- [ ] **Step 5: Run everything touched, then the typecheck and lint**

Run: `pnpm vitest run lib/research lib/mcp app/api/mcp lib/ask && pnpm typecheck && pnpm lint`
Expected: PASS, clean. If the flag-on route test sees only six tools, `createMcpHandler`'s callback ran once at module load: the `vi.resetModules()` + dynamic import in that describe is what makes it re-run; check the env flag is set **before** the `await import('./route')`.

- [ ] **Step 6: Commit**

```bash
git add lib/research/contracts.ts lib/research/catalog.ts lib/research/catalog.test.ts lib/research/service.ts lib/research/service.test.ts lib/mcp/tools/registerWorkspaceTools.ts lib/mcp/tools/registerWorkspaceTools.test.ts lib/mcp/handler.ts app/api/mcp/route.test.ts lib/ask/tools.test.ts
git commit -F - <<'MSG'
feat(mcp): register the workspace tools behind MCP_WRITE_ENABLED; guide workspace section (GUIDE_VERSION 2) and server instructions; Ask AI parity pinned (spec 2026-09-30 §2, §9.1, §9.2)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task 11: The abuse digest sees MCP writes

**Files:**
- Modify: `lib/notifications/abuseDigest/types.ts`, `assembleStats.ts`, `evaluateFlags.ts`, `buildAbuseDigestEmail.ts`
- Modify: `lib/notifications/abuseDigest/assembleStats.test.ts`, `evaluateFlags.test.ts`, `buildAbuseDigestEmail.test.ts`

- [ ] **Step 1: Failing tests**

In all three test files, add `mcpWrites: 0,` after every `mcpRows: 0,` (the `toEqual` expectations in `assembleStats.test.ts`, the `userWith` builder in `evaluateFlags.test.ts`, the `activeUser` builder in `buildAbuseDigestEmail.test.ts`). Then append:

`assembleStats.test.ts`:

```ts
  it('reads the mcp_write counter into mcpWrites without changing the reads rank (spec 2026-09-30 §8.4)', () => {
    const rows = assemblePerUserActivity(
      [{ userId: U1, metric: 'mcp_write', count: 4 }, { userId: U2, metric: 'explorer_query', count: 1 }],
      { watchlistAdds: new Map(), savedViewsCreated: new Map(), customCategoriesCreated: new Map() },
      info,
    );
    expect(rows.map((r) => r.userId)).toEqual([U2, U1]);
    expect(rows[1].mcpWrites).toBe(4);
    expect(rows[0].mcpWrites).toBe(0);
  });
```

`evaluateFlags.test.ts`:

```ts
  it('flags more than 100 MCP writes in a day as amber (spec 2026-09-30 §8.4)', () => {
    const stats = { ...quietStats(), activeUsers: [userWith({ mcpWrites: 101 })] };
    expect(evaluateFlags(stats)).toEqual([{ severity: 'amber', message: 'a@x.com: 101 MCP writes (amber threshold: 100)' }]);
    expect(evaluateFlags({ ...quietStats(), activeUsers: [userWith({ mcpWrites: 100 })] })).toEqual([]);
    expect(THRESHOLDS.userMcpWritesPerDay).toEqual({ amber: 100 });
  });
```

`buildAbuseDigestEmail.test.ts`:

```ts
  it('shows MCP writes next to MCP calls in both the text and the HTML table', () => {
    const stats = { ...quietStats(), activeUsers: [{ ...activeUser(1, 3), mcpRequests: 5, mcpRows: 250, mcpWrites: 2 }] };
    const { text, html } = buildAbuseDigestEmail(stats, []);
    expect(text).toContain('5 MCP calls (250 rows), 2 MCP writes');
    expect(html).toContain('<th style="padding:5px 0 5px 8px;text-align:right;">MCP writes</th>');
    expect(html).toMatch(/<td[^>]*>2<\/td>\s*<\/tr>/);
  });
```

(If `buildAbuseDigestEmail`'s second argument is not the flags array in this codebase, match the existing calls in that test file.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run lib/notifications/abuseDigest`
Expected: FAIL — `mcpWrites` missing from rows, no flag, no column.

- [ ] **Step 3: Implement**

`types.ts`, in `PerUserActivity` after `mcpRows`:

```ts
  /** Workspace writes through the MCP (mcp_write counter): saved views, custom categories and watchlist changes, +1 per successful call. Enforced at 200/day (spec 2026-09-30 §8.2). */
  mcpWrites: number;
```

`assembleStats.ts`: add `mcpWrite: 'mcp_write',` to `USER_METRICS`; add `mcpWrites: 0,` to the row `rowFor` creates (after `mcpRows: 0,`); add to the counter switch:

```ts
    else if (c.metric === USER_METRICS.mcpWrite) row.mcpWrites = c.count;
```

`evaluateFlags.ts`: add to `THRESHOLDS`:

```ts
  // Workspace writes are capped at 200/day by the service (spec 2026-09-30 §8.2); amber at half.
  userMcpWritesPerDay: { amber: 100 },
```

and, inside the `for (const u of stats.activeUsers)` loop after the custom-categories band:

```ts
    banded(u.mcpWrites, THRESHOLDS.userMcpWritesPerDay, (v, th, sev) =>
      `${u.email}: ${v} MCP writes (${sev} threshold: ${th})`,
    );
```

`buildAbuseDigestEmail.ts`: in `activityTextLines` change the last template piece to `` `, ${u.mcpRequests} MCP calls (${u.mcpRows} rows), ${u.mcpWrites} MCP writes` ``; in `activityTableHtml` add after the `MCP rows` header

```ts
          <th style="padding:5px 0 5px 8px;text-align:right;">MCP writes</th>
```

and after the `u.mcpRows` cell

```ts
          <td style="padding:5px 0 5px 8px;text-align:right;">${u.mcpWrites.toLocaleString()}</td>
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run lib/notifications/abuseDigest && pnpm typecheck`
Expected: PASS (the typecheck is what catches any `PerUserActivity` literal elsewhere that still lacks `mcpWrites`; add `mcpWrites: 0` there too).

- [ ] **Step 5: Commit**

```bash
git add lib/notifications/abuseDigest/types.ts lib/notifications/abuseDigest/assembleStats.ts lib/notifications/abuseDigest/evaluateFlags.ts lib/notifications/abuseDigest/buildAbuseDigestEmail.ts lib/notifications/abuseDigest/assembleStats.test.ts lib/notifications/abuseDigest/evaluateFlags.test.ts lib/notifications/abuseDigest/buildAbuseDigestEmail.test.ts
git commit -F - <<'MSG'
feat(digest): per-user MCP writes counter, column and amber flag (spec 2026-09-30 §8.4)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 12: Connect AI page copy and prompts

Read `node_modules/next/dist/docs/01-app/01-getting-started/` (server components, `async` pages) before editing the page.

**Files:**
- Create: `lib/workspace/examples.ts`
- Modify: `app/(app)/connect-ai/ExampleQuestions.tsx`, `app/(app)/connect-ai/page.tsx`
- Test: `app/(app)/connect-ai/page.test.tsx`

- [ ] **Step 1: Failing tests — append to `app/(app)/connect-ai/page.test.tsx`**

```ts
describe('Connect AI page with the workspace tools on (spec 2026-09-30 §9.3)', () => {
  beforeEach(() => {
    envMock.env = { APP_PUBLIC_URL: 'https://keywordquarry.com', MCP_ENABLED: '1', MCP_AUDIENCE: 'all', MCP_WRITE_ENABLED: '1' };
  });

  it('says the AI can save with approval, and adds the three workspace prompts behind the disclosure', async () => {
    render(await ConnectAiPage());
    expect(screen.getByText(/with your approval each time, save views, build custom categories and edit your watchlist/)).toBeInTheDocument();
    expect(screen.queryByText(/The connection is read-only/)).toBeNull();
    const details = screen.getByText('Show more example questions').closest('details')!;
    expect(details.querySelectorAll('li')).toHaveLength(10);
    expect(screen.getByText('With saving on, also try').closest('details')).toBe(details);
    expect(screen.getByText(/Add the top 20 results to my watchlist/).closest('details')).toBe(details);
  });

  it('keeps the read-only wording and seven prompts while the flag is off', async () => {
    delete envMock.env.MCP_WRITE_ENABLED;
    render(await ConnectAiPage());
    expect(screen.getByText(/The connection is read-only/)).toBeInTheDocument();
    expect(screen.queryByText('With saving on, also try')).toBeNull();
    expect(screen.getByText('Show more example questions').closest('details')!.querySelectorAll('li')).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run "app/(app)/connect-ai/page.test.tsx"`
Expected: the two new tests FAIL; the rest PASS.

- [ ] **Step 3: Implement**

Create `lib/workspace/examples.ts`:

```ts
/** Spec 2026-09-30 §9.3: shown on the Connect AI page only while MCP_WRITE_ENABLED is on — never in Ask AI's empty state (lib/ask/examples.ts), which has no write tools. */
export const WORKSPACE_EXAMPLES = [
  'Save that search as a view called Lamps under 500 reviews.',
  'Build a custom category called Lighting from everything under Lamps and Ceiling Lights, then show me its top keywords.',
  'Add the top 20 results to my watchlist.',
] as const;
```

`app/(app)/connect-ai/ExampleQuestions.tsx` — take a `writes` prop and render the second list inside the same `<details>`:

```tsx
import { FIRST_EXAMPLE, MORE_EXAMPLES } from '@/lib/ask/examples';
import { WORKSPACE_EXAMPLES } from '@/lib/workspace/examples';

const prompt = 'select-all rounded bg-slate-100 px-2 py-1.5';

export function ExampleQuestions({ className, writes }: { className: string; writes: boolean }) {
  return (
    <section className={className}>
      <h2 className="font-semibold">Try asking</h2>
      <p className={`mt-2 text-sm ${prompt}`}>&ldquo;{FIRST_EXAMPLE}&rdquo;</p>
      <details className="group mt-2 text-sm">
        <summary className="cursor-pointer select-none text-blue-700 hover:text-blue-800">
          <span className="group-open:hidden">Show more example questions</span>
          <span className="hidden group-open:inline">Hide example questions</span>
        </summary>
        <ul className="mt-2 space-y-1.5">
          {MORE_EXAMPLES.map((q) => (
            <li key={q} className={prompt}>
              &ldquo;{q}&rdquo;
            </li>
          ))}
        </ul>
        {writes && (
          <>
            <p className="mt-3 font-medium">With saving on, also try</p>
            <ul className="mt-2 space-y-1.5">
              {WORKSPACE_EXAMPLES.map((q) => (
                <li key={q} className={prompt}>
                  &ldquo;{q}&rdquo;
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </section>
  );
}
```

`app/(app)/connect-ai/page.tsx`: import `mcpWriteEnabled` from `@/lib/mcp/config` (extend the existing import), add `const writes = mcpWriteEnabled();` after `const enabled = mcpEnabled();`, replace the intro paragraph with

```tsx
      <p className="mt-2 text-sm text-slate-600">
        {writes
          ? 'Let Claude or ChatGPT search KeywordQuarry directly while you work and, with your approval each time, save views, build custom categories and edit your watchlist. Beta, free while it lasts.'
          : 'Let Claude or ChatGPT read KeywordQuarry directly while you work. The connection is read-only: search, categories, keyword details and history. Beta, free while it lasts.'}
      </p>
```

and pass the prop: `<ExampleQuestions className={card} writes={writes} />`.

- [ ] **Step 4: Run the page tests, typecheck and lint**

Run: `pnpm vitest run "app/(app)/connect-ai" "app/(app)/ask" && pnpm typecheck && pnpm lint`
Expected: PASS, clean (Ask AI's empty-state test still sees its eight prompts).

- [ ] **Step 5: Commit**

```bash
git add lib/workspace/examples.ts "app/(app)/connect-ai/ExampleQuestions.tsx" "app/(app)/connect-ai/page.tsx" "app/(app)/connect-ai/page.test.tsx"
git commit -F - <<'MSG'
feat(connect-ai): flag-dependent intro sentence and three workspace prompts (spec 2026-09-30 §9.3)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 13: Offline checks, integration tests, ship (owner-gated)

Steps 1–3 run offline. Steps 4–7 need the owner's explicit go **for each**; the controller (not a subagent) performs them.

**Files:**
- Create: `tests/integration/workspaceCommands.test.ts`
- Modify: this plan (Results section at the end)

- [ ] **Step 1: The whole offline suite**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all clean; the build lists the same dynamic routes as before plus nothing new (no new routes were added). Fix anything that fails in the task it belongs to, with its own commit, before continuing.

- [ ] **Step 2: Write the integration test — `tests/integration/workspaceCommands.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db/client';
import { searchTerms } from '@/db/schema';
import { createCustomCategory, deleteCustomCategory, updateCustomCategory } from '@/lib/customCategories/commands';
import { loadCustomCategoryForUser } from '@/lib/customCategories/loadServer';
import { defaultCategoryDeps, resolveScope } from '@/lib/research/categories';
import { createSavedView, deleteSavedView, updateSavedView } from '@/lib/savedViews/commands';
import { addToWatchlist, removeFromWatchlist } from '@/lib/watchlist/commands';
import { listWatchlistWithKeywords } from '@/lib/watchlist/loadServer';
import { createTestUser, deleteTestUser } from './helpers';

// Run: RUN_INTEGRATION=1 pnpm vitest run tests/integration/workspaceCommands.test.ts
// Real tables, one synthetic itest user, every row removed in afterAll (users cascade to
// saved_views, custom_categories and watchlist_items).
describe('workspace commands (integration, real Postgres)', () => {
  let userId: string | undefined;
  beforeAll(async () => {
    userId = (await createTestUser('itest')).id;
  });
  afterAll(async () => {
    await deleteTestUser(userId);
  });

  it('saved views: create, duplicate, rename, delete, delete again', async () => {
    const created = await createSavedView(userId!, { name: 'itest view', filters: { q: 'lamp' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.view.filters.q).toBe('lamp');
    expect(await createSavedView(userId!, { name: 'itest view', filters: {} })).toMatchObject({ ok: false, code: 'duplicate_name' });
    expect(await updateSavedView(userId!, created.view.id, { name: 'itest view 2' })).toMatchObject({ ok: true, view: { name: 'itest view 2' } });
    expect(await deleteSavedView(userId!, created.view.id)).toEqual({ ok: true, deleted: { id: created.view.id, name: 'itest view 2' } });
    expect(await deleteSavedView(userId!, created.view.id)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('custom categories: create from a real catalog expansion, load, update, delete', async () => {
    const catalog = await defaultCategoryDeps.loadCatalog();
    const leaf = catalog.entries.find((e) => e.terminal)!;
    const scope = await resolveScope(userId!, { selections: [{ kind: 'taxonomy', path: leaf.path, includeDescendants: false }], leafPaths: [] }, 12000, defaultCategoryDeps);
    const created = await createCustomCategory(userId!, { name: 'itest category', leafPaths: scope.leaves });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.category.leafPaths).toEqual([leaf.path]);
    // The only real-database check of the lower(name) unique index → 23505 → duplicate_name chain (case-insensitive).
    expect(await createCustomCategory(userId!, { name: 'ITEST Category', leafPaths: [leaf.path] })).toMatchObject({ ok: false, code: 'duplicate_name' });
    expect(await loadCustomCategoryForUser(userId!, created.category.id)).toMatchObject({ name: 'itest category' });
    expect(await updateCustomCategory(userId!, created.category.id, { leafPaths: [leaf.path, 'Zed › Extra'] })).toMatchObject({ ok: true, category: { leafPaths: [leaf.path, 'Zed › Extra'] } });
    expect(await deleteCustomCategory(userId!, created.category.id)).toEqual({ ok: true, deleted: { id: created.category.id, name: 'itest category', leafCount: 2 } });
  });

  it('watchlist: add by text and id, list with keyword text, remove', async () => {
    const [kw] = await db.select({ id: searchTerms.id, raw: searchTerms.searchTermRaw }).from(searchTerms).limit(1);
    const added = await addToWatchlist(userId!, { keywords: [kw.raw, 'zzz no such keyword itest'], searchTermIds: [kw.id] });
    expect(added).toEqual({ added: 1, alreadyWatching: 0, unmatched: ['zzz no such keyword itest'], skippedAtCap: 0 });
    expect(await listWatchlistWithKeywords(userId!)).toEqual([{ keywordId: kw.id, keyword: kw.raw, addedAt: expect.any(String) }]);
    expect(await removeFromWatchlist(userId!, { keywords: [], searchTermIds: [kw.id] })).toEqual({ removed: 1, notWatching: 0, unmatched: [] });
    expect(await listWatchlistWithKeywords(userId!)).toEqual([]);
  });
});
```

Commit it now (it does not run in the normal suite: `vitest.config.ts` excludes `tests/integration/**` unless `RUN_INTEGRATION` is set):

```bash
git add tests/integration/workspaceCommands.test.ts
git commit -F - <<'MSG'
test(workspace): integration test for the shared commands against real tables (owner-gated run)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

- [ ] **Step 3: Fill in the Results section below and commit the docs**

Record the actual numbers (test files and tests from `pnpm test`, typecheck/lint/build outcomes, the probe's two lines, the final review's verdict) in the Results table at the end of this plan, then:

```bash
git add docs/superpowers/plans/2026-09-30-mcp-write-access.md
git commit -F - <<'MSG'
docs(workspace): plan results

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

- [ ] **Step 4 (owner-gated): integration tests**

Only after the owner says the week has settled (no import running; the next weekly import lands Monday ~03:00 UTC). `.env.local` reaches production; the test creates and removes one `itest` user.

Run: `RUN_INTEGRATION=1 pnpm vitest run tests/integration/workspaceCommands.test.ts`
Expected: 3 passed. If `defaultCategoryDeps.loadCatalog()` cannot open the research pool under the harness, replace the expansion in the second test with `leafPaths: [leaf.path]` built from a row of `keyword_current_summary_leaf_category_facets` and say so in the Results.

- [ ] **Step 5 (owner-gated): owner's Vercel and migration steps (spec §13)**

Ask the owner to: set `MCP_WRITE_ENABLED=1` in Vercel → Production; leave `ASK_AI_ENABLED` unset (Ask AI stays dark); confirm migration 0048. On that confirmation the controller runs:

```bash
APPLY_0048=yes node --env-file=.env.local --import tsx scripts/applyMigration0048.ts
```

- [ ] **Step 6 (owner-gated): push**

```bash
node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts
```

Expected: no active Keepa or import job (the Railway worker restarts on push). Then, on the owner's explicit go for this push and nothing else: `git push origin main`. Watch both commit statuses (Vercel, Railway) to success before reporting; a missing Vercel status within two minutes means the webhook was missed — say so rather than waiting.

- [ ] **Step 7 (owner-gated): smoke and announce**

The owner runs spec §12 from Claude desktop (search → link → same rows; save a view → approval prompt → Explorer dropdown; build, edit, delete a custom category; add five keywords and remove two; a duplicate name → the AI asks; delete a view; ChatGPT repeat if handy). Record each outcome in the Results table. The owner then announces to beta members; the Ask AI launch steps from the arc-2 plan follow whenever the owner is ready.

---

## Results

Filled in at Task 13 Step 3. One row per check; keep the numbers, not adjectives.

| Check | Outcome |
|---|---|
| Department probe (Task 3 Step 1) | sampled / mismatches, and whether the shortcut was kept |
| `pnpm test` | files / tests passed |
| `pnpm typecheck` | |
| `pnpm lint` | |
| `pnpm build` | |
| Final code review | verdict and the SHAs of any fix round |
| Integration test (Step 4) | |
| Smoke (Step 7) | one line per §12 item |

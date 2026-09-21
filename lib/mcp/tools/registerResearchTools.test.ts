// lib/mcp/tools/registerResearchTools.test.ts
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// registerResearchTools.ts imports lib/research/contracts (zod only, no env access at load).
// toolResult.ts imports lib/mcp/verifyMcpToken.ts, which imports @clerk/nextjs/server and
// @/db/client directly, and (via ./config) @/lib/env, whose top-level parseEnv() throws
// outside a fully-configured environment. None of those are exercised here (the test supplies
// its own actorFor), but the imports still execute at module load, so they must be stubbed.
// Pattern from app/api/mcp/route.test.ts / lib/mcp/verifyMcpToken.test.ts.
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/env', () => ({ env: {} }));

import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { registerResearchTools } from './registerResearchTools';
import { ResearchError } from '@/lib/research/errors';
import type { ResearchActor, ResearchService } from '@/lib/research/service';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'client_claude', channel: 'mcp' };

// searchToolInputSchema's `cursor` is `z.string().min(16)...` — the SDK validates tool
// arguments against inputSchema BEFORE the callback runs, so a continuation cursor used to
// drive the service-level SEARCH_EXPIRED case below must itself be a schema-valid (>=16 char)
// string, or the call never reaches the service mock at all. Authorised test adjustment (the
// plan's original 'expired' is only 7 chars and would be rejected by the SDK itself).
const EXPIRED_CURSOR = 'expired-cursor-token-1234';

const service: ResearchService = {
  guide: vi.fn(async () => ({
    guideVersion: 1,
    schemaVersion: 1 as const,
    catalogVersion: 1,
    datasetWeek: '2026-09-12',
    audience: 'admin' as const,
    metrics: [],
    presets: [],
    sorts: [],
    windows: [],
    // GuideResponse gained defaultSort/presetRules and a fleshed-out `limits` Pick since the
    // plan was written; completed minimally against the current lib/research/contracts.ts.
    defaultSort: { field: 'estimatedMonthlySearches' as const, direction: 'desc' as const },
    categoryRules: [],
    populationRules: [],
    presetRules: [],
    limits: {
      pageSizeDefault: 50,
      pageSizeMax: 100,
      maxRowsPerSearch: 1000,
      cursorTtlSeconds: 900,
      categoryCandidatesMax: 50,
      maxExpandedLeaves: 2000,
      historyWeeksMax: 52,
      requestsPerMinute: 60,
      rowsPerMinute: 6000,
      maxPayloadBytes: 262144,
    },
    pagination: 'live',
    errorCodes: [],
  })),
  resolveCategories: vi.fn(async () => ({
    query: 'lamps',
    source: 'all' as const,
    parentPath: null,
    candidates: [],
    nextCursor: null,
    totalCandidates: 0,
    provenance: { datasetWeek: '2026-09-12', snapshotVersion: 's' },
    noMatch: true,
  })),
  search: vi.fn(async (_a, input: unknown) => {
    if ((input as { cursor?: string }).cursor === EXPIRED_CURSOR) throw new ResearchError('SEARCH_EXPIRED', 'This search has expired.');
    return {
      schemaVersion: 1 as const,
      requestId: 'r',
      appliedFilters: {} as never,
      effectiveSort: { field: 'rank' as const, direction: 'asc' as const },
      effectiveWindow: '4w' as const,
      presetApplications: [],
      resolvedCategoryScope: { selections: [], expandedLeafCount: 0, leafSetHash: null, previewPaths: [], previewComplete: true },
      provenance: {
        datasetWeek: '2026-09-12', snapshotVersion: 's', summaryRefreshedAt: 'x', resultCapturedAt: 'y',
        volumeFitRunId: null, calibrationMonthEndDate: null, volumeIsExtrapolated: false, guideVersion: 1, queryVersion: 1,
      },
      rows: [{ searchTermId: 'id-1', keyword: 'kw', keywordUrl: 'u', estimatedMonthlySearches: 1, averageReviews: null, rank: 1, wordCount: 1, categoryPath: null, broadCategory: null, severity: null, lastSeenWeek: 'a', firstSeenWeek: 'b' }],
      pagination: { pageSize: 50, returnedCount: 1, offset: 0, totalMatches: { kind: 'exact' as const, value: 1 }, nextCursor: null, capped: false, capReason: null, expiresAt: null },
      warnings: [],
    };
  }),
  details: vi.fn(async () => {
    throw new Error('db exploded');
  }),
  history: vi.fn(async () => ({
    searchTermId: 'id-1', keyword: 'kw', windowStart: 'a', windowEnd: 'b', requestedWeeks: 13,
    points: [], missingWeeks: [], source: 'chart_series' as const, seriesUpdatedAt: null, warnings: [],
  })),
};

describe('research tools over an in-memory MCP connection', () => {
  const client = new Client({ name: 'test', version: '0' });
  const server = new McpServer({ name: 'keywordquarry-test', version: '0' });
  beforeAll(async () => {
    registerResearchTools(server, service, { actorFor: () => actor });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('lists exactly the five research tools, all read-only, with titles and descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_keyword_details', 'get_keyword_history', 'get_research_guide', 'resolve_categories', 'search_keywords']);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(t.title).toBeTruthy();
      expect(t.description?.length ?? 0).toBeGreaterThan(40);
    }
    const search = tools.find((t) => t.name === 'search_keywords')!;
    expect(search.description).toContain('resolve_categories');
    expect(search.inputSchema).toMatchObject({ type: 'object' });
  });

  it('calls the service with the gate-supplied actor and returns structured content', async () => {
    const r = await client.callTool({ name: 'search_keywords', arguments: { schemaVersion: 1 } });
    expect(r.isError).toBeFalsy();
    expect(service.search).toHaveBeenCalledWith(actor, { schemaVersion: 1 });
    expect((r.structuredContent as { rows: unknown[] }).rows).toHaveLength(1);
    expect(JSON.parse((r.content[0] as { text: string }).text).requestId).toBe('r');
    const g = await client.callTool({ name: 'get_research_guide', arguments: {} });
    expect((g.structuredContent as { datasetWeek: string }).datasetWeek).toBe('2026-09-12');
  });

  it('maps a ResearchError to an MCP tool error with the code, and an unexpected error to DATA_UNAVAILABLE', async () => {
    const expired = await client.callTool({ name: 'search_keywords', arguments: { cursor: EXPIRED_CURSOR } });
    expect(expired.isError).toBe(true);
    expect(JSON.parse((expired.content[0] as { text: string }).text)).toEqual({
      error: { code: 'SEARCH_EXPIRED', message: 'This search has expired.', retryable: false },
    });

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = await client.callTool({ name: 'get_keyword_details', arguments: { searchTermId: '11111111-1111-4111-8111-111111111111' } });
    expect(boom.isError).toBe(true);
    expect(JSON.parse((boom.content[0] as { text: string }).text).error.code).toBe('DATA_UNAVAILABLE');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

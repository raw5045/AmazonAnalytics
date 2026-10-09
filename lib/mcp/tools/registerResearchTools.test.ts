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
import { PAGE_SIZE_MAX } from '@/lib/research/contracts';
import { DEFAULT_LIMITS } from '@/lib/research/limits';
import { COUNT_CAP } from '@/lib/explorer/buildQuery';
import { RESEARCH_TOOLS } from '@/lib/research/tools';
import { productsForbiddenError } from '@/lib/research/products';
import type { ResearchActor, ResearchService } from '@/lib/research/service';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'client_claude', channel: 'mcp', isAdmin: false };
const admin: ResearchActor = { ...actor, isAdmin: true };
const FORBIDDEN = { error: { code: 'FORBIDDEN', message: 'Products tools are admin-only for now.', retryable: false } };

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
      explorerUrl: 'https://keywordquarry.com/explorer?window=4w&sort=rank',
      explorerNotes: [],
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
  // As the real service does (lib/research/products.ts): a non-admin account is refused with FORBIDDEN before anything runs.
  searchProducts: vi.fn(async (a: ResearchActor) => {
    if (!a.isAdmin) throw productsForbiddenError();
    return { schemaVersion: 1 as const, products: [], total: { kind: 'exact' as const, value: 0 }, page: 1, pageSize: 50, adminOnly: true as const };
  }),
  productDetails: vi.fn(async (a: ResearchActor) => {
    if (!a.isAdmin) throw productsForbiddenError();
    throw new ResearchError('NOT_FOUND', 'No data for that ASIN.');
  }),
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

  it('lists exactly the seven research tools, all read-only, with titles and descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_keyword_details', 'get_keyword_history', 'get_product_details', 'get_research_guide', 'resolve_categories', 'search_keywords', 'search_products',
    ]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(t.title).toBeTruthy();
      expect(t.description?.length ?? 0).toBeGreaterThan(40);
    }
    const search = tools.find((t) => t.name === 'search_keywords')!;
    expect(search.description).toContain('resolve_categories');
    expect(search.inputSchema).toMatchObject({ type: 'object' });

    const details = tools.find((t) => t.name === 'get_keyword_details')!;
    expect(details.description).toContain('click and conversion share percentages');
  });

  it('publishes the full search_keywords input schema — every field, no additional properties, cap text from the operating constants', async () => {
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'search_keywords')!;
    const schema = search.inputSchema as unknown as { properties: Record<string, unknown>; additionalProperties: unknown };

    expect(Object.keys(schema.properties).sort()).toEqual(
      ['comparisonWindow', 'cursor', 'filters', 'pageSize', 'presetIds', 'schemaVersion', 'sort'].sort(),
    );
    expect(schema.additionalProperties).toBe(false);

    // The `movement` filter's description lands one level down, inside the `nullable` anyOf
    // branch (zod4's z.toJSONSchema representation of `.nullable()`) rather than directly on
    // the property — assert it is reachable either way instead of pinning that representation.
    const filtersNode = schema.properties.filters as { properties: Record<string, { description?: string; anyOf?: Array<{ description?: string }> }> };
    const movementNode = filtersNode.properties.movement;
    const movementDescription = movementNode.description ?? movementNode.anyOf?.find((v) => v.description)?.description;
    expect(movementDescription).toBeTruthy();

    // excludeTerms' published schema carries the whole-word disclosure (Task 6 review).
    expect(filtersNode.properties.excludeTerms).toMatchObject({ type: 'array', maxItems: 5, description: expect.stringContaining('whole words') });

    // Cap text is built from the operating constants, not hand-copied numerals.
    expect(search.description).toContain(String(PAGE_SIZE_MAX));
    expect(search.description).toContain(COUNT_CAP.toLocaleString('en-US'));
    expect(search.description).toContain('{ cursor }');
    // I-1 (Task 15 re-review): the sort sentence discloses that a bare volumeDelta sort (no
    // movement filter) includes never-observed keywords at a zero baseline.
    expect(search.description).toContain(
      'A volumeDelta sort without a movement filter includes never-observed keywords at a zero baseline (labelled not_observed); add movement with baseline observed_only to exclude them.',
    );
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

  it('rejects get_keyword_history weeks over the schema max via the SDK, before the service ever runs', async () => {
    vi.mocked(service.history).mockClear();
    const r = await client.callTool({
      name: 'get_keyword_history',
      arguments: { searchTermId: '11111111-1111-4111-8111-111111111111', weeks: 99 },
    });
    expect(r.isError).toBe(true);
    expect(service.history).not.toHaveBeenCalled();
  });

  it('rejects an empty resolve_categories input via the SDK (needs a query, source=custom, or parentPath), before the service ever runs', async () => {
    vi.mocked(service.resolveCategories).mockClear();
    const r = await client.callTool({ name: 'resolve_categories', arguments: {} });
    expect(r.isError).toBe(true);
    expect(service.resolveCategories).not.toHaveBeenCalled();
  });

  it('passes a bare cursor continuation straight through, with no defaulted sibling field injected', async () => {
    const cursor = 'c'.repeat(20);
    const r = await client.callTool({ name: 'search_keywords', arguments: { cursor } });
    expect(r.isError).toBeFalsy();
    expect(service.search).toHaveBeenLastCalledWith(actor, { cursor });
    // Task 15 minor 3 (re-review): toHaveBeenCalledWith's deep-equality treats an explicit
    // `undefined`-valued key the same as an absent one, so it alone would not catch a
    // regression that injected e.g. `schemaVersion: undefined` alongside `cursor`. Object.keys
    // is strict about own keys regardless of value, so this pins the wire shape exactly.
    expect(Object.keys(vi.mocked(service.search).mock.lastCall![1] as object)).toEqual(['cursor']);
  });

  it('rejects a hallucinated key via the SDK, before the service ever runs', async () => {
    vi.mocked(service.search).mockClear();
    const r = await client.callTool({ name: 'search_keywords', arguments: { schemaVersion: 1, page_size: 5 } });
    expect(r.isError).toBe(true);
    expect(service.search).not.toHaveBeenCalled();
  });

  // Spec 2026-10-09 §9: the server is registered once per process, so the two admin-only products
  // tools are listed to every account; a non-admin's call reaches the service, which refuses it with
  // FORBIDDEN, and the adapter maps that ResearchError to an MCP tool error carrying the code.
  it('lists the admin-only products tools to every account and maps the service\'s FORBIDDEN refusal to a tool error with that code', async () => {
    const { tools } = await client.listTools();
    for (const name of ['search_products', 'get_product_details']) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.description, name).toContain('Admin accounts only for now.');
      expect(t.annotations, name).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(t.inputSchema, name).toMatchObject({ type: 'object', additionalProperties: false });
    }
    const filters = { listedWithinDays: 180, monthlySoldMin: 1000, reviewsMax: 300 };
    const search = await client.callTool({ name: 'search_products', arguments: { filters } });
    expect(search.isError).toBe(true);
    expect(JSON.parse((search.content[0] as { text: string }).text)).toEqual(FORBIDDEN);
    expect(service.searchProducts).toHaveBeenLastCalledWith(actor, { filters });
    const details = await client.callTool({ name: 'get_product_details', arguments: { asin: 'B0ABCDEF12' } });
    expect(details.isError).toBe(true);
    expect(JSON.parse((details.content[0] as { text: string }).text)).toEqual(FORBIDDEN);
    expect(service.productDetails).toHaveBeenLastCalledWith(actor, { asin: 'B0ABCDEF12' });
  });

  it('rejects a malformed ASIN via the SDK, before the service ever runs', async () => {
    vi.mocked(service.productDetails).mockClear();
    const r = await client.callTool({ name: 'get_product_details', arguments: { asin: 'b0abcdef12' } });
    expect(r.isError).toBe(true);
    expect(service.productDetails).not.toHaveBeenCalled();
  });
});

describe('the products tools for an admin account', () => {
  it('pass the admin actor through to the service and return its answer, or its ResearchError with the code', async () => {
    const adminServer = new McpServer({ name: 'keywordquarry-test-admin', version: '0' });
    registerResearchTools(adminServer, service, { actorFor: () => admin });
    const adminClient = new Client({ name: 'test-admin', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await adminServer.connect(serverTransport);
    await adminClient.connect(clientTransport);
    try {
      const r = await adminClient.callTool({ name: 'search_products', arguments: { sort: 'bsr', dir: 'asc' } });
      expect(r.isError).toBeFalsy();
      expect(service.searchProducts).toHaveBeenLastCalledWith(admin, { sort: 'bsr', dir: 'asc' });
      expect(r.structuredContent).toMatchObject({ adminOnly: true, total: { kind: 'exact', value: 0 }, pageSize: 50 });
      const d = await adminClient.callTool({ name: 'get_product_details', arguments: { asin: 'B0ABCDEF12' } });
      expect(d.isError).toBe(true);
      expect(JSON.parse((d.content[0] as { text: string }).text).error.code).toBe('NOT_FOUND');
      expect(service.productDetails).toHaveBeenLastCalledWith(admin, { asin: 'B0ABCDEF12' });
    } finally {
      await adminClient.close().catch(() => {});
      await adminServer.close().catch(() => {});
    }
  });
});

describe('the limits option', () => {
  it('builds the search_keywords description from a caller-supplied limits object, not only the env default', async () => {
    const customServer = new McpServer({ name: 'keywordquarry-test-limits', version: '0' });
    registerResearchTools(customServer, service, { actorFor: () => actor, limits: { ...DEFAULT_LIMITS, maxRowsPerSearch: 4242 } });
    const customClient = new Client({ name: 'test-limits', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await customServer.connect(serverTransport);
    await customClient.connect(clientTransport);
    try {
      const { tools } = await customClient.listTools();
      const search = tools.find((t) => t.name === 'search_keywords')!;
      expect(search.description).toContain((4242).toLocaleString('en-US'));
    } finally {
      await customClient.close().catch(() => {});
      await customServer.close().catch(() => {});
    }
  });
});

describe('parity with lib/research/tools.ts', () => {
  it('exposes exactly the shared module\'s names, titles, descriptions and annotations (spec §4 parity)', async () => {
    const limits = DEFAULT_LIMITS;
    const parityServer = new McpServer({ name: 'keywordquarry-test-parity', version: '0' });
    registerResearchTools(parityServer, service, { actorFor: () => actor, limits });
    const parityClient = new Client({ name: 'test-parity', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await parityServer.connect(serverTransport);
    await parityClient.connect(clientTransport);
    try {
      const { tools } = await parityClient.listTools();
      expect(tools.map((t) => [t.name, t.title, t.description, t.annotations])).toEqual(
        RESEARCH_TOOLS.map((d) => [d.name, d.title, d.description(limits), d.annotations]),
      );
    } finally {
      await parityClient.close().catch(() => {});
      await parityServer.close().catch(() => {});
    }
  });
});

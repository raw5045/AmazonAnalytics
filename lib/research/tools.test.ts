// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/env', () => ({ env: {} }));
import { isOfferedTo, RESEARCH_TOOLS, RESEARCH_TOOL_NAMES, researchToolByName } from './tools';
import { DEFAULT_LIMITS } from './limits';
import {
  PAGE_SIZE_MAX, searchToolInputSchema, resolveCategoriesInputSchema, keywordDetailsInputSchema, keywordHistoryInputSchema, emptyInputSchema,
  productSearchInputSchema, productDetailsInputSchema,
} from './contracts';
import { PRODUCT_TOOL_HISTORY_POINTS, PRODUCT_TOOL_KEYWORDS_CAP } from './productCaps';
import { PRODUCT_MAX_PAGE, PRODUCT_PAGE_SIZE } from '@/lib/products/filters';
import { PRODUCT_HISTORY_CAP } from '@/lib/products/loadProductHistory';
import { PRODUCT_COUNT_CAP } from '@/lib/products/searchProducts';
import type { ResearchActor, ResearchService } from './service';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'ask-ai', channel: 'chat', isAdmin: false };

describe('RESEARCH_TOOLS', () => {
  it('lists the seven tools in the MCP order, read-only, none needing confirmation', () => {
    expect(RESEARCH_TOOL_NAMES).toEqual([
      'get_research_guide', 'resolve_categories', 'search_keywords', 'get_keyword_details', 'get_keyword_history', 'search_products', 'get_product_details',
    ]);
    expect(RESEARCH_TOOLS.map((t) => t.name)).toEqual([...RESEARCH_TOOL_NAMES]);
    for (const t of RESEARCH_TOOLS) {
      expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(t.requiresConfirmation).toBe(false);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.description(DEFAULT_LIMITS).length).toBeGreaterThan(20);
      expect(Object.isFrozen(t)).toBe(true);
    }
    expect(Object.isFrozen(RESEARCH_TOOLS)).toBe(true);
  });
  it('marks exactly the two products tools adminOnly (spec 2026-10-09 §9); the keyword tools stay open to every account', () => {
    expect(RESEARCH_TOOLS.filter((t) => t.adminOnly === true).map((t) => t.name)).toEqual(['search_products', 'get_product_details']);
    for (const t of RESEARCH_TOOLS.filter((d) => d.adminOnly !== true)) expect(t.adminOnly, t.name).toBeUndefined();
  });
  it('isOfferedTo: an adminOnly definition is offered to an admin only, every other one to everyone', () => {
    for (const isAdmin of [true, false]) {
      expect(isOfferedTo({}, isAdmin)).toBe(true);
      expect(isOfferedTo({ adminOnly: false }, isAdmin)).toBe(true);
    }
    expect(isOfferedTo({ adminOnly: true }, true)).toBe(true);
    expect(isOfferedTo({ adminOnly: true }, false)).toBe(false);
    expect(RESEARCH_TOOLS.filter((t) => isOfferedTo(t, false)).map((t) => t.name)).toEqual(RESEARCH_TOOL_NAMES.slice(0, 5));
    expect(RESEARCH_TOOLS.filter((t) => isOfferedTo(t, true)).map((t) => t.name)).toEqual([...RESEARCH_TOOL_NAMES]);
  });
  it('binds each tool to the contracts.ts schema the MCP server has always published', () => {
    expect(researchToolByName('get_research_guide').inputSchema).toBe(emptyInputSchema);
    expect(researchToolByName('resolve_categories').inputSchema).toBe(resolveCategoriesInputSchema);
    expect(researchToolByName('search_keywords').inputSchema).toBe(searchToolInputSchema);
    expect(researchToolByName('get_keyword_details').inputSchema).toBe(keywordDetailsInputSchema);
    expect(researchToolByName('get_keyword_history').inputSchema).toBe(keywordHistoryInputSchema);
    expect(researchToolByName('search_products').inputSchema).toBe(productSearchInputSchema);
    expect(researchToolByName('get_product_details').inputSchema).toBe(productDetailsInputSchema);
  });
  it('builds the products descriptions from the Products constants, with the units, the badge, the ratio, weeks in top 3 and the admin-only note', () => {
    const search = researchToolByName('search_products').description(DEFAULT_LIMITS);
    expect(search).toContain(`Pages hold ${PRODUCT_PAGE_SIZE} products, page 1 to ${PRODUCT_MAX_PAGE}`);
    expect(search).toContain(`exact below ${PRODUCT_COUNT_CAP.toLocaleString('en-US')}, then at_least`);
    expect(search).toContain('ratings in stars (0–5, one decimal) and prices in US dollars');
    expect(search).toContain('averageRatingX10 (stars × 10');
    expect(search).toContain('currentPriceCents (cents)');
    expect(search).toContain("Amazon's 'bought in past month' floor: 1000 means 1,000+");
    expect(search).toContain('current BSR ÷ 30-day average × 100; 70 = at least 30 % better');
    const details = researchToolByName('get_product_details').description(DEFAULT_LIMITS);
    expect(details).toContain(`the newest ${PRODUCT_TOOL_HISTORY_POINTS} snapshots, oldest first`);
    // pointsTotal stops at the loaded window; keywordsTotal counts everything.
    expect(details).toContain(`pointsTotal counts that window (at most ${PRODUCT_HISTORY_CAP} snapshots)`);
    expect(details).toContain(`keywords: up to ${PRODUCT_TOOL_KEYWORDS_CAP}`);
    expect(details).toContain('keywordsTotal counts every keyword, past the cap too');
    expect(details).toContain('weeks in top 3 = consecutive imported weeks the ASIN has been a top-3 clicked product for that keyword');
    expect(details).toContain('product.inCatalog false: keywords known, no product facts (the title may still come from the keyword side');
    expect(details).not.toContain('every fact is null');
    expect(details).toContain('averageRatingX10 = stars × 10');
    expect(details).toContain('prices are in cents');
    for (const d of [search, details]) expect(d.endsWith('Admin accounts only for now.')).toBe(true);
  });
  it('builds the search description from the operating constants', () => {
    const d = researchToolByName('search_keywords').description({ ...DEFAULT_LIMITS, maxRowsPerSearch: 1234 });
    expect(d).toContain(`up to ${PAGE_SIZE_MAX} rows`);
    expect(d).toContain('1,234 rows are reachable');
  });
  it('run() dispatches to the matching service method with the actor and raw args', async () => {
    const service = {
      guide: vi.fn(async () => ({ g: 1 })), resolveCategories: vi.fn(async () => ({ r: 1 })), search: vi.fn(async () => ({ s: 1 })),
      details: vi.fn(async () => ({ d: 1 })), history: vi.fn(async () => ({ h: 1 })),
      searchProducts: vi.fn(async () => ({ sp: 1 })), productDetails: vi.fn(async () => ({ pd: 1 })),
    } as unknown as ResearchService;
    await expect(researchToolByName('get_research_guide').run(service, actor, {})).resolves.toEqual({ g: 1 });
    await expect(researchToolByName('resolve_categories').run(service, actor, { query: 'x' })).resolves.toEqual({ r: 1 });
    await expect(researchToolByName('search_keywords').run(service, actor, { filters: {} })).resolves.toEqual({ s: 1 });
    await expect(researchToolByName('get_keyword_details').run(service, actor, { searchTermId: 'id' })).resolves.toEqual({ d: 1 });
    await expect(researchToolByName('get_keyword_history').run(service, actor, { searchTermId: 'id', weeks: 4 })).resolves.toEqual({ h: 1 });
    await expect(researchToolByName('search_products').run(service, actor, { sort: 'bsr' })).resolves.toEqual({ sp: 1 });
    await expect(researchToolByName('get_product_details').run(service, actor, { asin: 'B0ABCDEF12' })).resolves.toEqual({ pd: 1 });
    expect(service.guide).toHaveBeenCalledWith(actor);
    expect(service.resolveCategories).toHaveBeenCalledWith(actor, { query: 'x' });
    expect(service.search).toHaveBeenCalledWith(actor, { filters: {} });
    expect(service.details).toHaveBeenCalledWith(actor, { searchTermId: 'id' });
    expect(service.history).toHaveBeenCalledWith(actor, { searchTermId: 'id', weeks: 4 });
    // The definitions never gate on the actor themselves: the service refuses a non-admin (FORBIDDEN).
    expect(service.searchProducts).toHaveBeenCalledWith(actor, { sort: 'bsr' });
    expect(service.productDetails).toHaveBeenCalledWith(actor, { asin: 'B0ABCDEF12' });
  });
  it('every input schema is strict: an unknown key is rejected with unrecognized_keys, never silently dropped', () => {
    for (const t of RESEARCH_TOOLS) {
      const r = t.inputSchema.safeParse({ __probe: 1 });
      expect(r.success, t.name).toBe(false);
      expect(r.success ? [] : r.error.issues.map((i) => i.code), t.name).toContain('unrecognized_keys');
    }
  });
});

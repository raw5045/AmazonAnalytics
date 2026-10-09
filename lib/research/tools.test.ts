// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/env', () => ({ env: {} }));
import { RESEARCH_TOOLS, RESEARCH_TOOL_NAMES, researchToolByName } from './tools';
import { DEFAULT_LIMITS } from './limits';
import { PAGE_SIZE_MAX, searchToolInputSchema, resolveCategoriesInputSchema, keywordDetailsInputSchema, keywordHistoryInputSchema, emptyInputSchema } from './contracts';
import type { ResearchActor, ResearchService } from './service';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'ask-ai', channel: 'chat', isAdmin: false };

describe('RESEARCH_TOOLS', () => {
  it('lists the five tools in the MCP order, read-only, none needing confirmation', () => {
    expect(RESEARCH_TOOL_NAMES).toEqual(['get_research_guide', 'resolve_categories', 'search_keywords', 'get_keyword_details', 'get_keyword_history']);
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
  it('binds each tool to the contracts.ts schema the MCP server has always published', () => {
    expect(researchToolByName('get_research_guide').inputSchema).toBe(emptyInputSchema);
    expect(researchToolByName('resolve_categories').inputSchema).toBe(resolveCategoriesInputSchema);
    expect(researchToolByName('search_keywords').inputSchema).toBe(searchToolInputSchema);
    expect(researchToolByName('get_keyword_details').inputSchema).toBe(keywordDetailsInputSchema);
    expect(researchToolByName('get_keyword_history').inputSchema).toBe(keywordHistoryInputSchema);
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
    } as unknown as ResearchService;
    await expect(researchToolByName('get_research_guide').run(service, actor, {})).resolves.toEqual({ g: 1 });
    await expect(researchToolByName('resolve_categories').run(service, actor, { query: 'x' })).resolves.toEqual({ r: 1 });
    await expect(researchToolByName('search_keywords').run(service, actor, { filters: {} })).resolves.toEqual({ s: 1 });
    await expect(researchToolByName('get_keyword_details').run(service, actor, { searchTermId: 'id' })).resolves.toEqual({ d: 1 });
    await expect(researchToolByName('get_keyword_history').run(service, actor, { searchTermId: 'id', weeks: 4 })).resolves.toEqual({ h: 1 });
    expect(service.guide).toHaveBeenCalledWith(actor);
    expect(service.resolveCategories).toHaveBeenCalledWith(actor, { query: 'x' });
    expect(service.search).toHaveBeenCalledWith(actor, { filters: {} });
    expect(service.details).toHaveBeenCalledWith(actor, { searchTermId: 'id' });
    expect(service.history).toHaveBeenCalledWith(actor, { searchTermId: 'id', weeks: 4 });
  });
  it('every input schema is strict: an unknown key is rejected with unrecognized_keys, never silently dropped', () => {
    for (const t of RESEARCH_TOOLS) {
      const r = t.inputSchema.safeParse({ __probe: 1 });
      expect(r.success, t.name).toBe(false);
      expect(r.success ? [] : r.error.issues.map((i) => i.code), t.name).toContain('unrecognized_keys');
    }
  });
});

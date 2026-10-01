import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('@/lib/env', () => ({ env: {} }));
import { buildAskTools } from './tools';
import { ResearchError } from '@/lib/research/errors';
import { DEFAULT_LIMITS } from '@/lib/research/limits';
import { SAFE_TOOL_FAILURE } from '@/lib/research/toolErrors';
import type { ResearchActor, ResearchService } from '@/lib/research/service';
import { WORKSPACE_TOOL_NAMES } from '@/lib/workspace/contracts';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'ask-ai', channel: 'chat' };
const service = {
  guide: vi.fn(async () => ({ guideVersion: 1 })),
  resolveCategories: vi.fn(async () => ({ candidates: [] })),
  search: vi.fn(async () => { throw new ResearchError('RATE_LIMITED', 'Rate limit reached', { retryable: true, retryAfterSeconds: 9 }); }),
  details: vi.fn(async () => { throw new Error('pg: connection reset'); }),
  history: vi.fn(async () => ({ points: [] })),
} as unknown as ResearchService;

describe('buildAskTools', () => {
  afterEach(() => vi.restoreAllMocks());
  const tools = buildAskTools(service, actor, DEFAULT_LIMITS);
  const exec = (name: string, args: unknown) => (tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, { toolCallId: 't1', messages: [] });

  it('exposes exactly the five research tools with their descriptions', () => {
    expect(Object.keys(tools)).toEqual(['get_research_guide', 'resolve_categories', 'search_keywords', 'get_keyword_details', 'get_keyword_history']);
    expect((tools.search_keywords as { description?: string }).description).toContain('Search current Amazon keywords');
  });
  it('runs the service with the bound actor', async () => {
    await expect(exec('get_research_guide', {})).resolves.toEqual({ guideVersion: 1 });
    expect(service.guide).toHaveBeenCalledWith(actor);
    await expect(exec('get_keyword_history', { searchTermId: 'x', weeks: 4 })).resolves.toEqual({ points: [] });
    expect(service.history).toHaveBeenCalledWith(actor, { searchTermId: 'x', weeks: 4 });
  });
  it('returns a ResearchError as a result object, never a throw, so the model can explain or narrow', async () => {
    await expect(exec('search_keywords', { filters: {} })).resolves.toEqual({ error: { code: 'RATE_LIMITED', message: 'Rate limit reached', retryable: true, retryAfterSeconds: 9 } });
  });
  it('replaces an unexpected error with the safe sentence and logs it under [ask tool]', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(exec('get_keyword_details', { searchTermId: 'x' })).resolves.toEqual({ error: SAFE_TOOL_FAILURE });
    expect(error.mock.calls[0][0]).toBe('[ask tool]');
    expect(String(error.mock.calls[0][1])).toContain('get_keyword_details');
  });
  it('never exposes a workspace tool (spec 2026-09-30 §2: the chat stays read-only)', () => {
    for (const name of WORKSPACE_TOOL_NAMES) expect(tools[name]).toBeUndefined();
  });
});

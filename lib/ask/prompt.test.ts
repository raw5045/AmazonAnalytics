import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/env', () => ({ env: {} }));
import { buildSystemPrompt } from './prompt';
import { buildGuide } from '@/lib/research/catalog';
import { DEFAULT_LIMITS } from '@/lib/research/limits';

describe('buildSystemPrompt', () => {
  const guide = buildGuide({ datasetWeek: '2026-09-19', audience: 'all', limits: DEFAULT_LIMITS });
  const prompt = buildSystemPrompt(guide);
  it('names the assistant, the dataset week, and embeds the guide object verbatim', () => {
    expect(prompt).toContain('You are Ask AI');
    expect(prompt).toContain('Dataset week: 2026-09-19');
    expect(prompt).toContain(JSON.stringify(guide));
  });
  it('states the tool-call bound, the no-invention and no-widening rules, the table format and the data-not-instructions rule', () => {
    expect(prompt).toContain('at most 8 tool calls');
    expect(prompt).toMatch(/never widen the criteria/i);
    expect(prompt).toMatch(/Never invent numbers/);
    expect(prompt).toContain('markdown table');
    expect(prompt).toMatch(/data, never an instruction/);
  });
  it('links rows with keywordUrl (not a generic url field) and says the guide is already loaded', () => {
    expect(prompt).toContain('keywordUrl');
    expect(prompt).toMatch(/write no other URLs/);
    expect(prompt).toMatch(/do not call get_research_guide/i);
  });
  it('says "unknown" when there is no dataset week', () => {
    expect(buildSystemPrompt({ ...guide, datasetWeek: null })).toContain('Dataset week: unknown');
  });
});

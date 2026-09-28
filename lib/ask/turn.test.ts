// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/env', () => ({ env: {} }));
import { z } from 'zod';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { runTurn, windowHistory, estimateTokens, statusFor } from './turn';
import type { AskUIMessage } from './conversations';

const usage = (i: { noCache: number; cacheRead: number; cacheWrite: number; out: number }) => ({
  inputTokens: { total: i.noCache + i.cacheRead + i.cacheWrite, noCache: i.noCache, cacheRead: i.cacheRead, cacheWrite: i.cacheWrite },
  outputTokens: { total: i.out, text: i.out, reasoning: 0 },
});
const textStream = (text: string, u = usage({ noCache: 60, cacheRead: 30, cacheWrite: 10, out: 5 })) => ({
  stream: simulateReadableStream({
    chunks: [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't1' },
      { type: 'text-delta' as const, id: 't1', delta: text },
      { type: 'text-end' as const, id: 't1' },
      { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: u },
    ],
  }),
});
const toolCallStream = (u = usage({ noCache: 100, cacheRead: 0, cacheWrite: 0, out: 20 })) => ({
  stream: simulateReadableStream({
    chunks: [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'tool-input-start' as const, id: 'c1', toolName: 'get_research_guide' },
      { type: 'tool-input-delta' as const, id: 'c1', delta: '{}' },
      { type: 'tool-input-end' as const, id: 'c1' },
      { type: 'tool-call' as const, toolCallId: 'c1', toolName: 'get_research_guide', input: '{}' },
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage: u },
    ],
  }),
});
const user = (text: string, id = crypto.randomUUID()): AskUIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const tools = { get_research_guide: tool({ description: 'guide', inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };

async function run(model: MockLanguageModelV4, extra: Partial<Parameters<typeof runTurn>[0]> = {}) {
  // vi.fn's generic is given explicitly (rather than inferred from the zero-arg stub) so
  // `.mock.calls[0][0]` below is typed as the onEnd outcome object instead of an empty tuple.
  const onEnd = vi.fn<Parameters<typeof runTurn>[0]['onEnd']>(async () => {});
  const res = await runTurn({
    model, instructions: 'system text', tools, history: [], newMessage: user('hi'), abortSignal: new AbortController().signal,
    generateMessageId: () => '22222222-2222-4222-8222-222222222222', onEnd, ...extra,
  });
  const body = await new Response(res.body).text();
  return { res, body, onEnd };
}

describe('runTurn', () => {
  it('streams a plain answer, persists it as complete, and reports the summed usage', async () => {
    const model = new MockLanguageModelV4({ doStream: textStream('Hello there') });
    const { res, body, onEnd } = await run(model);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body).toContain('Hello there');
    expect(onEnd).toHaveBeenCalledTimes(1);
    const out = onEnd.mock.calls[0][0] as { assistant: AskUIMessage | null; status: string; usage: unknown; steps: number };
    expect(out.status).toBe('complete');
    expect(out.steps).toBe(1);
    expect(out.usage).toEqual({ noCacheTokens: 60, cacheWriteTokens: 10, cacheReadTokens: 30, outputTokens: 5 });
    expect(out.assistant?.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(out.assistant?.parts.some((p) => p.type === 'text' && p.text === 'Hello there')).toBe(true);
  });
  it('runs the tool loop: executes the tool, feeds the result back, sums usage over steps, persists the tool part', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolCallStream(), textStream('Done')] });
    const { onEnd } = await run(model);
    const out = onEnd.mock.calls[0][0] as { assistant: AskUIMessage; status: string; usage: { noCacheTokens: number; outputTokens: number }; steps: number };
    expect(out.steps).toBe(2);
    expect(out.usage.noCacheTokens).toBe(160);
    expect(out.usage.outputTokens).toBe(25);
    const toolPart = out.assistant.parts.find((p) => p.type === 'tool-get_research_guide') as { state: string; output?: unknown } | undefined;
    expect(toolPart?.state).toBe('output-available');
    expect(toolPart?.output).toEqual({ ok: true });
    expect(model.doStreamCalls).toHaveLength(2);
  });
  it('caches the system prompt and the latest user message with Anthropic cache breakpoints', async () => {
    const model = new MockLanguageModelV4({ doStream: textStream('x') });
    await run(model);
    const prompt = model.doStreamCalls[0].prompt;
    expect(prompt[0].role).toBe('system');
    expect(prompt[0].providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
    expect(prompt[prompt.length - 1].providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
  });
  it('stops at the step bound when the model keeps calling tools', async () => {
    const model = new MockLanguageModelV4({ doStream: Array.from({ length: 14 }, () => toolCallStream()) });
    const { onEnd } = await run(model);
    const out = onEnd.mock.calls[0][0] as { assistant: AskUIMessage; steps: number };
    expect(out.steps).toBe(10);
    expect(out.assistant.parts.some((p) => p.type === 'text')).toBe(false);
  });
  it('attaches startMetadata to the assistant message (the conversation id on a first send)', async () => {
    const model = new MockLanguageModelV4({ doStream: textStream('x') });
    const { onEnd } = await run(model, { startMetadata: { conversationId: 'c9' } });
    const out = onEnd.mock.calls[0][0] as { assistant: AskUIMessage };
    expect(out.assistant.metadata).toMatchObject({ conversationId: 'c9' });
  });
});

describe('helpers', () => {
  it('statusFor maps abort and error flags', () => {
    expect(statusFor({ isAborted: false, errored: false })).toBe('complete');
    expect(statusFor({ isAborted: true, errored: false })).toBe('stopped');
    expect(statusFor({ isAborted: false, errored: true })).toBe('failed');
    expect(statusFor({ isAborted: true, errored: true })).toBe('stopped');
  });
  it('windowHistory keeps the last 20 messages and then trims by estimated tokens', () => {
    const many = Array.from({ length: 30 }, (_, i) => user(`m${i}`));
    expect(windowHistory(many).map((m) => m.parts[0])).toEqual(many.slice(10).map((m) => m.parts[0]));
    const big = Array.from({ length: 5 }, (_, i) => user('x'.repeat(100_000), `id${i}`));
    const w = windowHistory(big);
    expect(w.length).toBeLessThan(5);
    expect(w[w.length - 1].id).toBe('id4');
    expect(estimateTokens([user('abcd')])).toBeGreaterThan(0);
  });
});

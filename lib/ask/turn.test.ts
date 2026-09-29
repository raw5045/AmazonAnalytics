// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/env', () => ({ env: {} }));
import { z } from 'zod';
import { simulateReadableStream, tool, APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { runTurn, windowHistory, estimateTokens, statusFor, TURN_DEADLINE } from './turn';
import { BUSY_LINE, PROBLEM_LINE } from './messages';
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
const assistantMsg = (id: string, text = 'a'): AskUIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] });
const tools = { get_research_guide: tool({ description: 'guide', inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };

async function run(model: MockLanguageModelV4, extra: Partial<Parameters<typeof runTurn>[0]> = {}) {
  // vi.fn's generic is given explicitly (rather than inferred from the zero-arg stub) so
  // `.mock.calls[0][0]` below is typed as the onEnd outcome object instead of an empty tuple.
  const onEnd = vi.fn<Parameters<typeof runTurn>[0]['onEnd']>(async () => {});
  const res = await runTurn({
    model, modelId: 'claude-sonnet-5', instructions: 'system text', tools, history: [], newMessage: user('hi'), abortSignal: new AbortController().signal,
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
    const out = onEnd.mock.calls[0][0] as { assistant: AskUIMessage; status: string; usage: { noCacheTokens: number; outputTokens: number }; steps: number; finishReason?: string };
    expect(out.steps).toBe(2);
    expect(out.usage.noCacheTokens).toBe(160);
    expect(out.usage.outputTokens).toBe(25);
    expect(out.finishReason).toBe('stop');
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
    const out = onEnd.mock.calls[0][0] as { assistant: AskUIMessage; steps: number; finishReason?: string };
    expect(out.steps).toBe(10);
    expect(out.finishReason).toBe('tool-calls');
    expect(model.doStreamCalls.length).toBe(10);
    expect(out.assistant.parts.some((p) => p.type === 'text')).toBe(false);
  });
  it('attaches startMetadata to the assistant message (the conversation id on a first send)', async () => {
    const model = new MockLanguageModelV4({ doStream: textStream('x') });
    const { onEnd } = await run(model, { startMetadata: { conversationId: 'c9' } });
    const out = onEnd.mock.calls[0][0] as { assistant: AskUIMessage };
    expect(out.assistant.metadata).toMatchObject({ conversationId: 'c9' });
  });
  it('sends the low-effort provider option for Sonnet and Opus 5.5 but not for Haiku 4.5 (Haiku rejects it)', async () => {
    const sonnet = new MockLanguageModelV4({ doStream: textStream('x') });
    await run(sonnet, { modelId: 'claude-sonnet-5' });
    expect(sonnet.doStreamCalls[0].providerOptions).toEqual({ anthropic: { effort: 'low' } });

    const opus = new MockLanguageModelV4({ doStream: textStream('x') });
    await run(opus, { modelId: 'claude-opus-5-5' });
    expect(opus.doStreamCalls[0].providerOptions).toEqual({ anthropic: { effort: 'low' } });

    const haiku = new MockLanguageModelV4({ doStream: textStream('x') });
    await run(haiku, { modelId: 'claude-haiku-4-5' });
    expect(haiku.doStreamCalls[0].providerOptions?.anthropic).toBeUndefined();
  });
  it('never streams or stores a reasoning part (a replayed signature can 400 on the next turn)', async () => {
    const withReasoning = () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'reasoning-start' as const, id: 'r1' },
          { type: 'reasoning-delta' as const, id: 'r1', delta: 'thinking...' },
          { type: 'reasoning-end' as const, id: 'r1' },
          { type: 'text-start' as const, id: 't1' },
          { type: 'text-delta' as const, id: 't1', delta: 'answer' },
          { type: 'text-end' as const, id: 't1' },
          { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: usage({ noCache: 60, cacheRead: 0, cacheWrite: 0, out: 5 }) },
        ],
      }),
    });
    const model = new MockLanguageModelV4({ doStream: withReasoning() });
    const { body, onEnd } = await run(model);
    expect(body).not.toContain('"type":"reasoning');
    const out = onEnd.mock.calls[0][0] as { assistant: AskUIMessage };
    expect(out.assistant.parts.some((p) => p.type === 'reasoning')).toBe(false);
    expect(out.assistant.parts.some((p) => p.type === 'text' && p.text === 'answer')).toBe(true);
  });
  it('an invalid tool call input (fails the tool schema) becomes a tool-error part and the turn still completes', async () => {
    const badTools = { get_keyword_details: tool({ description: 'details', inputSchema: z.object({ searchTermId: z.string() }), execute: async () => ({ ok: true }) }) };
    const badToolCallStream = () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'tool-input-start' as const, id: 'c1', toolName: 'get_keyword_details' },
          { type: 'tool-input-delta' as const, id: 'c1', delta: '{"searchTermId": 42}' },
          { type: 'tool-input-end' as const, id: 'c1' },
          { type: 'tool-call' as const, toolCallId: 'c1', toolName: 'get_keyword_details', input: '{"searchTermId": 42}' },
          { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage: usage({ noCache: 100, cacheRead: 0, cacheWrite: 0, out: 20 }) },
        ],
      }),
    });
    const model = new MockLanguageModelV4({ doStream: [badToolCallStream(), textStream('ok')] });
    const onEnd = vi.fn<Parameters<typeof runTurn>[0]['onEnd']>(async () => {});
    const res = await runTurn({
      model, modelId: 'claude-sonnet-5', instructions: 'system text', tools: badTools, history: [], newMessage: user('hi'), abortSignal: new AbortController().signal,
      generateMessageId: () => 'a1', onEnd,
    });
    await new Response(res.body).text();
    const out = onEnd.mock.calls[0][0] as { assistant: AskUIMessage; status: string };
    expect(out.status).toBe('complete');
    const toolPart = out.assistant.parts.find((p) => p.type === 'tool-get_keyword_details') as { state: string } | undefined;
    expect(toolPart?.state).toBe('output-error');
  });
  it('a throwing onEnd is caught and logged, never rejecting the response stream', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const model = new MockLanguageModelV4({ doStream: textStream('hi there') });
    const onEnd = vi.fn(async () => { throw new Error('db down'); });
    const res = await runTurn({
      model, modelId: 'claude-sonnet-5', instructions: 'system text', tools, history: [], newMessage: user('hi'), abortSignal: new AbortController().signal,
      generateMessageId: () => 'a1', onEnd,
    });
    await expect(new Response(res.body).text()).resolves.toContain('hi there');
    const line = log.mock.calls.find((c) => c[0] === '[ask turn]');
    expect(line).toBeDefined();
    const logged = JSON.parse(line![1] as string) as { outcome?: string; error?: string; detail?: string };
    expect(logged).toMatchObject({ outcome: 'on_end_threw', error: 'Error', detail: 'db down' });
    log.mockRestore();
  });
});

describe('runTurn — stop, abort, provider errors', () => {
  /** A text answer streamed slowly enough that a test can interrupt it mid-way. */
  const slowText = (words: string[]) => ({
    stream: simulateReadableStream({
      initialDelayInMs: 0,
      chunkDelayInMs: 20,
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        { type: 'text-start' as const, id: 't1' },
        ...words.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
        { type: 'text-end' as const, id: 't1' },
        { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: usage({ noCache: 60, cacheRead: 0, cacheWrite: 0, out: 5 }) },
      ],
    }),
  });
  async function readUntil(body: ReadableStream<Uint8Array>, needle: string) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
    return { reader, seen };
  }
  function start(model: MockLanguageModelV4, controller = new AbortController()) {
    const onEnd = vi.fn<Parameters<typeof runTurn>[0]['onEnd']>(async () => {});
    const res = runTurn({
      model, modelId: 'claude-sonnet-5', instructions: 'system text', tools, history: [], newMessage: user('hi'), abortSignal: controller.signal,
      generateMessageId: () => '22222222-2222-4222-8222-222222222222', onEnd,
    });
    return { res, onEnd, controller };
  }

  it('a cancelled body (Stop or a closed tab) is stopped: keeps the partial answer and settles only completed steps', async () => {
    const t = start(new MockLanguageModelV4({ doStream: [toolCallStream(), slowText(['Hello ', 'there ', 'friend ', 'again'])] }));
    const { reader } = await readUntil((await t.res).body!, '"delta":"Hello ');
    await reader.cancel();
    await vi.waitFor(() => expect(t.onEnd).toHaveBeenCalledTimes(1));
    const out = t.onEnd.mock.calls[0][0];
    expect(out.steps).toBe(1); // the tool step; the interrupted answer step reports no usage (absorbed, spec §6)
    expect(out.usage.noCacheTokens).toBe(100);
    expect(out.assistant?.parts.some((p) => p.type === 'tool-get_research_guide')).toBe(true);
    expect(out.assistant?.parts.some((p) => p.type === 'text' && p.text.startsWith('Hello'))).toBe(true);
    expect(out.status).toBe('stopped');
  });

  it('the turn deadline aborts with stopReason "deadline" (the route aborts with new Error(TURN_DEADLINE), matched by that exact sentinel, not a /deadline/ regex)', async () => {
    const t = start(new MockLanguageModelV4({ doStream: slowText(['Hello ', 'there ', 'friend ', 'again']) }));
    const { reader, seen } = await readUntil((await t.res).body!, '"delta":"Hello ');
    t.controller.abort(new Error(TURN_DEADLINE));
    let rest = seen;
    for (;;) { const { value, done } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    expect(rest).toContain('"type":"abort"');
    expect(rest).toContain('"stopReason":"deadline"');
    const out = t.onEnd.mock.calls[0][0];
    expect(out).toMatchObject({ status: 'stopped', steps: 0 });
    expect(out.assistant?.parts.some((p) => p.type === 'text' && p.text === 'Hello ')).toBe(true);
  });

  it('a member-initiated abort (Stop via the request signal) with any other reason gets stopReason "user"', async () => {
    const t = start(new MockLanguageModelV4({ doStream: slowText(['Hello ', 'there ', 'friend ', 'again']) }));
    const { reader, seen } = await readUntil((await t.res).body!, '"delta":"Hello ');
    t.controller.abort(new Error('client disconnected'));
    let rest = seen;
    for (;;) { const { value, done } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    expect(rest).toContain('"stopReason":"user"');
    expect(t.onEnd.mock.calls[0][0]).toMatchObject({ status: 'stopped' });
  });

  it('a provider failure before any output is failed, stores nothing, never leaks the provider text, and logs under [ask turn]', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = start(new MockLanguageModelV4({ doStream: async () => { throw new Error('upstream detail sk-ant-xyz'); } }));
    const body = await new Response((await t.res).body).text();
    expect(body).toContain('"type":"error"');
    expect(body).not.toContain('upstream detail');
    expect(body).toContain(PROBLEM_LINE);
    expect(t.onEnd.mock.calls[0][0]).toMatchObject({ assistant: null, status: 'failed', steps: 0 });
    expect(log.mock.calls[0][0]).toBe('[ask turn]');
    log.mockRestore();
  });

  it('a mid-stream provider error with no text or tool output stores nothing (spec §12)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = start(new MockLanguageModelV4({
      doStream: { stream: simulateReadableStream({ chunks: [{ type: 'stream-start' as const, warnings: [] }, { type: 'error' as const, error: { type: 'overloaded_error', message: 'Overloaded' } }] }) },
    }));
    await new Response((await t.res).body).text();
    const out = t.onEnd.mock.calls[0][0];
    expect(out.status).toBe('failed');
    expect(out.assistant).toBeNull();
    log.mockRestore();
  });

  it('a 529 provider error maps to the busy line and logs the statusCode', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = start(new MockLanguageModelV4({
      doStream: async () => { throw new APICallError({ message: 'Overloaded', url: 'https://api.anthropic.com/v1/messages', requestBodyValues: {}, statusCode: 529, isRetryable: false }); },
    }));
    const body = await new Response((await t.res).body).text();
    expect(body).toContain(BUSY_LINE);
    expect(body).not.toContain(PROBLEM_LINE);
    const logged = JSON.parse(log.mock.calls[0][1] as string) as { statusCode?: number };
    expect(logged.statusCode).toBe(529);
    log.mockRestore();
  });

  it('caps a long model-error message in the log at 300 characters', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = start(new MockLanguageModelV4({ doStream: async () => { throw new Error('x'.repeat(500)); } }));
    await new Response((await t.res).body).text();
    const logged = JSON.parse(log.mock.calls[0][1] as string) as { message?: string };
    expect(logged.message?.length).toBe(300);
    log.mockRestore();
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
  it('windowHistory never starts the window on an assistant message (Anthropic requires a leading user turn)', () => {
    // 12 turns; turn 5 failed with no output (spec §12: nothing stored) -> a lone user message there.
    const h: AskUIMessage[] = [];
    for (let i = 1; i <= 12; i++) { h.push(user(`q${i}`, `u${i}`)); if (i !== 5) h.push(assistantMsg(`a${i}`)); }
    expect(windowHistory(h)[0].role).toBe('user');
  });
});

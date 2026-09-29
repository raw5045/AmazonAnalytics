import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAskTransport } from './transport';
import type { AskUIMessage } from './conversations';

const userMessage = (text: string): AskUIMessage => ({ id: 'm1', role: 'user', parts: [{ type: 'text', text }] });

/** Drives the transport the same way useChat does; only the fetch call this produces is under test. */
async function send(body: Record<string, unknown>, messages: AskUIMessage[]) {
  const transport = createAskTransport();
  await transport
    .sendMessages({ trigger: 'submit-message', chatId: 'c', messageId: undefined, messages, abortSignal: undefined, body })
    .catch(() => {});
}

describe('createAskTransport', () => {
  beforeEach(() => {
    // Restore first: vi.spyOn on an already-spied function reuses the same mock and its
    // accumulated call history, which would leak the previous test's fetch call into this one.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream(), { status: 200 }));
  });

  it('sends exactly conversationId, model and message.text on a first send — no id/messages/trigger/messageId', async () => {
    await send({ conversationId: null, model: 'claude-opus-5-5' }, [userMessage('hi')]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/ask/chat');
    expect(JSON.parse(init?.body as string)).toEqual({ conversationId: null, model: 'claude-opus-5-5', message: { text: 'hi' } });
  });

  it('sends no model key at all on a follow-up', async () => {
    await send({ conversationId: 'c1' }, [userMessage('hi')]);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({ conversationId: 'c1', message: { text: 'hi' } });
  });

  it('sends only the last user message text, not the full history', async () => {
    await send({ conversationId: 'c1' }, [userMessage('first'), { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] }, userMessage('second')]);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({ conversationId: 'c1', message: { text: 'second' } });
  });
});

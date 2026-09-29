import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
import { Thread } from './Thread';

/**
 * Drives the REAL @ai-sdk/react `useChat` and `lib/ask/transport`'s `createAskTransport` against a
 * mocked SSE `fetch` — no `@ai-sdk/react` mock in this file, unlike Thread.test.tsx, which covers
 * the fast mocked-hook cases but cannot prove the wiring against the actual wire protocol. Adapted
 * from the code reviewer's probe (scratchpad/t9cr/repo/app/(app)/ask/__probe__/threadLive.test.tsx,
 * Task 9 fix round, item 1), which verified these two scenarios against the real hook first.
 */
const enc = new TextEncoder();
const sse = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);

/** A fetch mock whose body emits `chunks` then either closes (a normal end) or stays open (a Stop mid-stream). */
function mockStream(chunks: unknown[], opts: { hang?: boolean } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(sse(ch));
        if (!opts.hang) { c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); }
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}
const START_NEW = { type: 'start', messageId: 'a1', messageMetadata: { conversationId: '11111111-1111-4111-8111-111111111111' } };
const START_OPEN = { type: 'start', messageId: 'a1' };
const openConversation = { id: 'c1', model: 'claude-sonnet-5' as const, messageCount: 0, messages: [], inFlightSince: null };
const appOrigin = 'https://keywordquarry.com';

/** Stands in for AskAi's lifted draft state (item 8) — Thread no longer owns it. */
function Harness(props: Omit<React.ComponentProps<typeof Thread>, 'draft' | 'onDraftChange'>) {
  const [draft, setDraft] = useState('');
  return <Thread {...props} draft={draft} onDraftChange={setDraft} />;
}

async function typeAndSend(text: string) {
  fireEvent.change(screen.getByLabelText('Your question'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

describe('Thread with the real useChat (mocked SSE fetch)', () => {
  beforeEach(() => { vi.restoreAllMocks(); router.replace.mockClear(); router.refresh.mockClear(); });
  afterEach(() => cleanup());

  it('a member Stop mid-answer shows "Stopped." live, in an open chat', async () => {
    mockStream([START_OPEN, { type: 'start-step' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'partial answer' }], { hang: true });
    render(<Harness open={openConversation} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
    await typeAndSend('hi');
    await screen.findByText('partial answer');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    await waitFor(() => expect(screen.getByText('Stopped.')).toBeInTheDocument());
  });

  it('a first send streams text and onFinish moves the URL to the new chat (replace only, per M4)', async () => {
    mockStream([
      START_NEW, { type: 'start-step' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'the answer' }, { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    render(<Harness open={null} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
    await typeAndSend('hi');
    await screen.findByText('the answer');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/ask?c=11111111-1111-4111-8111-111111111111'));
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

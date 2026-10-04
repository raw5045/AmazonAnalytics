import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
import { Thread } from './Thread';
import { AskAi } from './AskAi';

/**
 * Drives the REAL @ai-sdk/react `useChat` and `lib/ask/transport`'s `createAskTransport` against a
 * mocked SSE `fetch` — no `@ai-sdk/react` mock in this file, unlike Thread.test.tsx, which covers
 * the fast mocked-hook cases but cannot prove the wiring against the actual wire protocol. Adapted
 * from the code reviewer's probes (scratchpad/t9cr/repo/.../threadLive.test.tsx, Task 9 fix round,
 * item 1; scratchpad/t9cr/fix/.../reReview.test.tsx case R3, Task 9 fix round 2, item 3).
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
/** A fetch that never answers until the request is aborted — Stop before the first chunk (R3). */
function mockPendingUntilAbort() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    const signal = (init as RequestInit).signal;
    signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  }));
}
const START_NEW = { type: 'start', messageId: 'a1', messageMetadata: { conversationId: '11111111-1111-4111-8111-111111111111' } };
const START_OPEN = { type: 'start', messageId: 'a1' };
const openConversation = { id: 'c1', model: 'claude-sonnet-5' as const, messageCount: 0, messages: [], inFlight: false };
const appOrigin = 'https://keywordquarry.com';

/** Stands in for AskAi's lifted draft state (item 8) — Thread no longer owns it. */
function Harness(props: Omit<React.ComponentProps<typeof Thread>, 'draft' | 'onDraftChange' | 'writesEnabled'> & { writesEnabled?: boolean }) {
  const [draft, setDraft] = useState('');
  return <Thread writesEnabled {...props} draft={draft} onDraftChange={setDraft} />;
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
    render(<Harness open={openConversation} defaultModel="claude-sonnet-5" cantSendReason={null} atCap={false} appOrigin={appOrigin} />);
    await typeAndSend('hi');
    await screen.findByText('partial answer');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    await waitFor(() => expect(screen.getByText('Stopped.')).toBeInTheDocument());
  });

  it('R3: Stop before any response arrives (still "submitted") shows STOPPED_LINE at the bottom, not a per-message line', async () => {
    mockPendingUntilAbort();
    render(<Harness open={openConversation} defaultModel="claude-sonnet-5" cantSendReason={null} atCap={false} appOrigin={appOrigin} />);
    await typeAndSend('hi');
    await screen.findByRole('button', { name: 'Stop' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    await waitFor(() => expect(screen.getByText('Stopped.')).toBeInTheDocument());
    // No assistant message shell was ever shown — the line is the bottom-of-thread fallback, not
    // attached to an <article> (item 3 / N3: onFinish's message id never made it into `messages`).
    expect(screen.queryAllByLabelText('Ask AI')).toHaveLength(0);
  });

  it('a first send streams text and onFinish moves the URL to the new chat (replace only, per M4)', async () => {
    mockStream([
      START_NEW, { type: 'start-step' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'the answer' }, { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    render(<Harness open={null} defaultModel="claude-sonnet-5" cantSendReason={null} atCap={false} appOrigin={appOrigin} />);
    await typeAndSend('hi');
    await screen.findByText('the answer');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/ask?c=11111111-1111-4111-8111-111111111111', { scroll: false }));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('M1: a recovery resend after a first-send stream error still moves the URL once it succeeds (reviewer case S8, extended)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockImplementationOnce(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of [START_NEW, { type: 'start-step' }, { type: 'error', errorText: 'The AI is busy, try again in a moment.' }]) c.enqueue(sse(ch));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    spy.mockImplementationOnce(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of [{ type: 'start', messageId: 'a2' }, { type: 'start-step' }, { type: 'text-start', id: 'u' }, { type: 'text-delta', id: 'u', delta: 'recovered answer' }, { type: 'text-end', id: 'u' }, { type: 'finish', finishReason: 'stop' }]) c.enqueue(sse(ch));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    render(<Harness open={null} defaultModel="claude-sonnet-5" cantSendReason={null} atCap={false} appOrigin={appOrigin} />);
    await typeAndSend('first');
    await screen.findByRole('alert');
    // the recovery link is the same id the resend below should eventually navigate to
    expect(screen.getByRole('link', { name: 'Open this chat' })).toHaveAttribute('href', '/ask?c=11111111-1111-4111-8111-111111111111');
    expect(router.replace).not.toHaveBeenCalled(); // item 3: no auto-navigation on the error itself
    // the first send's own stream-embedded error (unrelated to M1/M2 — no HTTP refusal, no onError
    // involvement at all) legitimately triggers one refresh via onFinish's isError branch; only the
    // calls made AFTER this point are what the resend itself is responsible for.
    const refreshesBeforeResend = router.refresh.mock.calls.length;
    await typeAndSend('again');
    await screen.findByText('recovered answer');
    // this resend's own message carries no conversationId (the server treats it as an ordinary
    // follow-up, since the request already named the chat) — the fallback to the id learned from
    // the earlier, errored attempt is what M1 adds.
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/ask?c=11111111-1111-4111-8111-111111111111', { scroll: false }));
    expect(router.refresh.mock.calls.length).toBe(refreshesBeforeResend);
  });
});

describe('approval cards with the real useChat (arc 4, spec 2026-10-01 §5, §6)', () => {
  beforeEach(() => { vi.restoreAllMocks(); router.replace.mockClear(); router.refresh.mockClear(); });
  afterEach(() => cleanup());

  const cardPart = (approvalId: string, tool = 'create_saved_view', input: unknown = { name: 'Lamps', search: {} }) => ({ type: `tool-${tool}`, toolCallId: `call-${approvalId}`, state: 'approval-requested', input, approval: { id: approvalId } });
  /** A stored chat whose last answer paused on the given cards, as page.tsx hands it over. */
  const pausedChat = (...cards: unknown[]) => ({
    ...openConversation,
    messageCount: 2,
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'save it' }], metadata: { status: 'complete' } },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Saving.' }, ...cards], metadata: { status: 'complete' } },
    ] as never,
  });
  const RESUMED = [{ type: 'start', messageId: 'a2' }, { type: 'start-step' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Saved the view.' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop' }];
  type ChatReply = { chunks: unknown[] } | { status: number; body?: unknown } | { network: true };
  /**
   * The chat route answers each request with the next reply (the last one repeats): a stream, a
   * refusal (bodyless, or the route's JSON), or a network failure. The two list routes answer the
   * card's name lookup.
   */
  function mockRoutes(...replies: ChatReply[]) {
    let call = 0;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url === '/api/explorer/saved-views') return Response.json({ views: [] });
      if (url === '/api/category-builder/custom') return Response.json({ categories: [] });
      const reply = replies[Math.min(call++, replies.length - 1)];
      if ('network' in reply) throw new TypeError('Failed to fetch');
      if ('status' in reply) return reply.body === undefined ? new Response(null, { status: reply.status }) : Response.json(reply.body, { status: reply.status });
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of reply.chunks) c.enqueue(sse(ch));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
  }
  const SETUP_FAILED = { status: 503, body: { error: 'Something went wrong on our side. Try again in a minute.', code: 'setup_failed' } };
  const BUSY = { status: 409, body: { error: 'Wait for the current answer to finish.', code: 'busy' } };
  const watchlistCard = () => cardPart('ap_2', 'add_to_watchlist', { keywords: ['desk lamp'], searchTermIds: [] });
  /** useChat re-renders its messages on a 50 ms throttle: past it, the rendered parts are the SDK's own. */
  const pastThrottle = () => act(async () => { await new Promise((r) => setTimeout(r, 120)); });
  const chatBodies = (spy: ReturnType<typeof mockRoutes>) => spy.mock.calls.filter(([url]) => url === '/api/ask/chat').map(([, init]) => JSON.parse((init as RequestInit).body as string));
  const props = { defaultModel: 'claude-sonnet-5' as const, cantSendReason: null, atCap: false, appOrigin };

  it('an answer sends only the chat id and the answers, and the resumed answer arrives as a NEW message after the card — the shape a reload shows', async () => {
    const spy = mockRoutes({ chunks: RESUMED });
    render(<Harness open={pausedChat(cardPart('ap_1'))} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
    await screen.findByText('Saved the view.');
    expect(chatBodies(spy)).toEqual([{ conversationId: 'c1', approvals: [{ approvalId: 'ap_1', approved: true, remember: 'chat' }] }]);
    const answers = screen.getAllByLabelText('Ask AI');
    expect(answers).toHaveLength(2);
    expect(answers[0]).toHaveTextContent('Approved for this chat');
    expect(answers[0]).not.toHaveTextContent('Saved the view.');
    expect(answers[1]).toHaveTextContent('Saved the view.');
    expect(screen.getAllByLabelText('You')).toHaveLength(1); // the hidden placeholder is never shown
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(screen.queryByText('No answer was saved for this question. Try asking again.')).toBeNull();
  });

  it('two cards: answering one sends nothing; answering the other sends both answers in part order — after the SDK has already marked the first one answered', async () => {
    const spy = mockRoutes({ chunks: RESUMED });
    render(<Harness open={pausedChat(cardPart('ap_1'), cardPart('ap_2', 'add_to_watchlist', { keywords: ['desk lamp'], searchTermIds: [] }))} {...props} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Deny' })[1]);
    expect(screen.getAllByRole('button', { name: 'Deny' })).toHaveLength(1);
    // Past useChat's 50 ms render throttle, so the rendered part is the SDK's own approval-responded one.
    await new Promise((r) => setTimeout(r, 120));
    expect(chatBodies(spy)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
    await screen.findByText('Saved the view.');
    expect(chatBodies(spy)).toEqual([{ conversationId: 'c1', approvals: [{ approvalId: 'ap_1', approved: true, remember: 'chat' }, { approvalId: 'ap_2', approved: false, remember: null }] }]);
  });

  it('a refused resend (the card is no longer open: bodyless 404) shows the chat-gone line, keeps the record with no buttons, and leaves the draft empty', async () => {
    mockRoutes({ status: 404 });
    render(<Harness open={pausedChat(cardPart('ap_1'))} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This chat is no longer available. Reload the page.');
    await pastThrottle();
    expect(screen.getByText('Approved for this chat')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(screen.getByLabelText('Your question')).toHaveValue('');
    expect(screen.queryByText(/approval-result/)).toBeNull();
  });

  it('a resend refused before anything streamed (503) reopens the card with no stale record; one more click sends the same body, and the resumed answer is a new message', async () => {
    const spy = mockRoutes(SETUP_FAILED, { chunks: RESUMED });
    render(<Harness open={pausedChat(cardPart('ap_1'))} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side. Try again in a minute.');
    await pastThrottle();
    expect(screen.queryByText('Approved for this chat')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
    await screen.findByText('Saved the view.');
    const body = { conversationId: 'c1', approvals: [{ approvalId: 'ap_1', approved: true, remember: 'chat' }] };
    expect(chatBodies(spy)).toEqual([body, body]);
    const answers = screen.getAllByLabelText('Ask AI');
    expect(answers).toHaveLength(2);
    expect(answers[0]).toHaveTextContent('Approved for this chat');
    expect(answers[1]).toHaveTextContent('Saved the view.');
    expect(screen.getAllByLabelText('You')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('two cards and a 409: both reopen, and answering them again sends both answers in part order', async () => {
    const spy = mockRoutes(BUSY, { chunks: RESUMED });
    render(<Harness open={pausedChat(cardPart('ap_1'), watchlistCard())} {...props} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Deny' })[1]);
    await pastThrottle();
    fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait for the current answer to finish.');
    await pastThrottle();
    expect(screen.getAllByRole('button', { name: 'Deny' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Deny' })[1]);
    await pastThrottle();
    fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
    await screen.findByText('Saved the view.');
    const both = { conversationId: 'c1', approvals: [{ approvalId: 'ap_1', approved: true, remember: 'chat' }, { approvalId: 'ap_2', approved: false, remember: null }] };
    expect(chatBodies(spy)).toEqual([both, both]);
  });

  it('a resend refused with 400 (the server\'s open cards differ from this tab\'s) keeps the record with no buttons and shows the chat-gone line: only a reload resyncs', async () => {
    mockRoutes({ status: 400, body: { error: 'Bad request.', code: 'bad_request' } });
    render(<Harness open={pausedChat(cardPart('ap_1'))} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This chat is no longer available. Reload the page.');
    await pastThrottle();
    expect(screen.getByText('Approved for this chat')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(screen.queryByText(/approval-result/)).toBeNull();
  });

  it('a resend that STREAMED and then failed keeps its records and its partial answer: the server stored the answers before it streamed, so nothing reopens', async () => {
    mockRoutes({ chunks: [{ type: 'start', messageId: 'a2' }, { type: 'start-step' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Saving the view' }, { type: 'error', errorText: 'The AI hit a problem. Try again in a minute.' }] });
    const onAlwaysApproved = vi.fn();
    render(<Harness open={pausedChat(cardPart('ap_1'))} {...props} onAlwaysApproved={onAlwaysApproved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Always approve changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The AI hit a problem. Try again in a minute.');
    await pastThrottle();
    expect(screen.getByText('Always approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(screen.getByText('Saving the view')).toBeInTheDocument();
    expect(onAlwaysApproved).toHaveBeenCalledTimes(1);
    expect(onAlwaysApproved).toHaveBeenCalledWith('changes');
  });

  it('"Always approve" refused (503) and then accepted turns the switch on exactly once', async () => {
    mockRoutes(SETUP_FAILED, { chunks: RESUMED });
    const onAlwaysApproved = vi.fn();
    render(<Harness open={pausedChat(cardPart('ap_1'))} {...props} onAlwaysApproved={onAlwaysApproved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Always approve changes' }));
    await screen.findByRole('alert');
    await pastThrottle();
    expect(onAlwaysApproved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Always approve changes' }));
    await screen.findByText('Saved the view.');
    await waitFor(() => expect(onAlwaysApproved).toHaveBeenCalledTimes(1));
    expect(onAlwaysApproved).toHaveBeenCalledWith('changes');
  });

  it('a refused NEW send (409 busy) while a card is open: the message goes back into the draft and the card keeps its buttons (useChat stays in its error state)', async () => {
    mockRoutes(BUSY);
    render(<Harness open={pausedChat(cardPart('ap_1'))} {...props} />);
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'never mind' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait for the current answer to finish.');
    await pastThrottle();
    expect(screen.getByLabelText('Your question')).toHaveValue('never mind');
    expect(screen.queryByText('Denied')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeEnabled();
  });

  it('a resend lost on the network reopens the card; a new message after it then denies it ("Denied")', async () => {
    const ANSWER = [{ type: 'start', messageId: 'a3' }, { type: 'start-step' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Here are some lamps.' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop' }];
    const spy = mockRoutes({ network: true }, { chunks: ANSWER });
    render(<Harness open={pausedChat(cardPart('ap_1'))} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side. Try again in a minute.');
    await pastThrottle();
    expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'never mind, show me lamps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Here are some lamps.');
    expect(screen.getByText('Denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve for this chat' })).toBeNull();
    expect(chatBodies(spy)[1]).toEqual({ conversationId: 'c1', message: { text: 'never mind, show me lamps' } });
  });
});

describe('AskAi + Thread: a refresh during the member\'s own streaming turn must not abort it (B1, Task 9 round-2 re-review)', () => {
  afterEach(() => cleanup());

  it('deleting another chat mid-stream — the rail\'s router.refresh() lands a server render that reports inFlight: true for THIS turn\'s own lock — leaves the stream running', async () => {
    let chatSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u, init) => {
      if (String(u).startsWith('/api/ask/conversations/')) return new Response(null, { status: 204 }); // the Rail delete call
      chatSignal = (init as RequestInit)?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of [{ type: 'start', messageId: 'a9' }, { type: 'start-step' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'streaming answer' }]) c.enqueue(sse(ch));
          // deliberately never closes — the turn is still live when the refresh below lands
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const q = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }], metadata: { status: 'complete' } });
    const a = (id: string, text: string) => ({ id, role: 'assistant', parts: [{ type: 'text', text }], metadata: { status: 'complete' } });
    const conv = (id: string) => ({ id, title: `Chat ${id}`, model: 'claude-sonnet-5' as const, updatedAt: '2026-09-28T10:00:00.000Z' });
    const meter = { percentUsed: 0, questionsLeft: 10, hasCredit: false, exhausted: false, admin: false };
    const open = { id: 'c1', model: 'claude-sonnet-5' as const, messageCount: 2, messages: [q('m1', 'old q'), a('m2', 'old answer')] as never, inFlight: false };
    const view = render(<AskAi conversations={[conv('c1'), conv('c2')]} open={open} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'new question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('streaming answer');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Chat c2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Chat c2' }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(chatSignal?.aborted).toBe(false);
    // what that refresh's server render returns: the open chat is locked — by this very turn
    view.rerender(
      <AskAi
        conversations={[conv('c1')]}
        open={{ ...open, messageCount: 3, messages: [q('m1', 'old q'), a('m2', 'old answer'), q('m3', 'new question')] as never, inFlight: true }}
        meter={meter}
        preview={false}
        appOrigin={appOrigin}
        writes={null}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(chatSignal?.aborted).toBe(false); // B1: idle -> busy must not remount Thread / abort the live fetch
    expect(screen.getByText('streaming answer')).toBeInTheDocument();
  });
});

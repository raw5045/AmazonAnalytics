import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { APICallError } from 'ai';
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const chat = vi.hoisted(() => ({
  messages: [] as unknown[], sendMessage: vi.fn(), status: 'ready', stop: vi.fn(),
  error: undefined as Error | undefined, clearError: vi.fn(), setMessages: vi.fn(), lastOptions: null as unknown,
}));
vi.mock('@ai-sdk/react', () => ({ useChat: (opts: unknown) => { chat.lastOptions = opts; return chat; } }));
import { Thread } from './Thread';

const appOrigin = 'https://keywordquarry.com';

/**
 * `draft` is owned by the parent (AskAi) since the fix round's item 8 — this stands in for that,
 * so tests can exercise typing/sending/restoring the draft the same way the real app wires it.
 */
function Harness({ initialDraft = '', ...rest }: Partial<React.ComponentProps<typeof Thread>> & { initialDraft?: string }) {
  const [draft, setDraft] = useState(initialDraft);
  return <Thread open={null} defaultModel="claude-sonnet-5" cantSendReason={null} atCap={false} appOrigin={appOrigin} {...rest} draft={draft} onDraftChange={setDraft} />;
}

describe('Thread', () => {
  beforeEach(() => { vi.clearAllMocks(); chat.messages = []; chat.status = 'ready'; chat.error = undefined; });

  it('a new chat shows the model picker and the example prompts, and sends with the chosen model', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText(/Advanced \(Opus 5\.5\)/));
    fireEvent.click(screen.getByRole('button', { name: /highest volume keywords in the lighting niche/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'Show me the highest volume keywords in the lighting niche with less than 500 average reviews.' }, { body: { conversationId: null, model: 'claude-opus-5-5' } });
  });

  it('an open chat renders stored messages, the model chip, tool activity and status lines', () => {
    chat.messages = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'tool-search_keywords', toolCallId: 't', state: 'output-available', input: {} }, { type: 'text', text: '**Done**' }], metadata: { status: 'stopped' } },
    ];
    render(<Harness open={{ id: 'c1', model: 'claude-haiku-4-5', messageCount: 2, messages: chat.messages as never, inFlight: false }} />);
    expect(screen.getByText('Quick (Haiku 4.5)')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Used 1 tool')).toBeInTheDocument();
    expect(screen.getByText('Stopped.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  describe('status lines (item 1 — real shapes)', () => {
    it('live deadline stop: turn.ts now sends status and stopReason together', () => {
      chat.messages = [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'partial' }], metadata: { status: 'stopped', stopReason: 'deadline' } },
      ];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: chat.messages as never, inFlight: false }} />);
      expect(screen.getByText('That took too long. Try a narrower question.')).toBeInTheDocument();
      expect(screen.queryByText('Stopped.')).toBeNull();
    });

    it('live cut-off: finishReason "length" with no status at all', () => {
      chat.messages = [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'partial answer' }], metadata: { finishReason: 'length' } },
      ];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: chat.messages as never, inFlight: false }} />);
      expect(screen.getByText('The answer was cut off because it got too long. Ask for a shorter version.')).toBeInTheDocument();
    });

    it('stored, no text: falls back to the ran-out heuristic (finishReason/stopReason are never persisted)', () => {
      chat.messages = [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'tool-search_keywords', toolCallId: 't', state: 'output-available', input: {} }], metadata: { status: 'complete' } },
      ];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [], inFlight: false }} />);
      expect(screen.getByText('I ran out of steps before finishing. Try a narrower question.')).toBeInTheDocument();
    });

    it('does not show the ran-out line for the message currently streaming (no text yet just means mid-answer)', () => {
      chat.status = 'streaming';
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { id: 'm2', role: 'assistant', parts: [] }];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [], inFlight: false }} />);
      expect(screen.queryByText('I ran out of steps before finishing. Try a narrower question.')).toBeNull();
    });

    it('a stream error before any text shows only the alert, never a duplicate ran-out line (spec review "Different" #1)', () => {
      chat.status = 'error';
      chat.error = new Error('The AI is busy, try again in a moment.');
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { id: 'm2', role: 'assistant', parts: [] }];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [], inFlight: false }} />);
      expect(screen.getByRole('alert')).toHaveTextContent('The AI is busy, try again in a moment.');
      expect(screen.queryByText(/ran out of steps/)).toBeNull();
    });

    it('an OLDER no-text message keeps its own ran-out line even while a LATER turn is in an error state (item 5 minor)', () => {
      chat.status = 'error';
      chat.error = new Error('The AI hit a problem. Try again in a minute.');
      chat.messages = [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'tool-search_keywords', toolCallId: 't', state: 'output-available', input: {} }], metadata: { status: 'complete' } },
        { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'second' }] },
        { id: 'm4', role: 'assistant', parts: [] },
      ];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 4, messages: [], inFlight: false }} />);
      expect(screen.getByText('I ran out of steps before finishing. Try a narrower question.')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('shows the server error line (JSON body) on error', () => {
      chat.status = 'error';
      chat.error = new Error(JSON.stringify({ error: 'Wait for the current answer to finish.' }));
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [], inFlight: false }} />);
      expect(screen.getByRole('alert')).toHaveTextContent('Wait for the current answer to finish.');
    });
  });

  describe('bottom-of-thread line (item 1 — never RAN_OUT_MESSAGE here)', () => {
    it('STOPPED_LINE when Stop landed before any assistant message existed (N3: keyed off onFinish\'s messages argument, not message.role)', () => {
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlight: false }} />);
      const opts = chat.lastOptions as { onFinish: (e: { message: { id: string; role: string; metadata?: unknown }; messages: unknown[]; isAbort: boolean; isError: boolean }) => void };
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
      chat.status = 'ready';
      // onFinish's `message` is always an assistant-shaped shell with a fresh id, even when
      // nothing was ever shown — the real signal is whether that id made it into `messages`.
      act(() => { opts.onFinish({ message: { id: 'a-shell', role: 'assistant' }, messages: chat.messages, isAbort: true, isError: false }); });
      expect(screen.getByText('Stopped.')).toBeInTheDocument();
    });

    it('BUSY_MESSAGE while open.inFlight, without disabling the textarea or Send (item 1 / N1)', () => {
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
      chat.status = 'ready';
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlight: true }} initialDraft="another question" />);
      expect(screen.getByText('Wait for the current answer to finish.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
      expect(screen.getByLabelText('Your question')).toBeEnabled();
    });

    it('NO_ANSWER_MESSAGE when nothing else explains the missing answer', () => {
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
      chat.status = 'ready';
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlight: false }} />);
      expect(screen.getByText('No answer was saved for this question. Try asking again.')).toBeInTheDocument();
    });
  });

  describe('server-computed busy state auto-refresh (item 1 / N1)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('starts a 4s refresh interval while inFlight and stops it once inFlight clears', () => {
      const { rerender } = render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlight: true }} />);
      act(() => { vi.advanceTimersByTime(4000); });
      expect(router.refresh).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(4000); });
      expect(router.refresh).toHaveBeenCalledTimes(2);
      rerender(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlight: false }} />);
      act(() => { vi.advanceTimersByTime(8000); });
      expect(router.refresh).toHaveBeenCalledTimes(2);
    });

    it('never starts the interval for an idle chat', () => {
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlight: false }} />);
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(router.refresh).not.toHaveBeenCalled();
    });

    it('stops the interval on unmount', () => {
      const { unmount } = render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlight: true }} />);
      unmount();
      act(() => { vi.advanceTimersByTime(8000); });
      expect(router.refresh).not.toHaveBeenCalled();
    });

    it('M4: skips the refresh (but keeps the interval running) while the tab is hidden', () => {
      // `hidden` lives on Document.prototype, not as document's own property — redefining it with
      // Object.defineProperty(document, 'hidden', ...) shadows the prototype getter with an own
      // property that a later `if (original) Object.defineProperty(...)` restore would never see
      // (there is no ORIGINAL own property to restore; the shadow just lingers). vi.spyOn's own
      // mockRestore() correctly removes exactly the shadow it added instead (nits round hygiene).
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      try {
        render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlight: true }} />);
        act(() => { vi.advanceTimersByTime(8000); });
        expect(router.refresh).not.toHaveBeenCalled();
        hidden.mockReturnValue(false);
        act(() => { vi.advanceTimersByTime(4000); });
        expect(router.refresh).toHaveBeenCalledTimes(1);
      } finally {
        hidden.mockRestore();
      }
    });

    it('nits round: does not refresh while this tab is itself streaming the answer (a mid-turn refresh reporting this turn\'s own lock must not poll on top of it)', () => {
      chat.status = 'streaming';
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlight: true }} />);
      act(() => { vi.advanceTimersByTime(8000); });
      expect(router.refresh).not.toHaveBeenCalled();
    });
  });

  describe('onFinish navigation (item 2, item 3, item 10 M4)', () => {
    it('a first send moves the URL via replace only — no extra refresh (M4: not both)', () => {
      render(<Harness />);
      const opts = chat.lastOptions as { onFinish: (e: { message: { metadata?: { conversationId?: string } }; messages: unknown[]; isAbort: boolean; isError: boolean }) => void };
      act(() => { opts.onFinish({ message: { metadata: { conversationId: 'c9' } }, messages: [], isAbort: false, isError: false }); });
      expect(router.replace).toHaveBeenCalledWith('/ask?c=c9');
      expect(router.refresh).not.toHaveBeenCalled();
    });

    it('a follow-up refreshes only — there is no new id to move to', () => {
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [], inFlight: false }} />);
      const opts = chat.lastOptions as { onFinish: (e: { message: { metadata?: { conversationId?: string } }; messages: unknown[]; isAbort: boolean; isError: boolean }) => void };
      act(() => { opts.onFinish({ message: { metadata: {} }, messages: [], isAbort: false, isError: false }); });
      expect(router.refresh).toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
    });

    it('a first-send error refreshes but never navigates away (item 3) — the live error line stays visible', () => {
      render(<Harness />);
      const opts = chat.lastOptions as { onFinish: (e: { message: { metadata?: { conversationId?: string } }; messages: unknown[]; isAbort: boolean; isError: boolean }) => void };
      act(() => { opts.onFinish({ message: { metadata: { conversationId: 'c9' } }, messages: [], isAbort: false, isError: true }); });
      expect(router.replace).not.toHaveBeenCalled();
      expect(router.refresh).toHaveBeenCalled();
    });

    it('N2: Send stays disabled once onFinish learns a new chat id, so a quick follow-up cannot race the page change', () => {
      render(<Harness initialDraft="another question" />);
      const opts = chat.lastOptions as { onFinish: (e: { message: { metadata?: { conversationId?: string } }; messages: unknown[]; isAbort: boolean; isError: boolean }) => void };
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
      act(() => { opts.onFinish({ message: { metadata: { conversationId: 'c9' } }, messages: [], isAbort: false, isError: false }); });
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    });

    describe('a Stop-driven finish delays the move by 1.5s', () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      it('so the server save of the partial answer lands first', () => {
        render(<Harness />);
        const opts = chat.lastOptions as { onFinish: (e: { message: { id: string; role: string; metadata?: { conversationId?: string } }; messages: unknown[]; isAbort: boolean; isError: boolean }) => void };
        act(() => { opts.onFinish({ message: { id: 'a1', role: 'assistant', metadata: { conversationId: 'c9' } }, messages: [{ id: 'a1', role: 'assistant' }], isAbort: true, isError: false }); });
        expect(router.replace).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1499); });
        expect(router.replace).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1); });
        expect(router.replace).toHaveBeenCalledWith('/ask?c=c9');
      });

      it('is cancelled if the member navigates away before it fires (item 2)', () => {
        const { unmount } = render(<Harness />);
        const opts = chat.lastOptions as { onFinish: (e: { message: { id: string; role: string; metadata?: { conversationId?: string } }; messages: unknown[]; isAbort: boolean; isError: boolean }) => void };
        act(() => { opts.onFinish({ message: { id: 'a1', role: 'assistant', metadata: { conversationId: 'c9' } }, messages: [{ id: 'a1', role: 'assistant' }], isAbort: true, isError: false }); });
        unmount();
        act(() => { vi.advanceTimersByTime(2000); });
        expect(router.replace).not.toHaveBeenCalled();
      });
    });
  });

  it('a follow-up send before the URL replace lands uses the id learned from the stream, not a duplicate null (item 3)', () => {
    const { rerender } = render(<Harness />);
    chat.messages = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'partial' }], metadata: { conversationId: 'c9' } },
    ];
    rerender(<Harness />);
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'second' }, { body: { conversationId: 'c9' } });
  });

  describe('onError (item 4, item 10 M6, item 5 minors)', () => {
    it('an HTTP refusal with no conversationId in the body removes the optimistic message and restores its text to the draft (draft was empty)', () => {
      const { rerender } = render(<Harness />);
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'a question' }] }];
      rerender(<Harness />);
      const opts = chat.lastOptions as { onError: (e: unknown) => void };
      const err = new APICallError({ message: JSON.stringify({ error: 'Wait for the current answer to finish.', code: 'busy' }), url: '/api/ask/chat', requestBodyValues: {}, statusCode: 409 });
      act(() => { opts.onError(err); });
      expect(chat.setMessages).toHaveBeenCalledTimes(1);
      const updater = chat.setMessages.mock.calls[0][0] as (msgs: unknown[]) => unknown[];
      let stripped: unknown[] = [];
      act(() => { stripped = updater(chat.messages); });
      expect(stripped).toEqual([]);
      expect(screen.getByLabelText('Your question')).toHaveValue('a question');
    });

    it('keeps the optimistic bubble and leaves a non-empty draft untouched (item 5 minor)', () => {
      const { rerender } = render(<Harness initialDraft="something else I typed" />);
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'a question' }] }];
      rerender(<Harness initialDraft="something else I typed" />);
      const opts = chat.lastOptions as { onError: (e: unknown) => void };
      const err = new APICallError({ message: JSON.stringify({ error: 'Wait for the current answer to finish.', code: 'busy' }), url: '/api/ask/chat', requestBodyValues: {}, statusCode: 409 });
      act(() => { opts.onError(err); });
      const updater = chat.setMessages.mock.calls[0][0] as (msgs: unknown[]) => unknown[];
      let result: unknown[] = [];
      act(() => { result = updater(chat.messages); });
      expect(result).toBe(chat.messages);
      expect(screen.getByLabelText('Your question')).toHaveValue('something else I typed');
    });

    it('a refusal body carrying conversationId navigates to the now-known chat instead of restoring the draft (item 4)', () => {
      const { rerender } = render(<Harness />);
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'a question' }] }];
      rerender(<Harness />);
      const opts = chat.lastOptions as { onError: (e: unknown) => void };
      const err = new APICallError({
        message: JSON.stringify({ error: 'Something went wrong on our side. Try again in a minute.', code: 'setup_failed', conversationId: 'c9' }),
        url: '/api/ask/chat', requestBodyValues: {}, statusCode: 503,
      });
      act(() => { opts.onError(err); });
      expect(router.replace).toHaveBeenCalledWith('/ask?c=c9');
      expect(chat.setMessages).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Your question')).toHaveValue('');
    });

    it('M2: also holds Send (leaving), and the onFinish({isError}) the SDK fires for the same failure does not also refresh — exactly one navigation', () => {
      render(<Harness />);
      const opts = chat.lastOptions as {
        onError: (e: unknown) => void;
        onFinish: (e: { message: { metadata?: { conversationId?: string } }; messages: unknown[]; isAbort: boolean; isError: boolean }) => void;
      };
      const err = new APICallError({
        message: JSON.stringify({ error: 'Something went wrong on our side. Try again in a minute.', code: 'setup_failed', conversationId: 'c9' }),
        url: '/api/ask/chat', requestBodyValues: {}, statusCode: 503,
      });
      act(() => { opts.onError(err); });
      expect(router.replace).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      // the SDK fires onFinish for this exact failed turn too, with isError: true
      act(() => { opts.onFinish({ message: { metadata: {} }, messages: [], isAbort: false, isError: true }); });
      expect(router.refresh).not.toHaveBeenCalled();
      expect(router.replace).toHaveBeenCalledTimes(1);
    });

    it('does not navigate on a conversationId-carrying refusal for a FOLLOW-UP (open already known) — that path is unaffected', () => {
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [], inFlight: false }} />);
      const opts = chat.lastOptions as { onError: (e: unknown) => void };
      const err = new APICallError({
        message: JSON.stringify({ error: 'Something went wrong on our side. Try again in a minute.', code: 'setup_failed' }),
        url: '/api/ask/chat', requestBodyValues: {}, statusCode: 503,
      });
      act(() => { opts.onError(err); });
      expect(router.replace).not.toHaveBeenCalled();
    });

    it('leaves a stream-embedded error alone (no statusCode) — nothing to strip, it never had an optimistic message of its own', () => {
      render(<Harness />);
      const opts = chat.lastOptions as { onError: (e: unknown) => void };
      act(() => { opts.onError(new Error('The AI is busy, try again in a moment.')); });
      expect(chat.setMessages).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
    });
  });

  describe('chat cap after a first-send error (item 6, spec re-review)', () => {
    it('does not show the cap message once a chat id is known — from a streamed conversationId even though open is still null', () => {
      chat.status = 'error';
      chat.error = new Error('The AI is busy, try again in a moment.');
      chat.messages = [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'm2', role: 'assistant', parts: [], metadata: { conversationId: 'c9' } },
      ];
      render(<Harness open={null} atCap cantSendReason={null} initialDraft="another try" />);
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
      expect(screen.queryByText('You have 5 chats. Delete one to start another.')).toBeNull();
    });

    it('shows the cap message when genuinely no chat id is known yet', () => {
      render(<Harness open={null} atCap cantSendReason={null} />);
      expect(screen.getByRole('status')).toHaveTextContent('You have 5 chats. Delete one to start another.');
    });

    it('shows an "Open this chat" link under the error alert when a streamed id is known and there is no open', () => {
      chat.status = 'error';
      chat.error = new Error('The AI is busy, try again in a moment.');
      chat.messages = [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'm2', role: 'assistant', parts: [], metadata: { conversationId: 'c9' } },
      ];
      render(<Harness open={null} />);
      expect(screen.getByRole('link', { name: 'Open this chat' })).toHaveAttribute('href', '/ask?c=c9');
    });

    it('does not show the link once the chat is open (no first-send ambiguity left)', () => {
      chat.status = 'error';
      chat.error = new Error('The AI is busy, try again in a moment.');
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlight: false }} />);
      expect(screen.queryByRole('link', { name: 'Open this chat' })).toBeNull();
    });
  });

  describe('Stop cooldown (item 10 M5 — disables only Send, not the textarea)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('disables Send for 2s after Stop while the textarea stays enabled and keeps focus', () => {
      chat.status = 'streaming';
      const { rerender } = render(<Harness initialDraft="queued" />);
      const box = screen.getByLabelText('Your question');
      box.focus();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(chat.stop).toHaveBeenCalled();
      chat.status = 'ready';
      rerender(<Harness initialDraft="queued" />);
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      expect(box).toBeEnabled();
      expect(box).toHaveFocus();
      act(() => { vi.advanceTimersByTime(1999); });
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    });
  });
});

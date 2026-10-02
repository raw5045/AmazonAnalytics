import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { APICallError } from 'ai';
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const chat = vi.hoisted(() => ({
  messages: [] as unknown[], sendMessage: vi.fn(), status: 'ready', stop: vi.fn(),
  error: undefined as Error | undefined, clearError: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(), lastOptions: null as unknown,
}));
vi.mock('@ai-sdk/react', () => ({ useChat: (opts: unknown) => { chat.lastOptions = opts; return chat; } }));
// The id → name lookup has its own tests (useWorkspaceNames.test.ts); here it is a fixed map, so no test fetches.
const workspaceNames = vi.hoisted(() => ({ value: { views: {} as Record<string, string>, categories: {} as Record<string, string> } }));
vi.mock('./useWorkspaceNames', () => ({ useWorkspaceNames: () => workspaceNames.value }));
import { isApprovalResultMessage } from '@/lib/ask/approvalResult';
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
  beforeEach(() => { vi.clearAllMocks(); chat.messages = []; chat.status = 'ready'; chat.error = undefined; workspaceNames.value = { views: {}, categories: {} }; });

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

  describe('approval cards (arc 4)', () => {
    const pending = { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Saving.' }, { type: 'tool-create_saved_view', toolCallId: 'c1', state: 'approval-requested', input: { name: 'Lamps', search: {} }, approval: { id: 'ap_1' } }] };
    const question = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'save it' }] };
    const openChat = (extra: { inFlight?: boolean } = {}) => ({ id: 'c1', model: 'claude-sonnet-5' as const, messageCount: chat.messages.length, messages: chat.messages as never, inFlight: false, ...extra });
    type FinishEvent = { message: { id: string; role: string; metadata?: unknown }; messages: unknown[]; isAbort: boolean; isError: boolean };
    const finish = (e: FinishEvent) => act(() => { (chat.lastOptions as { onFinish: (e: FinishEvent) => void }).onFinish(e); });
    /** The resend's answer streamed: its message is in the thread when onFinish fires. */
    const finishAnswered = () => { const answer = { id: 'a2', role: 'assistant', parts: [] }; finish({ message: answer, messages: [...chat.messages, answer], isAbort: false, isError: false }); };
    /** A refused resend (404/400/409/5xx): onFinish gets a shell that never reached the thread. */
    const finishRefused = () => finish({ message: { id: 'shell', role: 'assistant' }, messages: chat.messages, isAbort: false, isError: true });

    it('renders a live card on the last assistant message and answers it through addToolApprovalResponse + a resend carrying the approval', () => {
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'save it' }] }, pending];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: chat.messages as never, inFlight: false }} />);
      fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
      expect(chat.addToolApprovalResponse).toHaveBeenCalledWith({ id: 'ap_1', approved: true });
      // The resend's message is a hidden placeholder outcome message, so the SDK starts a NEW assistant
      // message for the resumed answer instead of continuing the one that holds the card — the live
      // thread then matches what a reload renders from the store. (Appending it with setMessages and
      // resending with sendMessage(undefined) does not do that: the SDK's approval resend continues the
      // card's message — Thread.live.test.tsx drives the real hook.)
      expect(chat.sendMessage).toHaveBeenCalledTimes(1);
      const [sent, options] = chat.sendMessage.mock.calls[0];
      expect(isApprovalResultMessage(sent)).toBe(true);
      expect(sent).toMatchObject({ id: 'approval-m2', role: 'user' });
      expect(options).toEqual({ body: { conversationId: 'c1', approvals: [{ approvalId: 'ap_1', approved: true, remember: 'chat' }] } });
      expect(screen.getByText('Approved for this chat')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    });
    it('with two cards pending, the first answer only records; the second sends both answers in part order', () => {
      const second = { type: 'tool-add_to_watchlist', toolCallId: 'c2', state: 'approval-requested', input: { keywords: ['desk lamp'], searchTermIds: [] }, approval: { id: 'ap_2' } };
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'save it' }] }, { ...pending, parts: [...pending.parts, second] }];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: chat.messages as never, inFlight: false }} />);
      fireEvent.click(screen.getAllByRole('button', { name: 'Deny' })[1]);   // answer the SECOND card first (the watchlist one): Deny
      expect(chat.addToolApprovalResponse).toHaveBeenCalledWith({ id: 'ap_2', approved: false });
      expect(chat.sendMessage).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));                                              // the first card (the view)
      expect(chat.sendMessage).toHaveBeenCalledWith(expect.anything(), { body: { conversationId: 'c1', approvals: [{ approvalId: 'ap_1', approved: true, remember: 'chat' }, { approvalId: 'ap_2', approved: false, remember: null }] } });
    });
    it('two cards, as the real hook moves them: card 2 answered (its part now approval-responded), then card 1 → ONE send with both answers in part order', () => {
      const second = { type: 'tool-add_to_watchlist', toolCallId: 'c2', state: 'approval-requested', input: { keywords: ['desk lamp'], searchTermIds: [] }, approval: { id: 'ap_2' } };
      chat.messages = [question, { ...pending, parts: [...pending.parts, second] }];
      const { rerender } = render(<Harness open={openChat()} />);
      fireEvent.click(screen.getAllByRole('button', { name: 'Deny' })[1]);
      chat.messages = [question, { ...pending, parts: [...pending.parts, { ...second, state: 'approval-responded', approval: { id: 'ap_2', approved: false } }] }];
      rerender(<Harness open={openChat()} />);
      expect(chat.sendMessage).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
      expect(chat.sendMessage).toHaveBeenCalledTimes(1);
      expect(chat.sendMessage.mock.calls[0][1]).toEqual({ body: { conversationId: 'c1', approvals: [{ approvalId: 'ap_1', approved: true, remember: 'chat' }, { approvalId: 'ap_2', approved: false, remember: null }] } });
    });
    it('cards are questions, not activity (spec 2026-10-01 §5): a message with only a card shows no "Used" disclosure, and a card beside a research call counts only the call', () => {
      const card = pending.parts[1];
      chat.messages = [question, { id: 'm2', role: 'assistant', parts: [card] }];
      const { unmount } = render(<Harness open={openChat()} />);
      expect(screen.queryByText(/^Used /)).toBeNull();
      unmount();
      chat.messages = [question, { id: 'm2', role: 'assistant', parts: [{ type: 'tool-search_keywords', toolCallId: 't', state: 'output-available', input: {} }, card] }];
      render(<Harness open={openChat()} />);
      expect(screen.getByText('Used 1 tool')).toBeInTheDocument();
      expect(screen.queryByText('Saving a view')).toBeNull();
    });
    it('a card reads after the answer\'s lead-in text', () => {
      chat.messages = [question, pending];
      render(<Harness open={openChat()} />);
      const card = screen.getByRole('group', { name: 'Save a view named ‘Lamps’' });
      expect(screen.getByText('Saving.').compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    it('each card is labelled by its own summary, and an answer moves focus to the next open card, then to the composer', () => {
      const second = { type: 'tool-add_to_watchlist', toolCallId: 'c2', state: 'approval-requested', input: { keywords: ['desk lamp'], searchTermIds: [] }, approval: { id: 'ap_2' } };
      chat.messages = [question, { ...pending, parts: [...pending.parts, second] }];
      render(<Harness open={openChat()} />);
      const watchlist = screen.getByRole('group', { name: 'Add 1 keyword to the watchlist: desk lamp' });
      expect(screen.getByRole('group', { name: 'Save a view named ‘Lamps’' })).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: 'Approve for this chat' })[0]);   // the view card, first in part order
      expect(within(watchlist).getByRole('button', { name: 'Deny' })).toHaveFocus();
      fireEvent.click(within(watchlist).getByRole('button', { name: 'Deny' }));
      expect(screen.getByLabelText('Your question')).toHaveFocus();
    });
    it('a card on an earlier message is a record, not interactive', () => {
      chat.messages = [pending, { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'later' }] }, { id: 'm4', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] }];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 3, messages: chat.messages as never, inFlight: false }} />);
      expect(screen.queryByRole('button', { name: 'Approve for this chat' })).toBeNull();
      // 'later' was sent while the card was open, and the route denies open cards on a send.
      expect(screen.getByText('Denied')).toBeInTheDocument();
    });
    it('hides the system-reported outcome messages from the thread', () => {
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'save it' }] }, { id: 'o1', role: 'user', parts: [{ type: 'text', text: '[approval-result] The person approved create_saved_view and it ran. Result: {}' }] }, { id: 'm4', role: 'assistant', parts: [{ type: 'text', text: 'Saved.' }] }];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 3, messages: chat.messages as never, inFlight: false }} />);
      expect(screen.queryByText(/approval-result/)).toBeNull();
      expect(screen.getByText('Saved.')).toBeInTheDocument();
      expect(screen.getAllByLabelText('You')).toHaveLength(1);
    });
    it('a delete card names its view from the lookup and sends no remember with "Approve this delete"', () => {
      workspaceNames.value = { views: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'Lamps' }, categories: {} };
      chat.messages = [question, { id: 'm2', role: 'assistant', parts: [{ type: 'tool-delete_saved_view', toolCallId: 'c1', state: 'approval-requested', input: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, approval: { id: 'ap_1' } }] }];
      render(<Harness open={openChat()} />);
      expect(screen.getByText('Delete the view ‘Lamps’ — permanent')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Approve this delete' }));
      expect(chat.sendMessage.mock.calls[0][1]).toEqual({ body: { conversationId: 'c1', approvals: [{ approvalId: 'ap_1', approved: true, remember: null }] } });
    });
    it('a reloaded chat shows the stored answers as records (Approved / Denied), with no ran-out line under them', () => {
      chat.messages = [
        question,
        { id: 'm2', role: 'assistant', parts: [
          { type: 'tool-create_saved_view', toolCallId: 'c1', state: 'output-available', input: { name: 'Lamps', search: {} }, output: undefined, approval: { id: 'ap_1', approved: true } },
          { type: 'tool-add_to_watchlist', toolCallId: 'c2', state: 'output-denied', input: { keywords: ['desk lamp'], searchTermIds: [] }, approval: { id: 'ap_2', approved: false } },
        ], metadata: { status: 'complete' } },
        { id: 'o1', role: 'user', parts: [{ type: 'text', text: '[approval-result] The person approved create_saved_view and it ran.' }] },
        { id: 'm3', role: 'assistant', parts: [{ type: 'text', text: 'Saved.' }], metadata: { status: 'complete' } },
      ];
      render(<Harness open={openChat()} />);
      expect(screen.getByText('Approved')).toBeInTheDocument();
      expect(screen.getByText('Denied')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
      expect(screen.queryByText(/ran out of steps/)).toBeNull();
    });
    it('no ran-out line under a card: a paused turn (finishReason "tool-calls", no text), live and stored', () => {
      const card = pending.parts[1];
      chat.messages = [question, { id: 'm2', role: 'assistant', parts: [card], metadata: { finishReason: 'tool-calls' } }];
      const { unmount } = render(<Harness open={openChat()} />);
      expect(screen.queryByText(/ran out of steps/)).toBeNull();
      unmount();
      chat.messages = [question, { id: 'm2', role: 'assistant', parts: [card], metadata: { status: 'complete' } }];
      render(<Harness open={openChat()} />);
      expect(screen.queryByText(/ran out of steps/)).toBeNull();
      expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeEnabled();
    });
    it('a plain finishReason "tool-calls" answer without a card still gets the ran-out line', () => {
      chat.messages = [question, { id: 'm2', role: 'assistant', parts: [{ type: 'tool-search_keywords', toolCallId: 't', state: 'output-available', input: {} }], metadata: { finishReason: 'tool-calls' } }];
      render(<Harness open={openChat()} />);
      expect(screen.getByText('I ran out of steps before finishing. Try a narrower question.')).toBeInTheDocument();
    });
    it('not interactive while the server reports the chat busy (open.inFlight)', () => {
      chat.messages = [question, pending];
      render(<Harness open={openChat({ inFlight: true })} />);
      expect(screen.queryByRole('button', { name: 'Approve for this chat' })).toBeNull();
      expect(screen.getByText('Waiting for an answer')).toBeInTheDocument();
    });
    it('a first send whose answer paused on a card holds the card\'s buttons while the page moves to the new chat (N2)', () => {
      chat.messages = [question, { ...pending, metadata: { conversationId: 'c9' } }];
      render(<Harness />);
      expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeEnabled();
      finish({ message: { id: 'm2', role: 'assistant', metadata: { conversationId: 'c9' } }, messages: chat.messages, isAbort: false, isError: false });
      expect(router.replace).toHaveBeenCalledWith('/ask?c=c9');
      expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeDisabled();
    });
    it('a new message sent while a card is open denies it, as the route does on that send: the record reads "Denied" at once — and a refused send, taken back out, leaves it open again', () => {
      const sent = { id: 'u3', role: 'user', parts: [{ type: 'text', text: 'never mind, show me lamps' }] };
      chat.messages = [question, pending];
      const { rerender } = render(<Harness open={openChat()} initialDraft="never mind, show me lamps" />);
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'never mind, show me lamps' }, { body: { conversationId: 'c1' } });
      chat.messages = [question, pending, sent];                    // useChat adds the member's message
      rerender(<Harness open={openChat()} />);
      expect(screen.getByText('Denied')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Approve for this chat' })).toBeNull();
      chat.messages = [question, pending];                          // refused (e.g. 409 chat_full): onError strips it
      rerender(<Harness open={openChat()} />);
      expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeEnabled();
    });
    it('answers that went out with the hidden placeholder keep their own records, even after later messages', () => {
      chat.messages = [
        question,
        { ...pending, parts: [pending.parts[0], { ...pending.parts[1], state: 'approval-responded', approval: { id: 'ap_1', approved: true } }] },
        { id: 'approval-m2', role: 'user', parts: [{ type: 'text', text: '[approval-result] pending' }] },
        { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Saved.' }] },
        { id: 'u5', role: 'user', parts: [{ type: 'text', text: 'thanks' }] },
        { id: 'a5', role: 'assistant', parts: [{ type: 'text', text: 'You are welcome.' }] },
      ];
      render(<Harness open={openChat()} />);
      expect(screen.getByText('Approved')).toBeInTheDocument();
      expect(screen.queryByText('Denied')).toBeNull();
    });
    describe('a refused or lost resend (spec 2026-10-01 §6, §9: the cards stay answerable)', () => {
      // vi.clearAllMocks keeps implementations: an unconsumed mockImplementationOnce would leak into the next test.
      afterEach(() => { chat.setMessages.mockReset(); });
      const answeredHere = { ...pending, parts: [pending.parts[0], { ...pending.parts[1], state: 'approval-responded', approval: { id: 'ap_1', approved: true } }] };
      const placeholder = { id: 'approval-m2', role: 'user', parts: [{ type: 'text', text: '[approval-result] pending' }] };
      const refusal = (statusCode: number) => new APICallError({ message: JSON.stringify({ error: 'Something went wrong on our side. Try again in a minute.', code: 'setup_failed' }), url: '/api/ask/chat', requestBodyValues: {}, statusCode });
      /** Clicks the card, then stands in for the real hook: the SDK's state after the resend failed, and its setMessages running the updater at once. */
      const answerThenFail = (err: unknown) => {
        chat.messages = [question, pending];
        const view = render(<Harness open={openChat()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
        chat.messages = [question, answeredHere, placeholder];
        chat.status = 'error';
        chat.setMessages.mockImplementationOnce((u: unknown) => { chat.messages = typeof u === 'function' ? (u as (ms: unknown[]) => unknown[])(chat.messages) : (u as unknown[]); });
        act(() => { (chat.lastOptions as { onError: (e: unknown) => void }).onError(err); });
        view.rerender(<Harness open={openChat()} />);
      };

      it('refused before anything streamed (503): the placeholder goes and the card is asked again — its part back to approval-requested with { id } only, its answer forgotten, its buttons back in the error state', () => {
        answerThenFail(refusal(503));
        expect(chat.messages).toEqual([question, pending]);
        expect((chat.messages[1] as typeof pending).parts[1]).toEqual(pending.parts[1]);
        expect(screen.queryByText('Approved for this chat')).toBeNull();
        expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeEnabled();
        expect(screen.getByLabelText('Your question')).toHaveValue('');
      });
      it('lost on the network (not an HTTP error at all): the card is asked again too', () => {
        answerThenFail(new TypeError('Failed to fetch'));
        expect(chat.messages).toEqual([question, pending]);
        expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeEnabled();
      });
      it('a 404 (the cards are gone: answered elsewhere, the chat deleted, writes switched off): the placeholder goes, the records stay, no buttons', () => {
        answerThenFail(refusal(404));
        expect(chat.messages).toEqual([question, answeredHere]);
        expect(screen.getByText('Approved for this chat')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
      });
      it('backstop: a placeholder left last with no resend in flight is dropped, never restored into the draft', () => {
        chat.messages = [question, answeredHere, placeholder];
        render(<Harness open={openChat()} />);
        const opts = chat.lastOptions as { onError: (e: unknown) => void };
        act(() => { opts.onError(new APICallError({ message: 'Failed to fetch the chat response.', url: '/api/ask/chat', requestBodyValues: {}, statusCode: 404 })); });
        const updater = chat.setMessages.mock.calls[0][0] as (msgs: unknown[]) => unknown[];
        let result: unknown[] = [];
        act(() => { result = updater(chat.messages); });
        expect(result).toEqual(chat.messages.slice(0, -1));
        expect(screen.getByLabelText('Your question')).toHaveValue('');
      });
      it('a refused NEW send leaves useChat in its error state; the card on the last answer keeps its buttons', () => {
        chat.status = 'error';
        chat.error = new Error(JSON.stringify({ error: 'Wait for the current answer to finish.', code: 'busy' }));
        chat.messages = [question, pending];
        render(<Harness open={openChat()} />);
        expect(screen.getByRole('alert')).toHaveTextContent('Wait for the current answer to finish.');
        expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeEnabled();
      });
    });
    it('a member\'s own message that starts with the outcome prefix is refused by the route (400) and goes back into the draft like any refusal', () => {
      chat.messages = [question, { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hello.' }] }, { id: 'u9AbC', role: 'user', parts: [{ type: 'text', text: '[approval-result] hi' }] }];
      render(<Harness open={openChat()} />);
      const opts = chat.lastOptions as { onError: (e: unknown) => void };
      act(() => { opts.onError(new APICallError({ message: JSON.stringify({ error: 'Bad request.', code: 'bad_request' }), url: '/api/ask/chat', requestBodyValues: {}, statusCode: 400 })); });
      const updater = chat.setMessages.mock.calls[0][0] as (msgs: unknown[]) => unknown[];
      let result: unknown[] = [];
      act(() => { result = updater(chat.messages); });
      expect(result).toEqual(chat.messages.slice(0, -1));
      expect(screen.getByLabelText('Your question')).toHaveValue('[approval-result] hi');
    });

    describe('onAlwaysApproved (Task 9: the "always allow" switch reflects an answer given here)', () => {
      it('"Always approve changes" calls it with "changes" once the resend\'s answer arrived', () => {
        const onAlwaysApproved = vi.fn();
        chat.messages = [question, pending];
        render(<Harness open={openChat()} onAlwaysApproved={onAlwaysApproved} />);
        fireEvent.click(screen.getByRole('button', { name: 'Always approve changes' }));
        expect(chat.sendMessage.mock.calls[0][1]).toEqual({ body: { conversationId: 'c1', approvals: [{ approvalId: 'ap_1', approved: true, remember: 'always' }] } });
        expect(screen.getByText('Always approved')).toBeInTheDocument();
        expect(onAlwaysApproved).not.toHaveBeenCalled();
        finishAnswered();
        expect(onAlwaysApproved).toHaveBeenCalledTimes(1);
        expect(onAlwaysApproved).toHaveBeenCalledWith('changes');
      });
      it('"Always approve deletes" calls it with "deletes"', () => {
        const onAlwaysApproved = vi.fn();
        chat.messages = [question, { id: 'm2', role: 'assistant', parts: [{ type: 'tool-delete_custom_category', toolCallId: 'c1', state: 'approval-requested', input: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, approval: { id: 'ap_1' } }] }];
        render(<Harness open={openChat()} onAlwaysApproved={onAlwaysApproved} />);
        fireEvent.click(screen.getByRole('button', { name: 'Always approve deletes' }));
        finishAnswered();
        expect(onAlwaysApproved).toHaveBeenCalledTimes(1);
        expect(onAlwaysApproved).toHaveBeenCalledWith('deletes');
      });
      it('a refused resend does not call it, and neither does the next turn that finishes', () => {
        const onAlwaysApproved = vi.fn();
        chat.messages = [question, pending];
        render(<Harness open={openChat()} onAlwaysApproved={onAlwaysApproved} />);
        fireEvent.click(screen.getByRole('button', { name: 'Always approve changes' }));
        finishRefused();
        expect(onAlwaysApproved).not.toHaveBeenCalled();
        finishAnswered();
        expect(onAlwaysApproved).not.toHaveBeenCalled();
      });
      it('"Approve for this chat" and a denial never call it', () => {
        const onAlwaysApproved = vi.fn();
        const second = { type: 'tool-add_to_watchlist', toolCallId: 'c2', state: 'approval-requested', input: { keywords: ['desk lamp'], searchTermIds: [] }, approval: { id: 'ap_2' } };
        chat.messages = [question, { ...pending, parts: [...pending.parts, second] }];
        render(<Harness open={openChat()} onAlwaysApproved={onAlwaysApproved} />);
        fireEvent.click(screen.getAllByRole('button', { name: 'Deny' })[1]);
        fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
        finishAnswered();
        expect(onAlwaysApproved).not.toHaveBeenCalled();
      });
    });
  });
});

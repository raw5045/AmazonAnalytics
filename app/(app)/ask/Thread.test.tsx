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
  return <Thread open={null} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} {...rest} draft={draft} onDraftChange={setDraft} />;
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
    render(<Harness open={{ id: 'c1', model: 'claude-haiku-4-5', messageCount: 2, messages: chat.messages as never, inFlightSince: null }} />);
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
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: chat.messages as never, inFlightSince: null }} />);
      expect(screen.getByText('That took too long. Try a narrower question.')).toBeInTheDocument();
      expect(screen.queryByText('Stopped.')).toBeNull();
    });

    it('live cut-off: finishReason "length" with no status at all', () => {
      chat.messages = [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'partial answer' }], metadata: { finishReason: 'length' } },
      ];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: chat.messages as never, inFlightSince: null }} />);
      expect(screen.getByText('The answer was cut off because it got too long. Ask for a shorter version.')).toBeInTheDocument();
    });

    it('stored, no text: falls back to the ran-out heuristic (finishReason/stopReason are never persisted)', () => {
      chat.messages = [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'tool-search_keywords', toolCallId: 't', state: 'output-available', input: {} }], metadata: { status: 'complete' } },
      ];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [], inFlightSince: null }} />);
      expect(screen.getByText('I ran out of steps before finishing. Try a narrower question.')).toBeInTheDocument();
    });

    it('does not show the ran-out line for the message currently streaming (no text yet just means mid-answer)', () => {
      chat.status = 'streaming';
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { id: 'm2', role: 'assistant', parts: [] }];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [], inFlightSince: null }} />);
      expect(screen.queryByText('I ran out of steps before finishing. Try a narrower question.')).toBeNull();
    });

    it('a stream error before any text shows only the alert, never a duplicate ran-out line (spec review "Different" #1)', () => {
      chat.status = 'error';
      chat.error = new Error('The AI is busy, try again in a moment.');
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { id: 'm2', role: 'assistant', parts: [] }];
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [], inFlightSince: null }} />);
      expect(screen.getByRole('alert')).toHaveTextContent('The AI is busy, try again in a moment.');
      expect(screen.queryByText(/ran out of steps/)).toBeNull();
    });

    it('shows the server error line (JSON body) on error', () => {
      chat.status = 'error';
      chat.error = new Error(JSON.stringify({ error: 'Wait for the current answer to finish.' }));
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [], inFlightSince: null }} />);
      expect(screen.getByRole('alert')).toHaveTextContent('Wait for the current answer to finish.');
    });
  });

  describe('bottom-of-thread line (item 1 — never RAN_OUT_MESSAGE here)', () => {
    it('STOPPED_LINE when Stop landed before any assistant message existed', () => {
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlightSince: null }} />);
      const opts = chat.lastOptions as { onFinish: (e: { message: { id: string; role: string; metadata?: unknown }; isAbort: boolean; isError: boolean }) => void };
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
      chat.status = 'ready';
      act(() => { opts.onFinish({ message: { id: 'm1', role: 'user' }, isAbort: true, isError: false }); });
      expect(screen.getByText('Stopped.')).toBeInTheDocument();
    });

    it('BUSY_MESSAGE when the chat was locked recently (within the 5-minute expiry), and Composer shows the same line as its disabled reason', () => {
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
      chat.status = 'ready';
      const recentIso = new Date(Date.now() - 60_000).toISOString();
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlightSince: recentIso }} />);
      expect(screen.getAllByText('Wait for the current answer to finish.')).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    });

    it('NO_ANSWER_MESSAGE when nothing else explains the missing answer', () => {
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
      chat.status = 'ready';
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlightSince: null }} />);
      expect(screen.getByText('No answer was saved for this question. Try asking again.')).toBeInTheDocument();
    });

    it('a stale inFlightSince (older than the 5-minute expiry) does not read as busy', () => {
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
      chat.status = 'ready';
      const staleIso = new Date(Date.now() - 6 * 60_000).toISOString();
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlightSince: staleIso }} />);
      expect(screen.getByText('No answer was saved for this question. Try asking again.')).toBeInTheDocument();
    });
  });

  describe('onFinish navigation (item 2, item 3, item 10 M4)', () => {
    it('a first send moves the URL via replace only — no extra refresh (M4: not both)', () => {
      render(<Harness />);
      const opts = chat.lastOptions as { onFinish: (e: { message: { metadata?: { conversationId?: string } }; isAbort: boolean; isError: boolean }) => void };
      act(() => { opts.onFinish({ message: { metadata: { conversationId: 'c9' } }, isAbort: false, isError: false }); });
      expect(router.replace).toHaveBeenCalledWith('/ask?c=c9');
      expect(router.refresh).not.toHaveBeenCalled();
    });

    it('a follow-up refreshes only — there is no new id to move to', () => {
      render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [], inFlightSince: null }} />);
      const opts = chat.lastOptions as { onFinish: (e: { message: { metadata?: { conversationId?: string } }; isAbort: boolean; isError: boolean }) => void };
      act(() => { opts.onFinish({ message: { metadata: {} }, isAbort: false, isError: false }); });
      expect(router.refresh).toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
    });

    it('a first-send error refreshes but never navigates away (item 3) — the live error line stays visible', () => {
      render(<Harness />);
      const opts = chat.lastOptions as { onFinish: (e: { message: { metadata?: { conversationId?: string } }; isAbort: boolean; isError: boolean }) => void };
      act(() => { opts.onFinish({ message: { metadata: { conversationId: 'c9' } }, isAbort: false, isError: true }); });
      expect(router.replace).not.toHaveBeenCalled();
      expect(router.refresh).toHaveBeenCalled();
    });

    describe('a Stop-driven finish delays the move by 1.5s', () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      it('so the server save of the partial answer lands first', () => {
        render(<Harness />);
        const opts = chat.lastOptions as { onFinish: (e: { message: { id: string; role: string; metadata?: { conversationId?: string } }; isAbort: boolean; isError: boolean }) => void };
        act(() => { opts.onFinish({ message: { id: 'a1', role: 'assistant', metadata: { conversationId: 'c9' } }, isAbort: true, isError: false }); });
        expect(router.replace).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1499); });
        expect(router.replace).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1); });
        expect(router.replace).toHaveBeenCalledWith('/ask?c=c9');
      });

      it('is cancelled if the member navigates away before it fires (item 2)', () => {
        const { unmount } = render(<Harness />);
        const opts = chat.lastOptions as { onFinish: (e: { message: { id: string; role: string; metadata?: { conversationId?: string } }; isAbort: boolean; isError: boolean }) => void };
        act(() => { opts.onFinish({ message: { id: 'a1', role: 'assistant', metadata: { conversationId: 'c9' } }, isAbort: true, isError: false }); });
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

  it('an HTTP refusal (a statusCode error) removes the optimistic user message and restores its text to the draft (item 10 M6)', () => {
    const { rerender } = render(<Harness />);
    chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'a question' }] }];
    rerender(<Harness />);
    const opts = chat.lastOptions as { onError: (e: unknown) => void };
    const err = new APICallError({ message: JSON.stringify({ error: 'Wait for the current answer to finish.', code: 'busy' }), url: '/api/ask/chat', requestBodyValues: {}, statusCode: 409 });
    act(() => { opts.onError(err); });
    expect(chat.setMessages).toHaveBeenCalledTimes(1);
    const updater = chat.setMessages.mock.calls[0][0] as (msgs: unknown[]) => unknown[];
    expect(updater(chat.messages)).toEqual([]);
    expect(screen.getByLabelText('Your question')).toHaveValue('a question');
  });

  it('leaves a stream-embedded error alone (no statusCode) — nothing to strip, it never had an optimistic message of its own', () => {
    render(<Harness />);
    const opts = chat.lastOptions as { onError: (e: unknown) => void };
    act(() => { opts.onError(new Error('The AI is busy, try again in a moment.')); });
    expect(chat.setMessages).not.toHaveBeenCalled();
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

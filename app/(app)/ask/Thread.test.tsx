import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const chat = vi.hoisted(() => ({ messages: [] as unknown[], sendMessage: vi.fn(), status: 'ready', stop: vi.fn(), error: undefined as Error | undefined, clearError: vi.fn(), lastOptions: null as unknown }));
vi.mock('@ai-sdk/react', () => ({ useChat: (opts: unknown) => { chat.lastOptions = opts; return chat; } }));
import { Thread } from './Thread';

const appOrigin = 'https://keywordquarry.com';

describe('Thread', () => {
  beforeEach(() => { vi.clearAllMocks(); chat.messages = []; chat.status = 'ready'; chat.error = undefined; });

  it('a new chat shows the model picker and the example prompts, and sends with the chosen model', () => {
    render(<Thread open={null} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
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
    render(<Thread open={{ id: 'c1', model: 'claude-haiku-4-5', messageCount: 2, messages: chat.messages as never }} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
    expect(screen.getByText('Quick (Haiku 4.5)')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Used 1 tool')).toBeInTheDocument();
    expect(screen.getByText('Stopped.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('shows the turn-deadline line when a stopped answer was cut off by the deadline, not the plain Stopped line', () => {
    chat.messages = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'partial' }], metadata: { status: 'stopped', stopReason: 'deadline' } },
    ];
    render(<Thread open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: chat.messages as never }} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
    expect(screen.getByText('That took too long. Try a narrower question.')).toBeInTheDocument();
    expect(screen.queryByText('Stopped.')).toBeNull();
  });

  it('shows the cut-off line when the model hit the output limit', () => {
    chat.messages = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'partial answer' }], metadata: { status: 'complete', finishReason: 'length' } },
    ];
    render(<Thread open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: chat.messages as never }} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
    expect(screen.getByText('The answer was cut off because it got too long. Ask for a shorter version.')).toBeInTheDocument();
  });

  it('shows the ran-out-of-steps line when an answer has no text, and the server error line on error', () => {
    chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { id: 'm2', role: 'assistant', parts: [{ type: 'tool-search_keywords', toolCallId: 't', state: 'output-available', input: {} }], metadata: { status: 'complete' } }];
    const { rerender } = render(<Thread open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [] }} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
    expect(screen.getByText('I ran out of steps before finishing. Try a narrower question.')).toBeInTheDocument();
    chat.error = new Error(JSON.stringify({ error: 'Wait for the current answer to finish.' }));
    rerender(<Thread open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [] }} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Wait for the current answer to finish.');
  });

  it('does not show the ran-out-of-steps line for the message currently streaming (no text yet just means mid-answer)', () => {
    chat.status = 'streaming';
    chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { id: 'm2', role: 'assistant', parts: [] }];
    render(<Thread open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [] }} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
    expect(screen.queryByText('I ran out of steps before finishing. Try a narrower question.')).toBeNull();
  });

  it('onFinish of a first send moves the URL to the new conversation and refreshes', () => {
    render(<Thread open={null} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
    const opts = chat.lastOptions as { onFinish: (e: { message: { metadata?: { conversationId?: string } } }) => void };
    opts.onFinish({ message: { metadata: { conversationId: 'c9' } } });
    expect(router.replace).toHaveBeenCalledWith('/ask?c=c9');
    expect(router.refresh).toHaveBeenCalled();
  });

  describe('onFinish with isAbort (Task 9 D7)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('delays the URL move by 1.5s so the server save of the partial answer lands first', () => {
      render(<Thread open={null} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
      const opts = chat.lastOptions as { onFinish: (e: { message: { metadata?: { conversationId?: string } }; isAbort: boolean }) => void };
      opts.onFinish({ message: { metadata: { conversationId: 'c9' } }, isAbort: true });
      expect(router.replace).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1499);
      expect(router.replace).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(router.replace).toHaveBeenCalledWith('/ask?c=c9');
      expect(router.refresh).toHaveBeenCalled();
    });

    it('does not delay a normal (non-abort) finish', () => {
      render(<Thread open={null} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
      const opts = chat.lastOptions as { onFinish: (e: { message: { metadata?: { conversationId?: string } }; isAbort: boolean }) => void };
      opts.onFinish({ message: { metadata: { conversationId: 'c9' } }, isAbort: false });
      expect(router.replace).toHaveBeenCalledWith('/ask?c=c9');
    });
  });

  describe('Stop cooldown (Task 9 D6)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('disables Send for 2s after Stop, then re-enables it', () => {
      chat.status = 'streaming';
      const { rerender } = render(<Thread open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [] }} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
      // A draft queued while the previous answer was still streaming (the box isn't disabled yet
      // at this point) — otherwise Send would stay disabled by Composer's own empty-value check,
      // masking whether the cooldown disabling is working.
      fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'another question' } });
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(chat.stop).toHaveBeenCalled();
      // The hook's own status eventually reflects the stop; simulated here by flipping the mock
      // and re-rendering the same component instance so the cooldown state set by onStop persists.
      // A freshly-constructed element (not the same reference as the first render's) is required —
      // React bails out of re-invoking the component on a referentially-identical top-level element.
      chat.status = 'ready';
      rerender(<Thread open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: [] }} defaultModel="claude-sonnet-5" canSend cantSendReason={null} appOrigin={appOrigin} />);
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      act(() => { vi.advanceTimersByTime(1999); });
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    });
  });
});

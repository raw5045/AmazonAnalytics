import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const chat = vi.hoisted(() => ({
  messages: [] as unknown[], sendMessage: vi.fn(), status: 'ready', stop: vi.fn(),
  error: undefined as Error | undefined, clearError: vi.fn(), setMessages: vi.fn(),
}));
vi.mock('@ai-sdk/react', () => ({ useChat: () => chat }));
// A pass-through spy: the real Thread still renders (the tests below drive it through the mocked
// useChat), and a test can read the props AskAi gave it — onAlwaysApproved, which only a real
// approval resend's onFinish would otherwise call.
vi.mock('./Thread', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Thread')>();
  return { ...actual, Thread: vi.fn(actual.Thread) };
});
import { AskAi } from './AskAi';
import { Thread } from './Thread';
import type { WriteToggles } from './WriteSwitches';

const meter = { percentUsed: 0, questionsLeft: 10, hasCredit: false, exhausted: false, admin: false };
const appOrigin = 'https://keywordquarry.com';

describe('AskAi', () => {
  beforeEach(() => { vi.clearAllMocks(); chat.messages = []; chat.status = 'ready'; chat.error = undefined; });

  it('the narrow-screen Chats button opens the rail as a drawer; backdrop and Escape close it and return focus (spec 2026-10-04 §6)', () => {
    render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
    const toggle = screen.getByRole('button', { name: 'Chats' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'ask-ai-rail');
    const rail = document.getElementById('ask-ai-rail');
    expect(rail?.className).toContain('hidden');
    expect(screen.queryByRole('button', { name: 'Close chats' })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('link', { name: 'New chat' })).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(rail?.className).not.toContain('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Close chats' }));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(rail?.className).toContain('hidden');
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(screen.getByRole('link', { name: 'New chat' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('the rail footer holds the approval switches (when writes are on) and the usage meter (spec 2026-10-04 §3)', () => {
    const { unmount } = render(<AskAi conversations={[]} open={null} meter={meter} preview appOrigin={appOrigin} writes={{ autoApproveChanges: false, autoApproveDeletes: false }} />);
    const rail = screen.getByRole('complementary', { name: 'Your chats' });
    expect(within(rail).getByRole('group', { name: 'Approvals' })).toBeInTheDocument();
    expect(within(rail).getByRole('progressbar', { name: 'Usage this month' })).toBeInTheDocument();
    expect(within(rail).getByText('Admin preview')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Ask AI' })).toBeInTheDocument();
    unmount();
    render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
    expect(screen.queryByRole('group', { name: 'Approvals' })).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Usage this month' })).toBeInTheDocument();
  });

  it('a draft typed before a first send survives the Thread remount once the URL gains ?c=<id> (item 8 / M1)', () => {
    const { rerender } = render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'still typing' } });
    expect(screen.getByLabelText('Your question')).toHaveValue('still typing');
    // Thread is keyed by the open chat's id, so this remounts it — the draft must survive because
    // it now lives in AskAi, one level above Thread's key change.
    rerender(
      <AskAi
        conversations={[{ id: 'c1', title: 'Chat', model: 'claude-sonnet-5', updatedAt: '2026-09-28T10:00:00.000Z' }]}
        open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlight: false }}
        meter={meter}
        preview={false}
        appOrigin={appOrigin}
        writes={null}
      />,
    );
    expect(screen.getByLabelText('Your question')).toHaveValue('still typing');
  });

  describe('Thread lands at the chat\'s end when a chat is opened, except on a first send\'s own move to the chat it created (spec 2026-10-04 §4)', () => {
    const lastThreadProps = () => vi.mocked(Thread).mock.lastCall?.[0];
    const page = (id: string | null, inFlight = false) => (
      <AskAi conversations={[]} open={id === null ? null : { id, model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlight }} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />
    );
    it('starts true; the move Thread reports keeps the place on that id only, and the next open lands again', () => {
      const { rerender } = render(page(null));
      expect(lastThreadProps()?.landAtEnd).toBe(true);
      expect(lastThreadProps()?.onFirstSendMove).toBeTypeOf('function');
      act(() => lastThreadProps()?.onFirstSendMove?.('c1'));
      rerender(page('c1')); // the first send's move to the chat it created
      expect(lastThreadProps()?.landAtEnd).toBe(false);
      rerender(page('c2')); // a chat picked in the rail
      expect(lastThreadProps()?.landAtEnd).toBe(true);
    });
    it('picking an existing chat from the new-chat screen (no move reported) lands at its end', () => {
      const { rerender } = render(page(null));
      rerender(page('c2'));
      expect(lastThreadProps()?.landAtEnd).toBe(true);
    });
    it('a reported move keeps the place only on its own id, and only once', () => {
      const { rerender } = render(page(null));
      act(() => lastThreadProps()?.onFirstSendMove?.('c1'));
      rerender(page('c2')); // another chat opened before the move landed
      expect(lastThreadProps()?.landAtEnd).toBe(true);
      rerender(page('c1')); // the report was used up by that change
      expect(lastThreadProps()?.landAtEnd).toBe(true);
    });
    it('a rail click during the move clears the pending report: the member chose somewhere else', () => {
      const { rerender } = render(page(null));
      act(() => lastThreadProps()?.onFirstSendMove?.('c1'));
      fireEvent.click(screen.getByRole('link', { name: 'New chat' }));
      rerender(page('c1'));
      expect(lastThreadProps()?.landAtEnd).toBe(true);
    });
    it('a busy-to-idle remount of the same chat keeps the place (the B1 cases: no landing seconds into the member\'s own turn); a real open still lands', () => {
      const { rerender } = render(page('c1'));
      expect(lastThreadProps()?.landAtEnd).toBe(true);
      rerender(page('c1', true));
      rerender(page('c1', false)); // busy -> idle: the epoch remount
      expect(lastThreadProps()?.landAtEnd).toBe(false);
      rerender(page('c2'));
      expect(lastThreadProps()?.landAtEnd).toBe(true);
    });
    it('both adjust blocks in one render: leaving a busy chat for an idle one is a real open, so it lands', () => {
      const { rerender } = render(page('c1', true));
      rerender(page('c2', false)); // busy -> idle and an open-id change at once
      expect(lastThreadProps()?.landAtEnd).toBe(true);
    });
    it('the real first-send sequence: the reported move arrives busy (the save still holds the lock), then the busy-to-idle remount; the place is kept throughout', () => {
      const { rerender } = render(page(null));
      act(() => lastThreadProps()?.onFirstSendMove?.('c1'));
      rerender(page('c1', true));
      expect(lastThreadProps()?.landAtEnd).toBe(false);
      rerender(page('c1', false)); // busy -> idle: the epoch remount
      expect(lastThreadProps()?.landAtEnd).toBe(false);
    });
  });

  it('closes the drawer once a chat is picked (fix round 2, item 5 minor)', () => {
    const conversations = [{ id: 'c1', title: 'Chat', model: 'claude-sonnet-5' as const, updatedAt: '2026-09-28T10:00:00.000Z' }];
    render(<AskAi conversations={conversations} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    expect(screen.getByRole('button', { name: 'Chats' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('link', { name: 'Chat' }));
    expect(screen.getByRole('button', { name: 'Chats' })).toHaveAttribute('aria-expanded', 'false');
  });

  describe('B1 (Task 9 round-2 re-review): Thread remounts only on a busy -> idle transition', () => {
    it('idle -> busy does not remount (Thread-owned state, e.g. the Stop cooldown, survives); busy -> idle then remounts exactly once', () => {
      chat.status = 'streaming';
      const conversations = [{ id: 'c1', title: 'Chat', model: 'claude-sonnet-5' as const, updatedAt: '2026-09-28T10:00:00.000Z' }];
      const openIdle = { id: 'c1', model: 'claude-sonnet-5' as const, messageCount: 1, messages: [], inFlight: false };
      const { rerender } = render(<AskAi conversations={conversations} open={openIdle} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
      // A draft queued while streaming (the box isn't disabled yet) — otherwise Send would stay
      // disabled by Composer's own empty-value check regardless of whether Thread remounted.
      fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'another question' } });
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(chat.stop).toHaveBeenCalledTimes(1);
      chat.status = 'ready';
      // idle -> busy: a refresh (e.g. Rail deleting a different chat) reports this chat's OWN turn
      // as still locked. Must NOT remount Thread — if it did, the Stop cooldown above would reset
      // and Send would already be enabled again below, well before its real 2s window is up.
      rerender(<AskAi conversations={conversations} open={{ ...openIdle, inFlight: true }} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      // busy -> idle: the lock has genuinely cleared — this SHOULD remount, which resets the
      // (already-clientside-stale) cooldown immediately rather than waiting out its timer.
      rerender(<AskAi conversations={conversations} open={{ ...openIdle, inFlight: false }} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    });
  });

  it('nits round: "New chat" resets an unsaved chat even while already on /ask, where the URL does not change', () => {
    // Already on /ask with no chat open (`open` stays null throughout — its href is /ask, the same
    // page, so a real app would not necessarily get a fresh server render from this click alone).
    chat.status = 'streaming';
    render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'a question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(chat.stop).toHaveBeenCalledTimes(1);
    chat.status = 'ready';
    // Clicking "New chat" must remount the 'new' thread (Thread-owned state, e.g. the Stop
    // cooldown, resets immediately instead of waiting out its real 2s window) purely from the
    // newNonce bump — nothing here changes `open` or the URL.
    fireEvent.click(screen.getByRole('link', { name: 'New chat' }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  describe('the two "always allow" switches (spec 2026-10-01 §8)', () => {
    const OFF: WriteToggles = { autoApproveChanges: false, autoApproveDeletes: false };
    /** The page's render of AskAi with the given server values; a rerender with it is a router.refresh(). */
    const ui = (writes: WriteToggles | null) => <AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={writes} />;
    const changesBox = () => screen.queryByRole('checkbox', { name: 'Changes: always allow' });
    const deletesBox = () => screen.queryByRole('checkbox', { name: 'Deletes: always allow' });
    const clickChanges = () => fireEvent.click(screen.getByRole('checkbox', { name: 'Changes: always allow' }));
    /** The props AskAi last gave the (spied) Thread. */
    const threadProps = () => {
      const call = vi.mocked(Thread).mock.lastCall;
      if (!call) throw new Error('Thread was not rendered');
      return call[0];
    };
    const fetchMock = vi.fn();
    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('render with the page\'s values when writes are on, and not at all when writes is null', () => {
      const { unmount } = render(ui({ autoApproveChanges: false, autoApproveDeletes: true }));
      expect(screen.getByRole('group', { name: 'Approvals' })).toBeInTheDocument();
      expect(changesBox()).not.toBeChecked();
      expect(deletesBox()).toBeChecked();
      unmount();
      render(ui(null));
      expect(screen.queryByRole('group', { name: 'Approvals' })).toBeNull();
      expect(changesBox()).toBeNull();
      expect(deletesBox()).toBeNull();
    });

    it('a card still waiting when writes are switched off (writes null) is read-only — "Writes are off — send a message to continue." and no buttons; with writes on it keeps its buttons', () => {
      const paused = {
        id: 'c1', model: 'claude-sonnet-5' as const, messageCount: 2, inFlight: false,
        messages: [
          { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'save it' }] },
          { id: 'm2', role: 'assistant', parts: [{ type: 'tool-create_saved_view', toolCallId: 'c1', state: 'approval-requested', input: { name: 'Lamps', search: {} }, approval: { id: 'ap_1' } }] },
        ] as never,
      };
      chat.messages = paused.messages as unknown[];
      const page = (writes: WriteToggles | null) => <AskAi conversations={[]} open={paused} meter={meter} preview={false} appOrigin={appOrigin} writes={writes} />;
      const { rerender } = render(page(null));
      expect(threadProps().writesEnabled).toBe(false);
      expect(screen.getByText('Writes are off — send a message to continue.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Approve for this chat' })).toBeNull();
      rerender(page(OFF));
      expect(threadProps().writesEnabled).toBe(true);
      expect(screen.getByRole('button', { name: 'Approve for this chat' })).toBeEnabled();
      expect(screen.queryByText('Writes are off — send a message to continue.')).toBeNull();
    });

    it('a click on a switch goes through AskAi\'s state: it shows at once, then the answer (the row) lands', async () => {
      fetchMock.mockResolvedValueOnce(Response.json({ autoApproveChanges: true, autoApproveDeletes: true }));
      render(ui(OFF));
      clickChanges();
      expect(changesBox()).toBeChecked();
      expect(fetchMock).toHaveBeenCalledWith('/api/ask/account', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ autoApproveChanges: true }) }));
      await waitFor(() => expect(deletesBox()).toBeChecked());
      expect(changesBox()).toBeChecked();
    });

    it('an "Always approve" answered in the thread turns the matching switch on, with no request of its own', () => {
      render(ui(OFF));
      act(() => threadProps().onAlwaysApproved?.('changes'));
      expect(changesBox()).toBeChecked();
      expect(deletesBox()).not.toBeChecked();
      act(() => threadProps().onAlwaysApproved?.('deletes'));
      expect(changesBox()).toBeChecked();
      expect(deletesBox()).toBeChecked();
      // The resend that carried the answer already saved it: the switch only shows it.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('an "Always approve" that lands while a switch\'s save is out survives that save failing', async () => {
      let fail: (reason: unknown) => void = () => {};
      fetchMock.mockReturnValueOnce(new Promise<Response>((_resolve, reject) => { fail = reject; }));
      render(ui(OFF));
      clickChanges();
      act(() => threadProps().onAlwaysApproved?.('deletes'));
      expect(deletesBox()).toBeChecked();
      fail(new TypeError('Failed to fetch'));
      await waitFor(() => expect(changesBox()).not.toBeChecked());
      expect(deletesBox()).toBeChecked();
    });

    it('with writes null, an "Always approve" from the thread shows no switches', () => {
      render(ui(null));
      act(() => threadProps().onAlwaysApproved?.('changes'));
      expect(changesBox()).toBeNull();
    });

    it('a server render with the same values again (a new object) changes nothing: a refresh that read the row before an in-flight save cannot undo it', async () => {
      let finish: (res: Response) => void = () => {};
      fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
      const { rerender } = render(ui(OFF));
      clickChanges();
      rerender(ui({ ...OFF }));
      expect(changesBox()).toBeChecked();
      finish(Response.json({ autoApproveChanges: true, autoApproveDeletes: false }));
      await waitFor(() => expect(changesBox()).toBeEnabled());
      expect(changesBox()).toBeChecked();
    });

    it('a server render with different values is taken, over a local flip too (a refused resume that had saved "always" first, another tab)', () => {
      const { rerender } = render(ui(OFF));
      act(() => threadProps().onAlwaysApproved?.('changes'));
      rerender(ui({ ...OFF }));
      expect(changesBox()).toBeChecked();
      rerender(ui({ autoApproveChanges: false, autoApproveDeletes: true }));
      expect(changesBox()).not.toBeChecked();
      expect(deletesBox()).toBeChecked();
    });

    it('the switches appear once a server render brings a row (null to values) and go when writes are switched off (values to null)', () => {
      const { rerender } = render(ui(null));
      expect(changesBox()).toBeNull();
      rerender(ui({ autoApproveChanges: true, autoApproveDeletes: false }));
      expect(changesBox()).toBeChecked();
      expect(deletesBox()).not.toBeChecked();
      rerender(ui(null));
      expect(screen.queryByRole('group', { name: 'Approvals' })).toBeNull();
    });
  });
});

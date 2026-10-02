import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

const meter = { percentUsed: 0, questionsLeft: 10, hasCredit: false, exhausted: false, admin: false };
const appOrigin = 'https://keywordquarry.com';

describe('AskAi', () => {
  beforeEach(() => { vi.clearAllMocks(); chat.messages = []; chat.status = 'ready'; chat.error = undefined; });

  it('the narrow-screen Chats toggle expands and collapses the rail drawer (spec §11.2, item 11)', () => {
    render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
    const toggle = screen.getByRole('button', { name: 'Chats' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'ask-ai-rail');
    const rail = document.getElementById('ask-ai-rail');
    expect(rail?.className).toContain('hidden');
    expect(rail?.className).not.toContain('block ');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(rail?.className).not.toContain('hidden');
    expect(rail?.className).toContain('block');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(rail?.className).toContain('hidden');
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
    const changesBox = () => screen.queryByRole('checkbox', { name: 'Changes: always allow' });
    const deletesBox = () => screen.queryByRole('checkbox', { name: 'Deletes: always allow' });
    /** The props AskAi last gave the (spied) Thread. */
    const threadProps = () => {
      const call = vi.mocked(Thread).mock.lastCall;
      if (!call) throw new Error('Thread was not rendered');
      return call[0];
    };

    it('render with the page\'s values when writes are on, and not at all when writes is null', () => {
      const { unmount } = render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={{ autoApproveChanges: false, autoApproveDeletes: true }} />);
      expect(screen.getByRole('group', { name: 'Approvals' })).toBeInTheDocument();
      expect(changesBox()).not.toBeChecked();
      expect(deletesBox()).toBeChecked();
      unmount();
      render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
      expect(screen.queryByRole('group', { name: 'Approvals' })).toBeNull();
      expect(changesBox()).toBeNull();
      expect(deletesBox()).toBeNull();
    });

    it('an "Always approve" answered in the thread turns the matching switch on, with no request of its own', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={{ autoApproveChanges: false, autoApproveDeletes: false }} />);
      act(() => threadProps().onAlwaysApproved?.('changes'));
      expect(changesBox()).toBeChecked();
      expect(deletesBox()).not.toBeChecked();
      act(() => threadProps().onAlwaysApproved?.('deletes'));
      expect(changesBox()).toBeChecked();
      expect(deletesBox()).toBeChecked();
      // The resend that carried the answer already saved it: the switch only shows it.
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('with writes null, an "Always approve" from the thread shows no switches', () => {
      render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
      act(() => threadProps().onAlwaysApproved?.('changes'));
      expect(changesBox()).toBeNull();
    });
  });
});

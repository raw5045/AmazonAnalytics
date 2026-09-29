import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({ messages: [], sendMessage: vi.fn(), status: 'ready', stop: vi.fn(), error: undefined, clearError: vi.fn(), setMessages: vi.fn() }),
}));
import { AskAi } from './AskAi';

const meter = { percentUsed: 0, questionsLeft: 10, hasCredit: false, exhausted: false, admin: false };
const appOrigin = 'https://keywordquarry.com';

describe('AskAi', () => {
  it('the narrow-screen Chats toggle expands and collapses the rail drawer (spec §11.2, item 11)', () => {
    render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} />);
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
    const { rerender } = render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} />);
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'still typing' } });
    expect(screen.getByLabelText('Your question')).toHaveValue('still typing');
    // Thread is keyed by the open chat's id, so this remounts it — the draft must survive because
    // it now lives in AskAi, one level above Thread's key change.
    rerender(
      <AskAi
        conversations={[{ id: 'c1', title: 'Chat', model: 'claude-sonnet-5', updatedAt: '2026-09-28T10:00:00.000Z' }]}
        open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [], inFlightSince: null }}
        meter={meter}
        preview={false}
        appOrigin={appOrigin}
      />,
    );
    expect(screen.getByLabelText('Your question')).toHaveValue('still typing');
  });
});

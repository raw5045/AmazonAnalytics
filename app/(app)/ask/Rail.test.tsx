import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
import { Rail } from './Rail';
import { localDayKey } from './railGroups';
const convs = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}`, model: 'claude-sonnet-5' as const, updatedAt: '2026-09-28T10:00:00.000Z' }));
// One chat per group: 0, 1, 5 and 40 days back from 2026-10-04 12:00Z.
const day = (n: number) => new Date(Date.UTC(2026, 9, 4, 12) - n * 86_400_000).toISOString();
const list = [
  { id: 't1', title: 'Today one', model: 'claude-sonnet-5' as const, updatedAt: day(0) },
  { id: 'y1', title: 'Yesterday one', model: 'claude-sonnet-5' as const, updatedAt: day(1) },
  { id: 'w1', title: 'Week one', model: 'claude-opus-5-5' as const, updatedAt: day(5) },
  { id: 'o1', title: 'Old one', model: 'claude-haiku-4-5' as const, updatedAt: day(40) },
];
describe('Rail', () => {
  const onNavigate = vi.fn();
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 })); });
  it('disables New chat at five with the cap message', () => {
    render(<Rail conversations={convs} openId="c1" atCap onNavigate={onNavigate} />);
    expect(screen.getByText('You have 5 chats. Delete one to start another.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New chat' })).toHaveAttribute('aria-disabled', 'true');
  });
  it('deletes after a one-step confirm and returns to /ask when the open chat goes — replace only, not both (M3)', async () => {
    render(<Rail conversations={convs} openId="c1" atCap={false} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Chat 1' }));
    expect(screen.getByText('Delete this chat? It cannot be undone.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Chat 1' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/ask/conversations/c1', { method: 'DELETE' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/ask'));
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('deleting a chat that is NOT open refreshes only — no replace, the URL is not changing (M3)', async () => {
    render(<Rail conversations={convs} openId="c1" atCap={false} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Chat 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Chat 0' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/ask/conversations/c0', { method: 'DELETE' }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(router.replace).not.toHaveBeenCalled();
  });
  it('autofocuses the confirm button when it appears (item 10 M8)', () => {
    render(<Rail conversations={convs} openId="c1" atCap={false} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Chat 1' }));
    expect(screen.getByRole('button', { name: 'Confirm delete Chat 1' })).toHaveFocus();
  });
  it('shows an error line when the delete fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }));
    render(<Rail conversations={convs} openId={null} atCap={false} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Chat 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Chat 0' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not delete the chat right now. Try again in a minute.'));
  });
  it('shows the busy message from the response body on a 409 (a turn is still settling under the lock)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Wait for the current answer to finish.', code: 'busy' }), { status: 409 }));
    render(<Rail conversations={convs} openId={null} atCap={false} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Chat 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Chat 0' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Wait for the current answer to finish.'));
  });
  it('calls onNavigate when New chat or a chat link is clicked, but not when New chat is disabled at the cap (fix round 2, item 5 minor)', () => {
    render(<Rail conversations={convs} openId="c1" atCap={false} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('link', { name: 'Chat 0' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'New chat' }));
    expect(onNavigate).toHaveBeenCalledTimes(2);
    onNavigate.mockClear();
    render(<Rail conversations={convs} openId="c1" atCap onNavigate={onNavigate} />);
    fireEvent.click(screen.getAllByRole('link', { name: 'New chat' })[1]);
    expect(onNavigate).not.toHaveBeenCalled();
  });
  it('shows the h1, the admin chip when preview is on, and whatever the footer slot holds (spec §3)', () => {
    render(<Rail conversations={[]} openId={null} atCap={false} onNavigate={onNavigate} preview footer={<p>footer here</p>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Ask AI' })).toBeInTheDocument();
    expect(screen.getByText('Admin preview')).toBeInTheDocument();
    expect(screen.getByText('footer here')).toBeInTheDocument();
  });
  it('without preview there is no chip, and without a footer no footer border block', () => {
    render(<Rail conversations={[]} openId={null} atCap={false} onNavigate={onNavigate} />);
    expect(screen.queryByText('Admin preview')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Your chats' }).querySelector('[data-rail-footer]')).toBeNull();
  });
  it('groups chats by local day once hydrated, in display order, each group a labelled region', () => {
    vi.useFakeTimers({ now: new Date('2026-10-04T12:00:00Z') });
    try {
      render(<Rail conversations={list} openId="w1" atCap={false} onNavigate={onNavigate} />);
      expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Older']);
      expect(screen.getByRole('region', { name: 'Today' })).toHaveTextContent('Today one');
      expect(screen.getByRole('region', { name: 'Previous 7 days' })).toHaveTextContent('Week one');
      expect(screen.getByRole('region', { name: 'Older' })).toHaveTextContent('Old one');
      // The model tag and the date stay on the second line.
      expect(screen.getByRole('region', { name: 'Previous 7 days' })).toHaveTextContent('Advanced');
      expect(screen.getByRole('region', { name: 'Older' })).toHaveTextContent(localDayKey(new Date(day(40))));
    } finally {
      vi.useRealTimers();
    }
  });
  it('dates each row by the member\'s local day once it is known, the same day its group uses (review of Tasks 1-2)', () => {
    // 01:30 UTC is still the evening before west of UTC, where the UTC date would read a day ahead.
    const late = '2026-10-04T01:30:00.000Z';
    render(<Rail conversations={[{ id: 'l1', title: 'Late one', model: 'claude-sonnet-5', updatedAt: late }]} openId={null} atCap={false} onNavigate={onNavigate} />);
    expect(screen.getByRole('link', { name: 'Late one' }).closest('li')).toHaveTextContent(localDayKey(new Date(late)));
  });
  it('server-renders one unlabelled group with no day headings, so hydration matches before the local day is known', () => {
    const html = renderToString(<Rail conversations={list} openId={null} atCap={false} onNavigate={() => {}} />);
    expect(html.match(/aria-label="Chats"/g)).toHaveLength(1);
    expect(html).not.toContain('<h2');
  });
});

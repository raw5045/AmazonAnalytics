import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
import { Rail } from './Rail';
const convs = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}`, model: 'claude-sonnet-5' as const, updatedAt: '2026-09-28T10:00:00.000Z' }));
describe('Rail', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 })); });
  it('disables New chat at five with the cap message', () => {
    render(<Rail conversations={convs} openId="c1" atCap />);
    expect(screen.getByText('You have 5 chats. Delete one to start another.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New chat' })).toHaveAttribute('aria-disabled', 'true');
  });
  it('deletes after a one-step confirm and returns to /ask when the open chat goes', async () => {
    render(<Rail conversations={convs} openId="c1" atCap={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Chat 1' }));
    expect(screen.getByText('Delete this chat? It cannot be undone.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Chat 1' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/ask/conversations/c1', { method: 'DELETE' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/ask'));
    expect(router.refresh).toHaveBeenCalled();
  });
  it('autofocuses the confirm button when it appears (item 10 M8)', () => {
    render(<Rail conversations={convs} openId="c1" atCap={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Chat 1' }));
    expect(screen.getByRole('button', { name: 'Confirm delete Chat 1' })).toHaveFocus();
  });
  it('shows an error line when the delete fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }));
    render(<Rail conversations={convs} openId={null} atCap={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Chat 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Chat 0' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not delete the chat right now. Try again in a minute.'));
  });
  it('shows the busy message from the response body on a 409 (a turn is still settling under the lock)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Wait for the current answer to finish.', code: 'busy' }), { status: 409 }));
    render(<Rail conversations={convs} openId={null} atCap={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Chat 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Chat 0' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Wait for the current answer to finish.'));
  });
});

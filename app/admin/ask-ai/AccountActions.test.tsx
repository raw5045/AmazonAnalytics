import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
import { AccountActions } from './AccountActions';
describe('AccountActions', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })); });
  it('posts set_allowance with the dollar amount and refreshes', async () => {
    render(<AccountActions userId="u1" access allowanceUsd={10} />);
    fireEvent.change(screen.getByLabelText('Allowance $'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string)).toEqual({ action: 'set_allowance', userId: 'u1', amountUsd: 25 });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it('posts add_credit with a note and revoke / grant', async () => {
    render(<AccountActions userId="u1" access allowanceUsd={10} />);
    fireEvent.change(screen.getByLabelText('Credit $'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'invoice 12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string)).toEqual({ action: 'add_credit', userId: 'u1', amountUsd: 10, note: 'invoice 12' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(JSON.parse((vi.mocked(fetch).mock.calls[1][1] as RequestInit).body as string)).toEqual({ action: 'revoke', userId: 'u1' }));
  });
  it('shows an error line on failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 400 }));
    render(<AccountActions userId="u1" access={false} allowanceUsd={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('nope'));
  });
});

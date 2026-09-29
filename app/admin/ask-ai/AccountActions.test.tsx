import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
import { AccountActions } from './AccountActions';
describe('AccountActions', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })); });

  it('posts set_allowance with the dollar amount, refreshes, and shows a success line (S4b)', async () => {
    render(<AccountActions userId="u1" access allowanceUsd={10} />);
    fireEvent.change(screen.getByLabelText('Allowance $'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string)).toEqual({ action: 'set_allowance', userId: 'u1', amountUsd: 25 });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
  });

  it('posts add_credit with a note after confirming, clears the boxes, then revoke after confirming (S4a, S4c)', async () => {
    render(<AccountActions userId="u1" access allowanceUsd={10} />);
    fireEvent.change(screen.getByLabelText('Credit $'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'invoice 12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    // The confirm step replaces Add in place — no request has gone out yet.
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText('Add $10 credit?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string)).toEqual({ action: 'add_credit', userId: 'u1', amountUsd: 10, note: 'invoice 12' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Credit added.'));
    expect((screen.getByLabelText('Credit $') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(JSON.parse((vi.mocked(fetch).mock.calls[1][1] as RequestInit).body as string)).toEqual({ action: 'revoke', userId: 'u1' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Access revoked.'));
  });

  it('Cancel on the Revoke confirm backs out without posting', async () => {
    render(<AccountActions userId="u1" access allowanceUsd={10} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByText('Revoke access for this member?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('refuses an empty or non-numeric Allowance/Credit amount without sending a request or asking to confirm (S4d)', async () => {
    render(<AccountActions userId="u1" access allowanceUsd={10} />);
    fireEvent.change(screen.getByLabelText('Allowance $'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a dollar amount.');
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Credit $'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a dollar amount.');
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  // Task 10 nits, spec note 5 / N1 (regression): Number.parseFloat reads "1,000" as 1 and "10abc"
  // as 10 instead of refusing them, so a thousands separator (now displayed elsewhere on the page,
  // C-m7) would silently set a wildly wrong amount.
  it('refuses "1,500" (thousands separator) and "10abc" (trailing junk) as Allowance/Credit amounts', async () => {
    render(<AccountActions userId="u1" access allowanceUsd={10} />);
    fireEvent.change(screen.getByLabelText('Allowance $'), { target: { value: '1,500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a dollar amount.');
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Credit $'), { target: { value: '10abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a dollar amount.');
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  // Task 10 nits, spec note 6: Add credit with no note used to reach Confirm and then fail with the
  // generic "Invalid request." — checked before the confirm step opens instead.
  it('refuses Add credit with an empty note before showing Confirm, without sending a request', async () => {
    render(<AccountActions userId="u1" access allowanceUsd={10} />);
    fireEvent.change(screen.getByLabelText('Credit $'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Add a note.');
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows an error line on failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 400 }));
    render(<AccountActions userId="u1" access={false} allowanceUsd={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('nope'));
  });
});

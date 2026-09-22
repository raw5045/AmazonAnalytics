import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionControls } from './ConnectionControls';

describe('ConnectionControls', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('disconnects with a same-origin POST and then offers Reconnect', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'disconnected' }), { status: 200 }));
    render(<ConnectionControls initialStatus="enabled" />);
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /reconnect/i })).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/mcp/connection',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'disconnect' }) }),
    );
    const statusParagraph = screen.getByText(/mcp access for this account is/i);
    expect(statusParagraph).toHaveTextContent('disconnected');
  });

  it('reconnects with a same-origin POST, then shows Disconnect and drops the consent helper text', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'enabled' }), { status: 200 }));
    render(<ConnectionControls initialStatus="disconnected" />);
    expect(screen.getByText(/reconnect lets an existing token work again/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/mcp/connection',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'reconnect' }) }),
    );
    expect(screen.queryByText(/reconnect lets an existing token work again/i)).not.toBeInTheDocument();
  });

  it('disables the button while the request is in flight, and re-enables it once it resolves', async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    render(<ConnectionControls initialStatus="enabled" />);
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    const button = screen.getByRole('button', { name: /disconnecting/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    resolveFetch(new Response(JSON.stringify({ status: 'disconnected' }), { status: 200 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconnect' })).not.toBeDisabled());
  });

  it('shows the error and keeps the old state when the request fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
    render(<ConnectionControls initialStatus="enabled" />);
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not/i));
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('treats a malformed payload as a failure and keeps the old state', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'bogus' }), { status: 200 }));
    render(<ConnectionControls initialStatus="enabled" />);
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not/i));
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('shows a specific message when the account is no longer eligible (404)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    render(<ConnectionControls initialStatus="enabled" />);
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/mcp access is no longer available/i));
  });
});

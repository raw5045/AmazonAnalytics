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

  it('shows the error and keeps the old state when the request fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
    render(<ConnectionControls initialStatus="enabled" />);
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not/i));
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FeedbackButton } from './FeedbackButton';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('FeedbackButton', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/explorer?rank_max=100&words_min=3');
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders only the header button until clicked', () => {
    render(<FeedbackButton />);
    expect(screen.getByRole('button', { name: 'Feedback' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Send feedback')).toBeInTheDocument();
  });

  it('posts the trimmed message plus the current page, then shows the thanks state', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    render(<FeedbackButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
    fireEvent.change(screen.getByLabelText('Your feedback'), {
      target: { value: '  The reviews filter is great, thanks!  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Thanks — got it.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/feedback');
    expect(JSON.parse(init.body as string)).toEqual({
      message: 'The reviews filter is great, thanks!',
      page: '/explorer?rank_max=100&words_min=3',
    });
  });

  it('blocks messages under 10 characters without a network call', () => {
    render(<FeedbackButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
    fireEvent.change(screen.getByLabelText('Your feedback'), { target: { value: 'too short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Please write at least 10 characters.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server error and keeps the typed text', async () => {
    const msg = "Couldn't send your feedback right now — please try again later.";
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: msg }));
    render(<FeedbackButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
    fireEvent.change(screen.getByLabelText('Your feedback'), {
      target: { value: 'Something worth keeping around.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(msg);
    expect((screen.getByLabelText('Your feedback') as HTMLTextAreaElement).value).toBe(
      'Something worth keeping around.',
    );
  });

  it('closes on Escape and returns focus to the header button', () => {
    render(<FeedbackButton />);
    const trigger = screen.getByRole('button', { name: 'Feedback' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

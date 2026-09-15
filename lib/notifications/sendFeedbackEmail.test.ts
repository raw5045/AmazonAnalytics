import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend };
    constructor(public apiKey: string) {}
  },
}));

import { sendFeedbackEmail } from './sendFeedbackEmail';

const input = {
  message: 'The watchlist digest arrived twice this week.',
  page: '/watchlist',
  user: { id: 'uuid-1', email: 'jane@example.com', name: 'Jane Doe' },
  appUrl: 'https://keywordquarry.com',
};

describe('sendFeedbackEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('RESEND_FROM', 'KeywordQuarry <notifications@keywordquarry.com>');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns not-configured without calling Resend when the API key is missing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const r = await sendFeedbackEmail(input);
    expect(r).toEqual({ sent: false, reason: 'email not configured' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('delivers to the support inbox with reply-to = the account email', async () => {
    mockSend.mockResolvedValueOnce({ data: { id: 'email_1' }, error: null });
    const r = await sendFeedbackEmail(input);
    expect(r).toEqual({ sent: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.to).toEqual(['support@keywordquarry.com']);
    expect(arg.replyTo).toBe('jane@example.com');
    expect(arg.from).toBe('KeywordQuarry <notifications@keywordquarry.com>');
    expect(arg.subject).toBe('💬 Feedback from Jane Doe');
    expect(String(arg.text)).toContain('Page: https://keywordquarry.com/watchlist');
  });

  it('reports send failed when Resend returns an error', async () => {
    mockSend.mockResolvedValueOnce({ data: null, error: { message: 'nope' } });
    expect(await sendFeedbackEmail(input)).toEqual({ sent: false, reason: 'send failed' });
  });

  it('reports send failed when Resend throws', async () => {
    mockSend.mockRejectedValueOnce(new Error('network'));
    expect(await sendFeedbackEmail(input)).toEqual({ sent: false, reason: 'send failed' });
  });
});

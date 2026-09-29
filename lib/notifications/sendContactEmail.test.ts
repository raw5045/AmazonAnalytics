import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consoleLines, spyOnConsole } from '@/tests/unit/consoleLines';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend };
    constructor(public apiKey: string) {}
  },
}));

import { sendContactEmail } from './sendContactEmail';

const input = { name: 'Jane Doe', email: 'jane@example.com', message: 'Is there an API?' };

describe('sendContactEmail', () => {
  let spies: ReturnType<typeof spyOnConsole>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('RESEND_FROM', 'KeywordQuarry <notifications@keywordquarry.com>');
    spies = spyOnConsole();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns not-configured without calling Resend when the API key is missing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    expect(await sendContactEmail(input)).toEqual({ sent: false, reason: 'email not configured' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('delivers to the support inbox with reply-to = the submitter', async () => {
    mockSend.mockResolvedValueOnce({ data: { id: 'email_1' }, error: null });
    expect(await sendContactEmail(input)).toEqual({ sent: true });
    const arg = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.to).toEqual(['support@keywordquarry.com']);
    expect(arg.replyTo).toBe('jane@example.com');
    expect(arg.subject).toBe('📨 Contact form: Jane Doe');
    expect(String(arg.text)).toContain('Is there an API?');
  });

  it('reports send failed on a Resend error and logs only its coded name and statusCode — never the message, which can echo the reply-to address', async () => {
    mockSend.mockResolvedValueOnce({
      data: null,
      error: { name: 'validation_error', statusCode: 403, message: `You can only send testing emails to your own email address (${input.email}).` },
    });
    expect(await sendContactEmail(input)).toEqual({ sent: false, reason: 'send failed' });
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes(input.email))).toBe(false);
    expect(lines.some((l) => l.includes('validation_error') && l.includes('403'))).toBe(true);
  });

  it('reports send failed when Resend throws and logs only the error name and code — never its message', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error(`socket hang up while sending to ${input.email}`), { code: 'ECONNRESET' }));
    expect(await sendContactEmail(input)).toEqual({ sent: false, reason: 'send failed' });
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes(input.email))).toBe(false);
    expect(lines.some((l) => l.includes('ECONNRESET'))).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consoleLines, spyOnConsole } from '@/tests/unit/consoleLines';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend };
    constructor(public apiKey: string) {}
  },
}));

import { sendWelcomeEmail } from './sendWelcomeEmail';

const input = { to: 'jane@example.com', name: 'Jane' };

describe('sendWelcomeEmail', () => {
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

  it('returns false without calling Resend when the API key is missing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    expect(await sendWelcomeEmail(input)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('delivers to the new member with reply-to = support', async () => {
    mockSend.mockResolvedValueOnce({ data: { id: 'email_1' }, error: null });
    expect(await sendWelcomeEmail(input)).toBe(true);
    const arg = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.to).toBe('jane@example.com');
    expect(arg.replyTo).toBe('support@keywordquarry.com');
    expect(arg.from).toBe('KeywordQuarry <notifications@keywordquarry.com>');
  });

  it('returns false on a Resend error and logs only its coded name and statusCode — never the message, which can echo the recipient address', async () => {
    mockSend.mockResolvedValueOnce({
      data: null,
      error: { name: 'validation_error', statusCode: 422, message: `Invalid \`to\` field. ${input.to} is not a valid email address.` },
    });
    expect(await sendWelcomeEmail(input)).toBe(false);
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes(input.to))).toBe(false);
    expect(lines.some((l) => l.includes('validation_error') && l.includes('422'))).toBe(true);
  });

  it('returns false when Resend throws and logs only the error name and code — never its message', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error(`socket hang up while sending to ${input.to}`), { code: 'ECONNRESET' }));
    expect(await sendWelcomeEmail(input)).toBe(false);
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes(input.to))).toBe(false);
    expect(lines.some((l) => l.includes('ECONNRESET'))).toBe(true);
  });
});

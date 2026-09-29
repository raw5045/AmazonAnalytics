import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend };
    constructor(public apiKey: string) {}
  },
}));

import { sendAskAiCeilingEmail } from './sendAskAiCeilingEmail';

const input = { to: 'owner@example.com', level: 80 as const, month: '2026-09-01', costMicro: 160_000_000, ceilingMicro: 200_000_000, questions: 4000 };

describe('sendAskAiCeilingEmail', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('RESEND_FROM', 'KeywordQuarry <notifications@keywordquarry.com>');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns not-configured without calling Resend when the API key is missing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const r = await sendAskAiCeilingEmail(input);
    expect(r).toEqual({ sent: false, reason: 'email not configured' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('delivers to the admin address', async () => {
    mockSend.mockResolvedValueOnce({ data: { id: 'email_1' }, error: null });
    const r = await sendAskAiCeilingEmail(input);
    expect(r).toEqual({ sent: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.to).toEqual(['owner@example.com']);
    expect(arg.from).toBe('KeywordQuarry <notifications@keywordquarry.com>');
    expect(arg.subject).toBe('Ask AI is at 80% of its monthly ceiling');
  });

  it('reports send failed on a Resend error, logs its coded name and statusCode, and never lets an address in result.error.message reach a console call (C-m8)', async () => {
    mockSend.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', statusCode: 422, message: `Invalid \`to\` field: ${input.to}` } });
    const r = await sendAskAiCeilingEmail(input);
    expect(r).toEqual({ sent: false, reason: 'send failed' });
    const everything: string[] = errorSpy.mock.calls.flat().map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a)));
    expect(everything.some((s) => s.includes(input.to))).toBe(false);
    expect(everything.some((s) => s.includes('validation_error') && s.includes('422'))).toBe(true);
  });

  it('reports send failed when Resend returns a null statusCode', async () => {
    mockSend.mockResolvedValueOnce({ data: null, error: { name: 'internal_server_error', statusCode: null, message: 'oops' } });
    expect(await sendAskAiCeilingEmail(input)).toEqual({ sent: false, reason: 'send failed' });
    const everything: string[] = errorSpy.mock.calls.flat().map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a)));
    expect(everything.some((s) => s.includes('"statusCode":null'))).toBe(true);
  });

  it('reports send failed when Resend throws, without leaking the thrown error text to the console', async () => {
    mockSend.mockRejectedValueOnce(new Error(`failed for ${input.to}`));
    expect(await sendAskAiCeilingEmail(input)).toEqual({ sent: false, reason: 'send failed' });
    const everything: string[] = errorSpy.mock.calls.flat().map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a)));
    expect(everything.some((s) => s.includes(input.to))).toBe(false);
  });
});

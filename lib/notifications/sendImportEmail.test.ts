import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consoleLines, spyOnConsole } from '@/tests/unit/consoleLines';

const { mockSend, mockWhere } = vi.hoisted(() => ({ mockSend: vi.fn(), mockWhere: vi.fn() }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend };
    constructor(public apiKey: string) {}
  },
}));
// Admin recipient lookup — db.select({ email }).from(users).where(...) — with no database behind it.
vi.mock('@/db/client', () => ({ db: { select: () => ({ from: () => ({ where: mockWhere }) }) } }));

import { sendImportEmail } from './sendImportEmail';

const ADMIN = 'admin@example.com';
const input = {
  outcome: 'completed' as const,
  filename: 'weekly-2026-09-26.csv',
  batchId: 'batch-1',
  durationMs: 60_000,
  rowsImported: 1_000,
  rowsInSummary: 900,
  latestWeek: '2026-09-26',
};

describe('sendImportEmail', () => {
  let spies: ReturnType<typeof spyOnConsole>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('RESEND_FROM', 'KeywordQuarry <notifications@keywordquarry.com>');
    mockWhere.mockResolvedValue([{ email: ADMIN }]);
    spies = spyOnConsole();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('skips the lookup and the send when the API key is missing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    await expect(sendImportEmail(input)).resolves.toBeUndefined();
    expect(mockWhere).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends to the admin recipients and logs a count, not the addresses', async () => {
    mockSend.mockResolvedValueOnce({ data: { id: 'email_1' }, error: null });
    await sendImportEmail(input);
    const arg = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.to).toEqual([ADMIN]);
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes('1 admin(s)'))).toBe(true);
    expect(lines.some((l) => l.includes(ADMIN))).toBe(false);
  });

  it('resolves on a Resend error and logs only its coded name and statusCode — never the message, which can echo a recipient address', async () => {
    mockSend.mockResolvedValueOnce({
      data: null,
      error: { name: 'validation_error', statusCode: 403, message: `You can only send testing emails to your own email address (${ADMIN}).` },
    });
    await expect(sendImportEmail(input)).resolves.toBeUndefined();
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes(ADMIN))).toBe(false);
    expect(lines.some((l) => l.includes('validation_error') && l.includes('403'))).toBe(true);
  });

  it('resolves when Resend throws and logs only the error name and code — never its message', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error(`socket hang up while sending to ${ADMIN}`), { code: 'ECONNRESET' }));
    await expect(sendImportEmail(input)).resolves.toBeUndefined();
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes(ADMIN))).toBe(false);
    expect(lines.some((l) => l.includes('ECONNRESET'))).toBe(true);
  });

  it('resolves without sending when the admin lookup fails', async () => {
    mockWhere.mockRejectedValueOnce(new Error('connection refused'));
    await expect(sendImportEmail(input)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

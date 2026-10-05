// lib/notifications/sendKeepaServiceAlarmEmail.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consoleLines, spyOnConsole } from '@/tests/unit/consoleLines';

const { mockSend, mockWhere } = vi.hoisted(() => ({ mockSend: vi.fn(), mockWhere: vi.fn() }));
vi.mock('resend', () => ({ Resend: class { emails = { send: mockSend }; constructor(public apiKey: string) {} } }));
vi.mock('@/db/client', () => ({ db: { select: () => ({ from: () => ({ where: mockWhere }) }) } }));

import { sendKeepaServiceAlarmEmail } from './sendKeepaServiceAlarmEmail';

const ADMIN = 'admin@example.com';
const input = { variant: 'down' as const, heartbeatAt: null, lastBatchAt: null };

describe('sendKeepaServiceAlarmEmail', () => {
  let spies: ReturnType<typeof spyOnConsole>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    mockWhere.mockResolvedValue([{ email: ADMIN }]);
    spies = spyOnConsole();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('skips the lookup and the send when the API key is missing, and reports nothing sent', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    await expect(sendKeepaServiceAlarmEmail(input)).resolves.toBe(false);
    expect(mockWhere).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends to the admins, logs a count but never an address, and reports the send', async () => {
    mockSend.mockResolvedValueOnce({ data: { id: 'email_1' }, error: null });
    await expect(sendKeepaServiceAlarmEmail(input)).resolves.toBe(true);
    const arg = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.to).toEqual([ADMIN]);
    expect(arg.subject).toBe('Keepa service down');
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes('1 admin(s)'))).toBe(true);
    expect(lines.some((l) => l.includes(ADMIN))).toBe(false);
  });

  it('reports nothing sent when there is no admin to send to', async () => {
    mockWhere.mockResolvedValueOnce([]);
    await expect(sendKeepaServiceAlarmEmail(input)).resolves.toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('resolves false on a Resend error and logs only the coded name and status', async () => {
    mockSend.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', statusCode: 403, message: `only ${ADMIN}` } });
    await expect(sendKeepaServiceAlarmEmail(input)).resolves.toBe(false);
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes('validation_error') && l.includes('403'))).toBe(true);
    expect(lines.some((l) => l.includes(ADMIN))).toBe(false);
  });

  it('resolves false when Resend throws and logs only the error name and code — never its message', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error(`socket hang up while sending to ${ADMIN}`), { code: 'ECONNRESET' }));
    await expect(sendKeepaServiceAlarmEmail(input)).resolves.toBe(false);
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes(ADMIN))).toBe(false);
    expect(lines.some((l) => l.includes('ECONNRESET'))).toBe(true);
  });

  it('resolves false without sending when the admin lookup fails, logging only coded fields', async () => {
    mockWhere.mockRejectedValueOnce(Object.assign(new Error(`lookup failed near ${ADMIN}`), { code: '57P01' }));
    await expect(sendKeepaServiceAlarmEmail(input)).resolves.toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes(ADMIN))).toBe(false);
    expect(lines.some((l) => l.includes('lookup_failed') && l.includes('57P01'))).toBe(true);
  });
});

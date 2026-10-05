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

  it('skips the lookup and the send when the API key is missing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    await sendKeepaServiceAlarmEmail(input);
    expect(mockWhere).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends to the admins and logs a count, never an address', async () => {
    mockSend.mockResolvedValueOnce({ data: { id: 'email_1' }, error: null });
    await sendKeepaServiceAlarmEmail(input);
    const arg = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.to).toEqual([ADMIN]);
    expect(arg.subject).toBe('Keepa service down');
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes('1 admin(s)'))).toBe(true);
    expect(lines.some((l) => l.includes(ADMIN))).toBe(false);
  });

  it('resolves on a Resend error and logs only the coded name and status', async () => {
    mockSend.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', statusCode: 403, message: `only ${ADMIN}` } });
    await expect(sendKeepaServiceAlarmEmail(input)).resolves.toBeUndefined();
    const lines = consoleLines(...spies);
    expect(lines.some((l) => l.includes('validation_error') && l.includes('403'))).toBe(true);
    expect(lines.some((l) => l.includes(ADMIN))).toBe(false);
  });
});

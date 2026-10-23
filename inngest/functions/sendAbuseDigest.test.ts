// inngest/functions/sendAbuseDigest.test.ts
/**
 * The daily usage-digest job (spec 2026-07-13; retention from spec 2026-10-23 §5b) under a mocked Inngest client,
 * sender and db: the cron's config, the send step, then the prune-slow-queries step (rows older than 90 days, one
 * DELETE, the count logged), and the prune's fail-soft path (coded fields only; the run still succeeds). The
 * digest itself is covered in lib/notifications/abuseDigest/.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { consoleLines, spyOnConsole } from '@/tests/unit/consoleLines';

const { mockCreateFunction, mockSend, mockDelete, mockWhere } = vi.hoisted(() => ({
  // The real createFunction returns an InngestFunction; this one hands back its two arguments, so the test reads
  // the config and calls the handler directly.
  mockCreateFunction: vi.fn((config: unknown, handler: unknown) => ({ config, handler })),
  mockSend: vi.fn(),
  mockDelete: vi.fn(),
  mockWhere: vi.fn(),
}));

vi.mock('@/inngest/client', () => ({ inngest: { createFunction: mockCreateFunction } }));
vi.mock('@/lib/notifications/abuseDigest/sendAbuseDigest', () => ({ sendAbuseDigest: mockSend }));
vi.mock('@/db/client', () => ({ db: { delete: mockDelete } }));

import { slowQueries } from '@/db/schema';
import { sendAbuseDigestFn, SLOW_QUERIES_RETENTION_DAYS } from './sendAbuseDigest';

type StepRun = (name: string, fn: () => unknown) => Promise<unknown>;
// What the mocked createFunction returned when the module loaded.
const { config, handler } = sendAbuseDigestFn as unknown as {
  config: unknown;
  handler: (ctx: { step: { run: StepRun } }) => Promise<unknown>;
};

/** Inngest's step tool, reduced to what the handler uses: each step runs its callback once and returns its result. */
function stepTool() {
  const names: string[] = [];
  const run: StepRun = async (name, fn) => {
    names.push(name);
    return fn();
  };
  return { names, step: { run } };
}

const SENT = { day: '2026-10-22', sent: true, recipients: 1, flags: 0, activeUsers: 4 };
const NOW = new Date('2026-10-23T11:30:00.000Z');
const PRUNE_FAILED = '[abuse-digest] slow_queries prune failed (rows kept until the next run)';

describe('sendAbuseDigestFn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mockSend.mockReset().mockResolvedValue(SENT);
    mockDelete.mockReset().mockReturnValue({ where: mockWhere });
    mockWhere.mockReset().mockResolvedValue({ rowCount: 3 });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks(); // the console spies
  });

  it('keeps its schedule: daily at 7:30 ET, one run at a time, two retries', () => {
    expect(config).toEqual({
      id: 'send-abuse-digest',
      name: 'Send daily admin abuse digest',
      retries: 2,
      concurrency: { limit: 1 },
      triggers: [{ cron: 'TZ=America/New_York 30 7 * * *' }],
    });
  });

  it('sends, then deletes the slow_queries rows older than 90 days in one statement, logs the count and returns it with the send result', async () => {
    const [error, warn, log] = spyOnConsole();
    const { names, step } = stepTool();

    await expect(handler({ step })).resolves.toEqual({ ...SENT, slowQueriesPruned: 3 });

    expect(names).toEqual(['send', 'prune-slow-queries']);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.invocationCallOrder[0]).toBeLessThan(mockDelete.mock.invocationCallOrder[0]);
    expect(SLOW_QUERIES_RETENTION_DAYS).toBe(90);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(slowQueries);
    expect(mockWhere).toHaveBeenCalledTimes(1);
    // 90 days before the run's clock.
    expect(new PgDialect().sqlToQuery(mockWhere.mock.calls[0][0])).toMatchObject({ sql: '"slow_queries"."happened_at" < $1', params: ['2026-07-25T11:30:00.000Z'] });
    expect(consoleLines(log)).toEqual(['[abuse-digest] pruned 3 slow_queries rows older than 90 days']);
    expect(consoleLines(error, warn)).toEqual([]);
  });

  it('a skipped send (the day already went out) still prunes', async () => {
    spyOnConsole();
    const skipped = { ...SENT, sent: false, recipients: 0, skipped: 'already_sent' };
    mockSend.mockResolvedValue(skipped);
    const { names, step } = stepTool();

    await expect(handler({ step })).resolves.toEqual({ ...skipped, slowQueriesPruned: 3 });
    expect(names).toEqual(['send', 'prune-slow-queries']);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('a driver without a row count reads as 0 pruned', async () => {
    const [, , log] = spyOnConsole();
    mockWhere.mockResolvedValue({ rowCount: null });
    const { step } = stepTool();

    await expect(handler({ step })).resolves.toEqual({ ...SENT, slowQueriesPruned: 0 });
    expect(consoleLines(log)).toEqual(['[abuse-digest] pruned 0 slow_queries rows older than 90 days']);
  });

  it('a failed prune warns with the error class and code only, the step returns 0, and the run still succeeds', async () => {
    const [error, warn, log] = spyOnConsole();
    // drizzle rethrows a failed statement as DrizzleQueryError (its own message embeds the SQL and the params); errFields reads the cause.
    const cause = Object.assign(new Error('SECRET relation "slow_queries" does not exist'), { code: '42P01' });
    mockWhere.mockRejectedValue(new DrizzleQueryError('delete from "slow_queries" where "happened_at" < $1 -- SECRET', ['SECRET-PARAM'], cause));
    const { names, step } = stepTool();

    await expect(handler({ step })).resolves.toEqual({ ...SENT, slowQueriesPruned: 0 });

    expect(names).toEqual(['send', 'prune-slow-queries']);
    expect(consoleLines(warn)).toEqual([`${PRUNE_FAILED} {"error":"Error","code":"42P01"}`]);
    expect(consoleLines(error, log)).toEqual([]);
    expect(consoleLines(error, warn, log).join('\n')).not.toContain('SECRET');
  });

  it('a prune that throws before its statement runs is caught the same way', async () => {
    const [, warn] = spyOnConsole();
    mockDelete.mockImplementation(() => {
      throw new TypeError('SECRET db.delete is not a function');
    });
    const { step } = stepTool();

    await expect(handler({ step })).resolves.toEqual({ ...SENT, slowQueriesPruned: 0 });
    expect(consoleLines(warn)).toEqual([`${PRUNE_FAILED} {"error":"TypeError"}`]);
  });

  it('a failed send fails the run (Inngest retries it) and nothing is pruned on that attempt', async () => {
    spyOnConsole();
    mockSend.mockRejectedValue(new Error('[abuse-digest] Resend error: application_error (status 500)'));
    const { names, step } = stepTool();

    await expect(handler({ step })).rejects.toThrow('Resend error');
    expect(names).toEqual(['send']);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

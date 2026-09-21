import { describe, it, expect, vi, beforeEach } from 'vitest';
// @/lib/env parses process.env at import time (throws on the missing NEXT_PUBLIC_* vars without
// a mock — see lib/research/cursor.test.ts). ./limits pulls it in transitively (this file imports
// DEFAULT_LIMITS directly), so a minimal stub is enough to let the module load.
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
const { execute, bumpBy } = vi.hoisted(() => ({ execute: vi.fn(), bumpBy: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/db/client', () => ({ db: { execute } }));
vi.mock('@/lib/activity/bump', () => ({ bumpUserActivityBy: bumpBy }));
import { minuteFloor, recordMcpActivity, reserveResearchRequest } from './usage';
import { DEFAULT_LIMITS } from './limits';

const now = new Date('2026-09-21T12:00:30Z');
const args = { userId: 'u1', channel: 'mcp' as const, rows: 50, now, limits: DEFAULT_LIMITS };

describe('reserveResearchRequest', () => {
  beforeEach(() => vi.clearAllMocks());
  it('floors to the minute and issues one atomic upsert returning the new counts', async () => {
    execute.mockResolvedValueOnce({ rows: [{ requests: 3, rows: 150 }] });
    expect(minuteFloor(now).toISOString()).toBe('2026-09-21T12:00:00.000Z');
    expect(await reserveResearchRequest(args)).toEqual({ requests: 3, rows: 150 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(execute.mock.calls[0][0])).toContain('ON CONFLICT (user_id, channel, bucket_start) DO UPDATE');
  });
  it('is RATE_LIMITED past either limit, with the seconds left in the minute', async () => {
    execute.mockResolvedValueOnce({ rows: [{ requests: 61, rows: 100 }] });
    await expect(reserveResearchRequest(args)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 30 });
    execute.mockResolvedValueOnce({ rows: [{ requests: 2, rows: 6050 }] });
    await expect(reserveResearchRequest(args)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('passes when exactly at the limit — pins > not >=', async () => {
    execute.mockResolvedValueOnce({ rows: [{ requests: 60, rows: 6000 }] });
    await expect(reserveResearchRequest(args)).resolves.toEqual({ requests: 60, rows: 6000 });
  });
  it('retryAfterSeconds is the seconds left in the minute: 60 right on the boundary, 1 just before the next one', async () => {
    execute.mockResolvedValueOnce({ rows: [{ requests: 61, rows: 0 }] });
    await expect(reserveResearchRequest({ ...args, now: new Date('2026-09-21T12:00:00.000Z') })).rejects.toMatchObject({ retryAfterSeconds: 60 });
    execute.mockResolvedValueOnce({ rows: [{ requests: 61, rows: 0 }] });
    await expect(reserveResearchRequest({ ...args, now: new Date('2026-09-21T12:00:59.999Z') })).rejects.toMatchObject({ retryAfterSeconds: 1 });
  });
  it('a rows: 0 reservation resolves and floors the bound bucket to the minute', async () => {
    execute.mockResolvedValueOnce({ rows: [{ requests: 4, rows: 150 }] });
    await expect(reserveResearchRequest({ ...args, rows: 0 })).resolves.toEqual({ requests: 4, rows: 150 });
    expect(JSON.stringify(execute.mock.calls[0][0])).toContain('2026-09-21T12:00:00.000Z');
  });
  it('rejects a negative or non-integer rows before any DB call', async () => {
    await expect(reserveResearchRequest({ ...args, rows: -1 })).rejects.toThrow(/non-negative safe integer/);
    await expect(reserveResearchRequest({ ...args, rows: 1.5 })).rejects.toThrow(/non-negative safe integer/);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('recordMcpActivity', () => {
  it('bumps a request and, when rows were returned, the rows metric by that count', () => {
    recordMcpActivity('u1', 37);
    expect(bumpBy).toHaveBeenCalledWith('u1', 'mcp_request', 1);
    expect(bumpBy).toHaveBeenCalledWith('u1', 'mcp_rows', 37);
    bumpBy.mockClear();
    recordMcpActivity('u1', 0);
    expect(bumpBy).toHaveBeenCalledTimes(1);
  });
  it('is fire-and-forget: returns undefined synchronously, not a Promise', () => {
    const result = recordMcpActivity('u1', 1);
    expect(result).toBeUndefined();
  });
});

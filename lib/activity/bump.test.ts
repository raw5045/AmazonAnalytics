import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockOnConflictDoUpdate, mockValues, mockInsert } = vi.hoisted(() => {
  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  return { mockOnConflictDoUpdate, mockValues, mockInsert };
});

vi.mock('@/db/client', () => ({ db: { insert: mockInsert } }));

import { DrizzleQueryError } from 'drizzle-orm';
import { consoleLines } from '@/tests/unit/consoleLines';
import { bumpAppActivity, bumpUserActivity, bumpUserActivityBy } from './bump';

describe('bumpUserActivityBy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('makes no DB call and does not warn for by <= 0 (a legitimate integer)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bumpUserActivityBy('u1', 'mcp_rows', 0);
    await bumpUserActivityBy('u1', 'mcp_rows', -5);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('makes no DB call but warns for a non-integer by (programmer error)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bumpUserActivityBy('u1', 'mcp_rows', 1.5);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('inserts/upserts with count = by for a positive integer', async () => {
    await bumpUserActivityBy('u1', 'mcp_rows', 37);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', metric: 'mcp_rows', count: 37 }));
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it('swallows a DB error to console.warn instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockOnConflictDoUpdate.mockRejectedValueOnce(new Error('db down'));
    await expect(bumpUserActivityBy('u1', 'mcp_rows', 5)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('a failed bump logs coded fields only: never the statement, its params or a message', () => {
  beforeEach(() => vi.clearAllMocks());

  /** What drizzle rejects with when the upsert fails: its own message embeds the statement and the bound params; errFields reads the cause. */
  const secretFailure = () =>
    new DrizzleQueryError(
      'insert into "user_activity_daily" ("user_id", "day", "metric", "count") values ($1, $2, $3, $4) -- SECRET',
      ['SECRET-USER-ID', '2026-10-23', 'product_view', 1],
      Object.assign(new Error('SECRET connection to the database host was refused'), { code: '08006' }),
    );

  const CASES: Array<[string, () => Promise<void>, string]> = [
    ['bumpUserActivity', () => bumpUserActivity('u1', 'product_view'), 'product_view'],
    ['bumpUserActivityBy', () => bumpUserActivityBy('u1', 'mcp_rows', 5), 'mcp_rows'],
    ['bumpAppActivity', () => bumpAppActivity('contact_submission'), 'contact_submission'],
  ];

  it.each(CASES)('%s: resolves and warns one line with the metric, the error class and the code', async (fn, bump, metric) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockOnConflictDoUpdate.mockRejectedValueOnce(secretFailure());
    await expect(bump()).resolves.toBeUndefined();
    expect(consoleLines(warn)).toEqual([`[activity] ${fn} failed {"metric":"${metric}","error":"Error","code":"08006"}`]);
    expect(consoleLines(warn).join('\n')).not.toContain('SECRET');
    warn.mockRestore();
  });

  it('an uncoded failure warns the same line without a code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockOnConflictDoUpdate.mockRejectedValueOnce(new TypeError('SECRET fetch failed'));
    await expect(bumpUserActivity('u1', 'explorer_query')).resolves.toBeUndefined();
    expect(consoleLines(warn)).toEqual(['[activity] bumpUserActivity failed {"metric":"explorer_query","error":"TypeError"}']);
    warn.mockRestore();
  });
});

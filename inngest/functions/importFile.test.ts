import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const {
  mockDownloadStream,
  mockExecute,
  mockDelete,
  mockUpdate,
  mockInsert,
  mockFindFile,
  mockPoolConnect,
  mockPoolEnd,
  mockPoolOn,
  mockPoolCtor,
  mockClientRelease,
  mockClientQuery,
  mockEnqueueWeek,
  mockBuildTopAsinsWeek,
  mockRefreshSummary,
  mockSendImportEmail,
  mockInngestSend,
} = vi.hoisted(() => ({
  mockDownloadStream: vi.fn(),
  mockExecute: vi.fn().mockResolvedValue(undefined),
  mockDelete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  mockUpdate: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  }),
  mockInsert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  }),
  mockFindFile: vi.fn(),
  mockPoolConnect: vi.fn(),
  mockPoolEnd: vi.fn().mockResolvedValue(undefined),
  mockPoolOn: vi.fn(),
  mockPoolCtor: vi.fn(),
  mockClientRelease: vi.fn(),
  mockClientQuery: vi.fn(),
  mockEnqueueWeek: vi.fn(),
  mockBuildTopAsinsWeek: vi.fn(),
  mockRefreshSummary: vi.fn(),
  mockSendImportEmail: vi.fn(),
  mockInngestSend: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  env: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  },
}));

vi.mock('pg', () => ({
  Pool: class {
    connect = mockPoolConnect;
    end = mockPoolEnd;
    on = mockPoolOn;
    constructor(options: unknown) {
      mockPoolCtor(options); // every new Pool(options), in order
    }
  },
}));

vi.mock('pg-copy-streams', () => ({
  from: vi.fn((_sql: string) => _sql),
}));

vi.mock('@/lib/storage/r2', () => ({ downloadStreamFromR2: mockDownloadStream }));
vi.mock('@/db/client', () => ({
  db: {
    execute: mockExecute,
    delete: mockDelete,
    update: mockUpdate,
    insert: mockInsert,
    query: {
      uploadedFiles: { findFirst: mockFindFile },
    },
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        execute: mockExecute,
        insert: mockInsert,
        update: mockUpdate,
        delete: mockDelete,
      }),
    ),
  },
}));

// The real EnqueueWeekError stays, so the hook's instanceof skip check runs for real.
vi.mock('@/lib/keepa/enqueueWeek', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/keepa/enqueueWeek')>()),
  enqueueWeek: mockEnqueueWeek,
}));
// Likewise the reverse-table build: the real TopAsinsBuildError stays for the phase's skip check.
vi.mock('@/lib/topAsins/buildWeek', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/topAsins/buildWeek')>()),
  buildTopAsinsWeek: mockBuildTopAsinsWeek,
}));
vi.mock('@/inngest/functions/refreshSummary', () => ({
  refreshKeywordCurrentSummary: mockRefreshSummary,
}));
vi.mock('@/lib/notifications/sendImportEmail', () => ({ sendImportEmail: mockSendImportEmail }));
vi.mock('@/inngest/client', () => ({
  inngest: { send: mockInngestSend, createFunction: vi.fn(() => ({})) },
}));

import { processFileImport } from './importFile';
import { EnqueueWeekError } from '@/lib/keepa/enqueueWeek';
import { TopAsinsBuildError } from '@/lib/topAsins/buildWeek';

function createFakeCopyStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

describe('processFileImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolEnd.mockResolvedValue(undefined);
  });

  it('streams the fixture through staging and into keyword_weekly_metrics', async () => {
    const buf = readFileSync(path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'));
    // Re-entry lock UPDATE ... RETURNING id (importFile.ts:595-605) — one row
    // back means the lock was acquired, so processFileImport proceeds past
    // the `lockResult.rows.length === 0` branch instead of throwing.
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'f1' }] });
    mockFindFile.mockResolvedValueOnce({
      id: 'f1',
      batchId: 'b1',
      storageKey: 'k',
      weekEndDate: '2026-04-11',
      isReplacement: false,
    });
    mockDownloadStream.mockResolvedValueOnce(Readable.from(buf));

    const { stream: copyStream, lines } = createFakeCopyStream();
    mockClientQuery.mockReturnValueOnce(copyStream);
    mockPoolConnect.mockResolvedValueOnce({
      query: mockClientQuery,
      release: mockClientRelease,
    });

    const result = await processFileImport({ uploadedFileId: 'f1' });
    expect(result.rowsImported).toBeGreaterThan(90);
    expect(lines.length).toBe(result.rowsImported);
    expect(mockClientRelease).toHaveBeenCalled();
    expect(mockPoolEnd).toHaveBeenCalled();
  });
});

describe('processFileImport — keepa_enqueue hook', () => {
  const fixture = readFileSync(path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'));
  const hookClient = { on: vi.fn(), release: vi.fn(), query: vi.fn() };
  const topAsinsClient = { on: vi.fn(), release: vi.fn(), query: vi.fn() };
  // Every db.insert(...).values(row) lands here; the import_phase_timings rows carry `phase`.
  const insertValues = vi.fn().mockReturnValue({
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  });
  // The first connect() is the COPY pool's client; the second is the Keepa hook's, the third the
  // top-ASINs phase's.
  const copyClient = () => {
    const { stream } = createFakeCopyStream();
    return { query: vi.fn(() => stream), release: vi.fn() };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute
      .mockReset()
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce({ rows: [{ id: 'f1' }] });
    mockFindFile.mockReset().mockResolvedValue({
      id: 'f1',
      batchId: 'b1',
      storageKey: 'k',
      weekEndDate: '2026-04-11',
      isReplacement: false,
    });
    mockDownloadStream.mockReset().mockResolvedValue(Readable.from(fixture));
    mockPoolConnect
      .mockReset()
      .mockResolvedValueOnce(copyClient())
      .mockResolvedValueOnce(hookClient)
      .mockResolvedValueOnce(topAsinsClient);
    mockPoolEnd.mockReset().mockResolvedValue(undefined);
    mockInsert.mockReset().mockReturnValue({ values: insertValues });
    mockRefreshSummary
      .mockReset()
      .mockResolvedValue({ rowsWritten: 1, currentWeekEndDate: '2026-04-11' });
    mockSendImportEmail.mockReset().mockResolvedValue(undefined);
    mockInngestSend.mockReset().mockResolvedValue({ ids: [] });
    mockEnqueueWeek.mockReset();
    // A successful build by default, so the phase after the Keepa hook adds no stray failure line.
    mockBuildTopAsinsWeek
      .mockReset()
      .mockResolvedValue({ rows: 3, previousWeek: null, carriedFrom: 'none' });
  });

  afterEach(() => {
    vi.restoreAllMocks(); // the console spies
    mockPoolConnect.mockReset(); // drops a hook client the replay case never took
  });

  const spyConsole = () => ({
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    err: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  });
  const keepaLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('[keepa-enqueue]'));
  const enqueueTimings = () =>
    insertValues.mock.calls
      .map(([row]) => row as { phase?: string; rowsAffected?: number | null })
      .filter((row) => row.phase === 'keepa_enqueue');

  it('enqueues the imported week once, before the summary refresh, and cleans up', async () => {
    const { log } = spyConsole();
    mockEnqueueWeek.mockResolvedValue({
      inserted: 5,
      updated: 7,
      retired: 2,
      vacuumed: false,
      vacuumError: '57014',
    });

    await processFileImport({ uploadedFileId: 'f1' });

    expect(mockEnqueueWeek).toHaveBeenCalledTimes(1);
    expect(mockEnqueueWeek).toHaveBeenCalledWith(hookClient, '2026-04-11');
    expect(mockEnqueueWeek.mock.invocationCallOrder[0]).toBeLessThan(
      mockRefreshSummary.mock.invocationCallOrder[0],
    );
    expect(hookClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(hookClient.on.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnqueueWeek.mock.invocationCallOrder[0],
    );
    expect(mockPoolOn).toHaveBeenCalledTimes(3); // the COPY pool's guard + the two hook pools'
    expect(mockPoolOn).toHaveBeenNthCalledWith(2, 'error', expect.any(Function)); // the Keepa hook's
    expect(hookClient.release).toHaveBeenCalledTimes(1);
    expect(mockPoolEnd).toHaveBeenCalledTimes(3); // the COPY pool + the two hook pools
    expect(keepaLines(log)).toEqual([
      '[keepa-enqueue] week 2026-04-11: inserted=5 updated=7 retired=2 vacuumed=false vacuumError=57014',
    ]);
    expect(enqueueTimings()).toEqual([expect.objectContaining({ rowsAffected: 12 })]);
  });

  it('a database failure logs only the week, stage, error name and code; the import completes', async () => {
    const { log, err } = spyConsole();
    mockEnqueueWeek.mockRejectedValue(
      Object.assign(new Error('SECRET failed query params'), { name: 'error', code: '57014' }),
    );

    await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({
      rowsImported: expect.any(Number),
    });

    expect(keepaLines(err)).toEqual([
      '[keepa-enqueue] failed (import continues) {"week":"2026-04-11","stage":"enqueue","error":"error","code":"57014"}',
    ]);
    expect([...log.mock.calls, ...err.mock.calls].flat().join(' ')).not.toContain('SECRET');
    expect(hookClient.release).toHaveBeenCalledTimes(1);
    expect(mockPoolEnd).toHaveBeenCalledTimes(3);
    expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
    expect(enqueueTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
  });

  it('a connect failure never fails the import and never reaches enqueueWeek', async () => {
    const { err } = spyConsole();
    mockPoolConnect
      .mockReset()
      .mockResolvedValueOnce(copyClient())
      .mockRejectedValueOnce(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
      )
      .mockResolvedValueOnce(topAsinsClient);

    await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({
      rowsImported: expect.any(Number),
    });

    expect(mockEnqueueWeek).not.toHaveBeenCalled();
    expect(keepaLines(err)).toEqual([
      '[keepa-enqueue] failed (import continues) {"week":"2026-04-11","stage":"connect","error":"Error","code":"ECONNREFUSED"}',
    ]);
    expect(mockPoolEnd).toHaveBeenCalledTimes(3);
    expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
    expect(enqueueTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
  });

  it('an older week is an expected skip, not an error', async () => {
    const { log, err } = spyConsole();
    mockEnqueueWeek.mockRejectedValue(
      new EnqueueWeekError('enqueue_week_older_than_scope', 'older than the scope week'),
    );

    await processFileImport({ uploadedFileId: 'f1' });

    expect(keepaLines(log)).toEqual([
      '[keepa-enqueue] skipped: enqueue_week_older_than_scope (week 2026-04-11)',
    ]);
    expect(err).not.toHaveBeenCalled();
    expect(hookClient.release).toHaveBeenCalledTimes(1);
    expect(enqueueTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
  });

  it('replay runs (skipRefresh) skip the hook', async () => {
    await processFileImport({ uploadedFileId: 'f1', skipRefresh: true });

    expect(mockEnqueueWeek).not.toHaveBeenCalled();
    expect(mockPoolConnect).toHaveBeenCalledTimes(1); // the COPY pool only
    expect(enqueueTimings()).toEqual([]);
  });

  // The phase after keepa_enqueue (spec 2026-10-09 §4.1): its own pool and the same fail-soft
  // shape, so these tests share this block's setup (three pools: COPY, Keepa hook, this phase).
  describe('top_asins_build phase', () => {
    beforeEach(() => {
      // The Keepa hook succeeds, so the only console.error lines are this phase's.
      mockEnqueueWeek.mockResolvedValue({ inserted: 0, updated: 0, retired: 0, vacuumed: false });
    });

    const topAsinsLines = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('[top-asins]'));
    const topAsinsTimings = () =>
      insertValues.mock.calls
        .map(([row]) => row as { phase?: string; rowsAffected?: number | null })
        .filter((row) => row.phase === 'top_asins_build');

    it('builds the imported week once, after keepa_enqueue and before the summary refresh, and cleans up', async () => {
      const { log } = spyConsole();
      mockBuildTopAsinsWeek.mockResolvedValue({
        rows: 21,
        previousWeek: '2026-04-04',
        carriedFrom: 'current',
        analyzeError: '57014',
      });

      await processFileImport({ uploadedFileId: 'f1' });

      expect(mockBuildTopAsinsWeek).toHaveBeenCalledTimes(1);
      expect(mockBuildTopAsinsWeek).toHaveBeenCalledWith(topAsinsClient, '2026-04-11');
      expect(mockEnqueueWeek.mock.invocationCallOrder[0]).toBeLessThan(
        mockBuildTopAsinsWeek.mock.invocationCallOrder[0],
      );
      expect(mockBuildTopAsinsWeek.mock.invocationCallOrder[0]).toBeLessThan(
        mockRefreshSummary.mock.invocationCallOrder[0],
      );
      const order = ['keepa_enqueue', 'top_asins_build', 'summary_refresh'];
      const phaseRows = insertValues.mock.calls
        .map(([row]) => (row as { phase?: string }).phase)
        .filter((phase) => phase !== undefined && order.includes(phase));
      expect(phaseRows).toEqual(order); // one timing row each, in this order
      expect(topAsinsClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(topAsinsClient.on.mock.invocationCallOrder[0]).toBeLessThan(
        mockBuildTopAsinsWeek.mock.invocationCallOrder[0],
      );
      expect(mockPoolOn).toHaveBeenCalledTimes(3); // the COPY pool's guard + the two hook pools'
      expect(mockPoolOn).toHaveBeenLastCalledWith('error', expect.any(Function)); // this phase's
      expect(topAsinsClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(3); // the COPY pool + the two hook pools
      expect(topAsinsLines(log)).toEqual([
        '[top-asins] week 2026-04-11: rows=21 previous=2026-04-04 carried=current analyzeError=57014',
      ]);
    });

    it('an older week is an expected skip, not an error', async () => {
      const { log, err } = spyConsole();
      mockBuildTopAsinsWeek.mockRejectedValue(
        new TopAsinsBuildError(
          'top_asins_older_than_meta',
          'week 2026-04-11 is older than the built week 2026-04-18',
        ),
      );

      await processFileImport({ uploadedFileId: 'f1' });

      expect(topAsinsLines(log)).toEqual([
        '[top-asins] skipped: top_asins_older_than_meta (week 2026-04-11)',
      ]);
      expect(err).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join(' ')).not.toContain('2026-04-18'); // the message stays out
      expect(topAsinsClient.release).toHaveBeenCalledTimes(1);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(topAsinsTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('a database failure logs only the week, stage, error name and code; the import completes', async () => {
      const { log, err } = spyConsole();
      mockBuildTopAsinsWeek.mockRejectedValue(
        Object.assign(new Error('SECRET failed query params'), { name: 'error', code: '57014' }),
      );

      await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({
        rowsImported: expect.any(Number),
      });

      expect(topAsinsLines(err)).toEqual([
        '[top-asins] failed (import continues) {"week":"2026-04-11","stage":"build","error":"error","code":"57014"}',
      ]);
      expect([...log.mock.calls, ...err.mock.calls].flat().join(' ')).not.toContain('SECRET');
      expect(topAsinsClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(3);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(topAsinsTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('a build error other than the older-week skip is a failure, logged by its code only', async () => {
      const { err } = spyConsole();
      mockBuildTopAsinsWeek.mockRejectedValue(
        new TopAsinsBuildError('top_asins_no_rows', 'SECRET week 2026-04-11 produced no rows'),
      );

      await processFileImport({ uploadedFileId: 'f1' });

      expect(topAsinsLines(err)).toEqual([
        '[top-asins] failed (import continues) {"week":"2026-04-11","stage":"build","error":"TopAsinsBuildError","code":"top_asins_no_rows"}',
      ]);
      expect(err.mock.calls.flat().join(' ')).not.toContain('SECRET');
      expect(topAsinsTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('a connect failure never fails the import and never reaches buildTopAsinsWeek', async () => {
      const { err } = spyConsole();
      mockPoolConnect
        .mockReset()
        .mockResolvedValueOnce(copyClient())
        .mockResolvedValueOnce(hookClient)
        .mockRejectedValueOnce(
          Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
        );

      await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({
        rowsImported: expect.any(Number),
      });

      expect(mockBuildTopAsinsWeek).not.toHaveBeenCalled();
      expect(topAsinsLines(err)).toEqual([
        '[top-asins] failed (import continues) {"week":"2026-04-11","stage":"connect","error":"Error","code":"ECONNREFUSED"}',
      ]);
      expect(mockPoolEnd).toHaveBeenCalledTimes(3);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(topAsinsTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('replay runs (skipRefresh) never build', async () => {
      await processFileImport({ uploadedFileId: 'f1', skipRefresh: true });

      expect(mockBuildTopAsinsWeek).not.toHaveBeenCalled();
      expect(mockPoolConnect).toHaveBeenCalledTimes(1); // the COPY pool only
      expect(topAsinsTimings()).toEqual([]);
    });

    it('records the rows the build wrote as the phase row count', async () => {
      const { log } = spyConsole();
      mockBuildTopAsinsWeek.mockResolvedValue({
        rows: 8_123_456,
        previousWeek: null,
        carriedFrom: 'none',
      });

      await processFileImport({ uploadedFileId: 'f1' });

      expect(topAsinsTimings()).toEqual([expect.objectContaining({ rowsAffected: 8_123_456 })]);
      expect(topAsinsLines(log)).toEqual([
        '[top-asins] week 2026-04-11: rows=8123456 previous=none carried=none',
      ]);
    });

    it('opens its own pool: one connection, 30-minute statement timeout, keepalive, 20 s connect timeout', async () => {
      await processFileImport({ uploadedFileId: 'f1' });

      // Pools are built in order: the COPY pool, the Keepa hook's, this phase's.
      expect(mockPoolCtor).toHaveBeenCalledTimes(3);
      expect(mockPoolCtor.mock.calls[2][0]).toMatchObject({
        connectionString: 'postgres://test:test@localhost:5432/test',
        max: 1,
        statement_timeout: 1_800_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
        connectionTimeoutMillis: 20_000,
      });
    });
  });
});

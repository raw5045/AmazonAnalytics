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
  mockBuildKeywordCounts,
  mockBuildCrosswalk,
  mockBuildFacets,
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
  mockBuildKeywordCounts: vi.fn(),
  mockBuildCrosswalk: vi.fn(),
  mockBuildFacets: vi.fn(),
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

// The real R2StreamError and isRetryableR2Error stay, so the COPY retry classifies errors for real.
vi.mock('@/lib/storage/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/r2')>()),
  downloadStreamFromR2: mockDownloadStream,
}));
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
// Likewise the crosswalk build: the real BaCrosswalkError stays importable.
vi.mock('@/lib/baCategory/buildCrosswalk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/baCategory/buildCrosswalk')>()),
  buildCrosswalk: mockBuildCrosswalk,
}));
vi.mock('@/lib/products/buildCategoryFacets', () => ({ buildProductCategoryFacets: mockBuildFacets }));
// Likewise the keyword-count build: the real KeywordCountsBuildError stays for the coded-failure case.
vi.mock('@/lib/products/buildKeywordCounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/products/buildKeywordCounts')>()),
  buildKeywordCounts: mockBuildKeywordCounts,
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
import { BaCrosswalkError } from '@/lib/baCategory/buildCrosswalk';
import { KeywordCountsBuildError } from '@/lib/products/buildKeywordCounts';
import { R2StreamError } from '@/lib/storage/r2';

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

  // 2026-10-19: the R2 download stalled mid-COPY and the inactivity guard's error killed the worker.
  // A retryable download failure now gets up to three attempts, 15 s apart; anything else still
  // fails the import at once.
  describe('copy_to_staging retries', () => {
    const fixture = readFileSync(path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'));
    const stalled = () => new R2StreamError('SECRET R2 stream k inactive for 120000ms');
    /** A COPY client whose stream records each line; `onFirstLine` runs once the COPY is under way. */
    const copyClient = (onFirstLine?: () => void) => {
      const lines: string[] = [];
      const stream = new Writable({
        write(chunk, _enc, cb) {
          lines.push(chunk.toString());
          if (lines.length === 1) onFirstLine?.();
          cb();
        },
      });
      const release = vi.fn();
      return { client: { query: vi.fn(() => stream), release }, lines, release };
    };
    /** A body that delivers the first half of the fixture, then goes silent, as the 10-19 one did. */
    const goesSilentHalfway = () => {
      let sent = false;
      return new Readable({
        read() {
          if (sent) return; // the transfer has stalled: nothing more ever arrives
          sent = true;
          this.push(fixture.subarray(0, Math.floor(fixture.length / 2)));
        },
      });
    };
    const quietConsole = () => ({
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      err: vi.spyOn(console, 'error').mockImplementation(() => undefined), // the hook phases' fail-soft lines
      log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    });
    const copyLines = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('[copy]'));
    const stalledLine = (attempt: number) =>
      `[copy] attempt ${attempt} of 3 failed for f1, retrying in 15s {"error":"R2StreamError","code":"r2_stream_inactive"}`;

    beforeEach(() => {
      // Only setTimeout is faked: the 15 s retry delay. Streams run on nextTick, the heartbeat on setInterval.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      // The lock UPDATE ... RETURNING id acquires the lock; then the file row.
      mockExecute.mockResolvedValueOnce({ rows: [{ id: 'f1' }] });
      mockFindFile.mockResolvedValueOnce({
        id: 'f1',
        batchId: 'b1',
        storageKey: 'k',
        weekEndDate: '2026-04-11',
        isReplacement: false,
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks(); // the console spies
      // Drop anything a case queued but never took, so it cannot leak into the later tests.
      mockExecute.mockReset().mockResolvedValue(undefined);
      mockFindFile.mockReset();
      mockDownloadStream.mockReset();
      mockPoolConnect.mockReset();
    });

    it('a stalled download is retried after 15 s and the import completes; the warn line carries no message text', async () => {
      const { warn } = quietConsole();
      mockDownloadStream.mockRejectedValueOnce(stalled()).mockResolvedValueOnce(Readable.from(fixture));
      const copy = copyClient();
      mockPoolConnect.mockResolvedValueOnce(copy.client);

      const running = processFileImport({ uploadedFileId: 'f1' });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await running;

      expect(result.rowsImported).toBeGreaterThan(90);
      expect(copy.lines.length).toBe(result.rowsImported);
      expect(mockDownloadStream).toHaveBeenCalledTimes(2);
      expect(mockDownloadStream).toHaveBeenNthCalledWith(2, 'k');
      expect(copyLines(warn)).toEqual([stalledLine(1)]);
      expect(warn.mock.calls.flat().join(' ')).not.toContain('SECRET');
      // Staging is cleared between the failed attempt and the retry: clear_staging, the retry's
      // clear, then staging_cleanup at the end.
      expect(mockDelete).toHaveBeenCalledTimes(3);
      expect(mockDelete.mock.invocationCallOrder[1]).toBeGreaterThan(
        mockDownloadStream.mock.invocationCallOrder[0],
      );
      expect(mockDelete.mock.invocationCallOrder[1]).toBeLessThan(
        mockDownloadStream.mock.invocationCallOrder[1],
      );
    });

    it('a stall mid-COPY (the 2026-10-19 shape) releases the first COPY connection and the retry stages every row', async () => {
      const { warn } = quietConsole();
      const body = goesSilentHalfway();
      mockDownloadStream.mockResolvedValueOnce(body).mockResolvedValueOnce(Readable.from(fixture));
      // The inactivity guard destroys the silent body once the COPY is under way, so the stall
      // error arrives mid-COPY.
      const first = copyClient(() => body.destroy(stalled()));
      const second = copyClient();
      mockPoolConnect.mockResolvedValueOnce(first.client).mockResolvedValueOnce(second.client);

      const running = processFileImport({ uploadedFileId: 'f1' });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await running;

      expect(first.lines.length).toBeGreaterThan(0); // it failed mid-COPY, not before it
      expect(first.lines.length).toBeLessThan(result.rowsImported);
      expect(first.release).toHaveBeenCalledTimes(1);
      expect(second.lines.length).toBe(result.rowsImported);
      expect(result.rowsImported).toBeGreaterThan(90);
      expect(copyLines(warn)).toEqual([stalledLine(1)]);
    });

    it('a non-retryable failure (NoSuchKey) fails the import at once, with no retry', async () => {
      const { warn } = quietConsole();
      const noSuchKey = Object.assign(new Error('NoSuchKey'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
      mockDownloadStream.mockRejectedValueOnce(noSuchKey);

      await expect(processFileImport({ uploadedFileId: 'f1' })).rejects.toBe(noSuchKey);

      expect(mockDownloadStream).toHaveBeenCalledTimes(1);
      expect(mockPoolConnect).not.toHaveBeenCalled();
      expect(mockDelete).toHaveBeenCalledTimes(1); // clear_staging only
      expect(copyLines(warn)).toEqual([]);
    });

    it('three retryable failures in a row fail the import with the third error', async () => {
      const { warn } = quietConsole();
      const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      const internal = Object.assign(new Error('We encountered an internal error'), {
        name: 'InternalError',
        $metadata: { httpStatusCode: 500 },
      });
      mockDownloadStream
        .mockRejectedValueOnce(stalled())
        .mockRejectedValueOnce(reset)
        .mockRejectedValueOnce(internal);

      const settled = processFileImport({ uploadedFileId: 'f1' }).then(
        () => null,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await settled).toBe(internal);
      expect(mockDownloadStream).toHaveBeenCalledTimes(3);
      expect(copyLines(warn)).toEqual([
        stalledLine(1),
        '[copy] attempt 2 of 3 failed for f1, retrying in 15s {"error":"Error","code":"ECONNRESET"}',
      ]);
    });
  });
});

describe('processFileImport — keepa_enqueue hook', () => {
  const fixture = readFileSync(path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'));
  const hookClient = { on: vi.fn(), release: vi.fn(), query: vi.fn() };
  const topAsinsClient = { on: vi.fn(), release: vi.fn(), query: vi.fn() };
  const keywordCountsClient = { on: vi.fn(), release: vi.fn(), query: vi.fn() };
  const crosswalkClient = { on: vi.fn(), release: vi.fn(), query: vi.fn() };
  const facetsClient = { on: vi.fn(), release: vi.fn(), query: vi.fn() };
  // Every db.insert(...).values(row) lands here; the import_phase_timings rows carry `phase`.
  const insertValues = vi.fn().mockReturnValue({
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  });
  // The first connect() is the COPY pool's client; the second is the Keepa hook's, the third the
  // top-ASINs phase's, the fourth the keyword-counts phase's, the fifth the crosswalk phase's, the
  // sixth the facets phase's.
  const copyClient = () => {
    const { stream } = createFakeCopyStream();
    return { query: vi.fn(() => stream), release: vi.fn() };
  };
  const POOLS = 6; // the COPY pool + one per hook phase

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
      .mockResolvedValueOnce(topAsinsClient)
      .mockResolvedValueOnce(keywordCountsClient)
      .mockResolvedValueOnce(crosswalkClient)
      .mockResolvedValueOnce(facetsClient);
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
    // A successful keyword-counts build by default, so the phase after the pair table adds no stray failure line.
    mockBuildKeywordCounts.mockReset().mockResolvedValue({ updated: 1200, zeroed: 34, seconds: 84.23, vacuumed: true });
    // A successful crosswalk build by default, so the phase after the keyword counts adds no stray failure line.
    mockBuildCrosswalk.mockReset().mockResolvedValue({
      week: '2026-04-11',
      paths: 0,
      direct: 0,
      backedOff: 0,
      uncoded: 0,
      trainingProducts: 0,
      codes: 0,
    });
    // A successful facets build by default, so the phase after the crosswalk adds no stray failure line.
    mockBuildFacets.mockReset().mockResolvedValue({ paths: 23429, departments: 36, products: 1176481 });
  });

  afterEach(() => {
    vi.restoreAllMocks(); // the console spies
    mockPoolConnect.mockReset(); // drops a hook client the replay case never took
  });

  const spyConsole = () => ({
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    err: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  });
  const keepaLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('[keepa-enqueue]'));
  const enqueueTimings = () =>
    insertValues.mock.calls
      .map(([row]) => row as { phase?: string; rowsAffected?: number | null })
      .filter((row) => row.phase === 'keepa_enqueue');
  const sentEventNames = () =>
    mockInngestSend.mock.calls.map(([e]) => (e as { name: string }).name);

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
    expect(mockPoolOn).toHaveBeenCalledTimes(POOLS); // the COPY pool's guard + the five hook pools'
    expect(mockPoolOn).toHaveBeenNthCalledWith(2, 'error', expect.any(Function)); // the Keepa hook's
    expect(hookClient.release).toHaveBeenCalledTimes(1);
    expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS); // the COPY pool + the five hook pools
    expect(keepaLines(log)).toEqual([
      '[keepa-enqueue] week 2026-04-11: inserted=5 updated=7 retired=2 vacuumed=false vacuumError=57014',
    ]);
    expect(enqueueTimings()).toEqual([expect.objectContaining({ rowsAffected: 12 })]);
    // Arc 11 retired the import-time Keepa job: a completed import sends no enrichment event.
    expect(sentEventNames()).not.toContain('keepa.enrich-week-requested');
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
    expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
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
      .mockResolvedValueOnce(topAsinsClient)
      .mockResolvedValueOnce(keywordCountsClient)
      .mockResolvedValueOnce(crosswalkClient)
      .mockResolvedValueOnce(facetsClient);

    await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({
      rowsImported: expect.any(Number),
    });

    expect(mockEnqueueWeek).not.toHaveBeenCalled();
    expect(keepaLines(err)).toEqual([
      '[keepa-enqueue] failed (import continues) {"week":"2026-04-11","stage":"connect","error":"Error","code":"ECONNREFUSED"}',
    ]);
    expect(err.mock.calls.flat().join(' ')).not.toContain('[category-facets]');
    expect(mockBuildFacets).toHaveBeenCalledWith(facetsClient);
    expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
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
  // shape, so these tests share this block's setup (six pools: COPY, Keepa hook, this phase, the
  // keyword-counts phase, the crosswalk phase, the facets phase).
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
      const order = ['keepa_enqueue', 'top_asins_build', 'keyword_counts_build', 'ba_crosswalk_build', 'category_facets_build', 'summary_refresh'];
      const phaseRows = insertValues.mock.calls
        .map(([row]) => (row as { phase?: string }).phase)
        .filter((phase) => phase !== undefined && order.includes(phase));
      expect(phaseRows).toEqual(order); // one timing row each, in this order
      expect(topAsinsClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(topAsinsClient.on.mock.invocationCallOrder[0]).toBeLessThan(
        mockBuildTopAsinsWeek.mock.invocationCallOrder[0],
      );
      expect(mockPoolOn).toHaveBeenCalledTimes(POOLS); // the COPY pool's guard + the five hook pools'
      expect(mockPoolOn).toHaveBeenNthCalledWith(3, 'error', expect.any(Function)); // this phase's
      expect(topAsinsClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS); // the COPY pool + the five hook pools
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
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
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
        )
        .mockResolvedValueOnce(keywordCountsClient)
        .mockResolvedValueOnce(crosswalkClient)
        .mockResolvedValueOnce(facetsClient);

      await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({
        rowsImported: expect.any(Number),
      });

      expect(mockBuildTopAsinsWeek).not.toHaveBeenCalled();
      expect(topAsinsLines(err)).toEqual([
        '[top-asins] failed (import continues) {"week":"2026-04-11","stage":"connect","error":"Error","code":"ECONNREFUSED"}',
      ]);
      expect(err.mock.calls.flat().join(' ')).not.toContain('[category-facets]');
      expect(mockBuildFacets).toHaveBeenCalledWith(facetsClient);
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(topAsinsTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('replay runs (skipRefresh) never build', async () => {
      await processFileImport({ uploadedFileId: 'f1', skipRefresh: true });

      expect(mockBuildTopAsinsWeek).not.toHaveBeenCalled();
      expect(mockBuildCrosswalk).not.toHaveBeenCalled();
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

      // Pools are built in order: the COPY pool, the Keepa hook's, this phase's, the keyword-counts
      // phase's, the crosswalk phase's, the facets phase's.
      expect(mockPoolCtor).toHaveBeenCalledTimes(POOLS);
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

  // The phase after top_asins_build (spec 2026-10-23 §5): the same pool shape and fail-soft rule. It counts
  // the pair table top_asins_build has just rebuilt, so no week is passed; the week only names the import in
  // the failure line.
  describe('keyword_counts_build phase', () => {
    beforeEach(() => {
      // The Keepa hook succeeds, so the only console.error lines are this phase's.
      mockEnqueueWeek.mockResolvedValue({ inserted: 0, updated: 0, retired: 0, vacuumed: false });
    });

    const countsLines = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls
        .map((args) => args.join(' '))
        .filter((line) => line.includes('[keyword-counts]'));
    const countsTimings = () =>
      insertValues.mock.calls
        .map(([row]) => row as { phase?: string; rowsAffected?: number | null })
        .filter((row) => row.phase === 'keyword_counts_build');

    it('writes the counts once, after the pair table and before the crosswalk, logs them and cleans up', async () => {
      const { log } = spyConsole();

      await processFileImport({ uploadedFileId: 'f1' });

      expect(mockBuildKeywordCounts).toHaveBeenCalledTimes(1);
      expect(mockBuildKeywordCounts).toHaveBeenCalledWith(keywordCountsClient);
      expect(mockBuildTopAsinsWeek.mock.invocationCallOrder[0]).toBeLessThan(
        mockBuildKeywordCounts.mock.invocationCallOrder[0],
      );
      expect(mockBuildKeywordCounts.mock.invocationCallOrder[0]).toBeLessThan(
        mockBuildCrosswalk.mock.invocationCallOrder[0],
      );
      const order = ['keepa_enqueue', 'top_asins_build', 'keyword_counts_build', 'ba_crosswalk_build', 'category_facets_build', 'summary_refresh'];
      const phaseRows = insertValues.mock.calls
        .map(([row]) => (row as { phase?: string }).phase)
        .filter((phase) => phase !== undefined && order.includes(phase));
      expect(phaseRows).toEqual(order); // one timing row each, in this order
      expect(keywordCountsClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(keywordCountsClient.on.mock.invocationCallOrder[0]).toBeLessThan(
        mockBuildKeywordCounts.mock.invocationCallOrder[0],
      );
      expect(mockPoolOn).toHaveBeenNthCalledWith(4, 'error', expect.any(Function)); // this phase's
      expect(keywordCountsClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      // Its pool is the fourth to end: after the build, before the crosswalk starts.
      expect(mockPoolEnd.mock.invocationCallOrder[3]).toBeGreaterThan(
        mockBuildKeywordCounts.mock.invocationCallOrder[0],
      );
      expect(mockPoolEnd.mock.invocationCallOrder[3]).toBeLessThan(
        mockBuildCrosswalk.mock.invocationCallOrder[0],
      );
      expect(countsLines(log)).toEqual(['[keyword-counts] updated=1200 zeroed=34 seconds=84.2 vacuum=ok']);
      expect(countsTimings()).toEqual([expect.objectContaining({ rowsAffected: 1234 })]); // updated + zeroed
    });

    it('a quiet week that changed nothing records 0 rows, not the failure marker', async () => {
      const { log } = spyConsole();
      mockBuildKeywordCounts.mockResolvedValue({ updated: 0, zeroed: 0, seconds: 3.04, vacuumed: true });

      await processFileImport({ uploadedFileId: 'f1' });

      expect(countsLines(log)).toEqual(['[keyword-counts] updated=0 zeroed=0 seconds=3.0 vacuum=ok']);
      expect(countsTimings()).toEqual([expect.objectContaining({ rowsAffected: 0 })]);
    });

    it('a failed VACUUM (the counts committed) reads vacuum=failed in the summary and is no phase failure', async () => {
      const { log, err } = spyConsole();
      mockBuildKeywordCounts.mockResolvedValue({ updated: 1200, zeroed: 34, seconds: 84.23, vacuumed: false });

      await processFileImport({ uploadedFileId: 'f1' });

      expect(countsLines(log)).toEqual(['[keyword-counts] updated=1200 zeroed=34 seconds=84.2 vacuum=failed']);
      expect(countsLines(err)).toEqual([]);
      expect(countsTimings()).toEqual([expect.objectContaining({ rowsAffected: 1234 })]);
    });

    it('the empty-pair-table refusal is a failure logged by its code only; the import goes on', async () => {
      const { log, err, warn } = spyConsole();
      mockBuildKeywordCounts.mockRejectedValue(
        new KeywordCountsBuildError('keyword_counts_no_rows', 'keyword_top_asins is empty; refusing to zero every count'),
      );

      await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({ rowsImported: expect.any(Number) });

      expect(countsLines(err)).toEqual([
        '[keyword-counts] failed (import continues) {"week":"2026-04-11","stage":"build","error":"KeywordCountsBuildError","code":"keyword_counts_no_rows"}',
      ]);
      expect([...log.mock.calls, ...err.mock.calls, ...warn.mock.calls].flat().join(' ')).not.toContain('refusing'); // the message stays out
      expect(mockBuildCrosswalk).toHaveBeenCalledTimes(1);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(countsTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('opens its own pool: one connection, 10-minute statement timeout, keepalive, 20 s connect timeout', async () => {
      await processFileImport({ uploadedFileId: 'f1' });

      // Pools are built in order: the COPY pool, the Keepa hook's, the top-ASINs phase's, this one, the
      // crosswalk's, the facets'.
      expect(mockPoolCtor).toHaveBeenCalledTimes(POOLS);
      expect(mockPoolCtor.mock.calls[3][0]).toMatchObject({
        connectionString: 'postgres://test:test@localhost:5432/test',
        max: 1,
        statement_timeout: 600_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
        connectionTimeoutMillis: 20_000,
      });
    });

    it('replay runs (skipRefresh) never write the counts', async () => {
      await processFileImport({ uploadedFileId: 'f1', skipRefresh: true });

      expect(mockBuildKeywordCounts).not.toHaveBeenCalled();
      expect(countsTimings()).toEqual([]);
    });

    it.each([
      ['failed', Object.assign(new Error('SECRET'), { code: '57014' })],
      ['skipped', new TopAsinsBuildError('top_asins_older_than_meta', 'week 2026-04-11 is older than the built week 2026-04-18')],
    ])('still runs after a %s top_asins_build: it counts the build still in place', async (_outcome, failure) => {
      spyConsole();
      mockBuildTopAsinsWeek.mockRejectedValue(failure);

      await processFileImport({ uploadedFileId: 'f1' });

      expect(mockBuildKeywordCounts).toHaveBeenCalledTimes(1);
      expect(mockBuildKeywordCounts).toHaveBeenCalledWith(keywordCountsClient);
      expect(countsTimings()).toEqual([expect.objectContaining({ rowsAffected: 1234 })]);
    });

    it('a failure logs only the week, stage, error name and code; the import completes, the later phases and the refresh still run, the timing row is null', async () => {
      const { log, err, warn } = spyConsole();
      mockBuildKeywordCounts.mockRejectedValue(
        Object.assign(new Error('SECRET canceling statement due to statement timeout'), { name: 'error', code: '57014' }),
      );

      await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({ rowsImported: expect.any(Number) });

      expect(countsLines(err)).toEqual([
        '[keyword-counts] failed (import continues) {"week":"2026-04-11","stage":"build","error":"error","code":"57014"}',
      ]);
      expect(err).toHaveBeenCalledTimes(1); // that line alone
      expect(countsLines(log)).toEqual([]); // no success line
      expect([...log.mock.calls, ...err.mock.calls, ...warn.mock.calls].flat().join(' ')).not.toContain('SECRET');
      expect(keywordCountsClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(mockBuildCrosswalk).toHaveBeenCalledWith(crosswalkClient, '2026-04-11');
      expect(mockBuildFacets).toHaveBeenCalledWith(facetsClient);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(countsTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('a connect failure is logged at the connect stage and never reaches the builder', async () => {
      const { err } = spyConsole();
      mockPoolConnect
        .mockReset()
        .mockResolvedValueOnce(copyClient())
        .mockResolvedValueOnce(hookClient)
        .mockResolvedValueOnce(topAsinsClient)
        .mockRejectedValueOnce(Object.assign(new Error('SECRET'), { code: 'ECONNRESET' }))
        .mockResolvedValueOnce(crosswalkClient)
        .mockResolvedValueOnce(facetsClient);

      await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({ rowsImported: expect.any(Number) });

      expect(countsLines(err)).toEqual([
        '[keyword-counts] failed (import continues) {"week":"2026-04-11","stage":"connect","error":"Error","code":"ECONNRESET"}',
      ]);
      expect(err.mock.calls.flat().join(' ')).not.toContain('SECRET');
      expect(mockBuildKeywordCounts).not.toHaveBeenCalled();
      expect(mockBuildCrosswalk).toHaveBeenCalledWith(crosswalkClient, '2026-04-11');
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(countsTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });
  });

  // The phase after keyword_counts_build (spec 2026-10-14 §5.4): the same pool shape and fail-soft rule.
  describe('ba_crosswalk_build phase', () => {
    beforeEach(() => {
      // The Keepa hook succeeds, so the only console.error lines are this phase's.
      mockEnqueueWeek.mockResolvedValue({ inserted: 0, updated: 0, retired: 0, vacuumed: false });
    });

    const crosswalkLines = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls
        .map((args) => args.join(' '))
        .filter((line) => line.includes('[ba-crosswalk]'));
    const crosswalkTimings = () =>
      insertValues.mock.calls
        .map(([row]) => row as { phase?: string; rowsAffected?: number | null })
        .filter((row) => row.phase === 'ba_crosswalk_build');

    it('builds the imported week once, after the pair table and before the summary refresh, logs the stats and cleans up', async () => {
      const { log } = spyConsole();
      mockBuildCrosswalk.mockResolvedValue({
        week: '2026-04-11',
        paths: 23968,
        direct: 5194,
        backedOff: 18774,
        uncoded: 0,
        trainingProducts: 614676,
        codes: 118,
      });

      await processFileImport({ uploadedFileId: 'f1' });

      expect(mockBuildCrosswalk).toHaveBeenCalledTimes(1);
      expect(mockBuildCrosswalk).toHaveBeenCalledWith(crosswalkClient, '2026-04-11');
      expect(mockBuildTopAsinsWeek.mock.invocationCallOrder[0]).toBeLessThan(
        mockBuildCrosswalk.mock.invocationCallOrder[0],
      );
      expect(mockBuildCrosswalk.mock.invocationCallOrder[0]).toBeLessThan(
        mockRefreshSummary.mock.invocationCallOrder[0],
      );
      expect(crosswalkClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(crosswalkClient.on.mock.invocationCallOrder[0]).toBeLessThan(
        mockBuildCrosswalk.mock.invocationCallOrder[0],
      );
      expect(mockPoolOn).toHaveBeenNthCalledWith(5, 'error', expect.any(Function)); // this phase's
      expect(crosswalkClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(crosswalkLines(log)).toEqual([
        '[ba-crosswalk] week 2026-04-11: paths=23968 direct=5194 backedOff=18774 uncoded=0 trainingProducts=614676 codes=118',
      ]);
      expect(crosswalkTimings()).toEqual([expect.objectContaining({ rowsAffected: 23968 })]);
    });

    it('an older week is an expected skip, not an error', async () => {
      const { log, err, warn } = spyConsole();
      mockBuildCrosswalk.mockRejectedValue(
        new BaCrosswalkError(
          'ba_crosswalk_older_than_built',
          'week 2026-04-11 is older than the built week 2026-04-18',
        ),
      );

      await processFileImport({ uploadedFileId: 'f1' });

      expect(crosswalkLines(log)).toEqual([
        '[ba-crosswalk] skipped: ba_crosswalk_older_than_built (week 2026-04-11)',
      ]);
      expect(err).not.toHaveBeenCalled();
      expect([...log.mock.calls, ...warn.mock.calls].flat().join(' ')).not.toContain('2026-04-18'); // the message stays out
      expect(crosswalkClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(crosswalkTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('a build error other than the older-week skip is a failure, logged by its code only', async () => {
      const { err } = spyConsole();
      mockBuildCrosswalk.mockRejectedValue(
        new BaCrosswalkError('ba_crosswalk_no_votes', 'SECRET week 2026-04-11 has no slot-1 rows'),
      );

      await processFileImport({ uploadedFileId: 'f1' });

      expect(crosswalkLines(err)).toEqual([
        '[ba-crosswalk] failed (import continues) {"week":"2026-04-11","stage":"build","error":"BaCrosswalkError","code":"ba_crosswalk_no_votes"}',
      ]);
      expect(err.mock.calls.flat().join(' ')).not.toContain('SECRET');
      expect(crosswalkTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('opens its own pool: one connection, 30-minute statement timeout, keepalive, 20 s connect timeout', async () => {
      await processFileImport({ uploadedFileId: 'f1' });

      // Pools are built in order: the COPY pool, the Keepa hook's, the top-ASINs phase's, the
      // keyword-counts phase's, this one, the facets phase's.
      expect(mockPoolCtor).toHaveBeenCalledTimes(POOLS);
      expect(mockPoolCtor.mock.calls[4][0]).toMatchObject({
        connectionString: 'postgres://test:test@localhost:5432/test',
        max: 1,
        statement_timeout: 1_800_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
        connectionTimeoutMillis: 20_000,
      });
    });

    it('replay runs (skipRefresh) never build the crosswalk', async () => {
      await processFileImport({ uploadedFileId: 'f1', skipRefresh: true });

      expect(mockBuildCrosswalk).not.toHaveBeenCalled();
      expect(crosswalkTimings()).toEqual([]);
    });

    it('a failure logs only the week, stage, error name and code; the import completes with a null timing row', async () => {
      const { log, err, warn } = spyConsole();
      mockBuildCrosswalk.mockRejectedValue(
        Object.assign(new Error('SECRET failed query params'), { name: 'error', code: '57014' }),
      );

      await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({
        rowsImported: expect.any(Number),
      });

      expect(crosswalkLines(err)).toEqual([
        '[ba-crosswalk] failed (import continues) {"week":"2026-04-11","stage":"build","error":"error","code":"57014"}',
      ]);
      expect(
        [...log.mock.calls, ...err.mock.calls, ...warn.mock.calls].flat().join(' '),
      ).not.toContain('SECRET');
      expect(crosswalkClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(crosswalkTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('a connect failure is logged at the connect stage', async () => {
      const { err } = spyConsole();
      mockPoolConnect
        .mockReset()
        .mockResolvedValueOnce(copyClient())
        .mockResolvedValueOnce(hookClient)
        .mockResolvedValueOnce(topAsinsClient)
        .mockResolvedValueOnce(keywordCountsClient)
        .mockRejectedValueOnce(Object.assign(new Error('SECRET'), { code: 'ECONNRESET' }))
        .mockResolvedValueOnce(facetsClient);

      await processFileImport({ uploadedFileId: 'f1' });

      expect(crosswalkLines(err)).toEqual([
        '[ba-crosswalk] failed (import continues) {"week":"2026-04-11","stage":"connect","error":"Error","code":"ECONNRESET"}',
      ]);
      expect(err.mock.calls.flat().join(' ')).not.toContain('SECRET');
      expect(err.mock.calls.flat().join(' ')).not.toContain('[category-facets]');
      expect(mockBuildFacets).toHaveBeenCalledWith(facetsClient);
      expect(mockBuildCrosswalk).not.toHaveBeenCalled();
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(crosswalkTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });
  });

  // The phase after ba_crosswalk_build (spec 2026-10-19 §5): the same pool shape and fail-soft rule. It reads
  // the live catalog, so no week is passed; the week only names the import in the failure line.
  describe('category_facets_build phase', () => {
    beforeEach(() => {
      // The Keepa hook succeeds, so the only console.error lines are this phase's.
      mockEnqueueWeek.mockResolvedValue({ inserted: 0, updated: 0, retired: 0, vacuumed: false });
    });

    const facetsLines = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls
        .map((args) => args.join(' '))
        .filter((line) => line.includes('[category-facets]'));
    const facetsTimings = () =>
      insertValues.mock.calls
        .map(([row]) => row as { phase?: string; rowsAffected?: number | null })
        .filter((row) => row.phase === 'category_facets_build');

    it('rebuilds the facets once, after the crosswalk and before the summary refresh, logs the stats and cleans up', async () => {
      const { log } = spyConsole();

      await processFileImport({ uploadedFileId: 'f1' });

      expect(mockBuildFacets).toHaveBeenCalledTimes(1);
      expect(mockBuildFacets).toHaveBeenCalledWith(facetsClient);
      expect(mockBuildCrosswalk.mock.invocationCallOrder[0]).toBeLessThan(mockBuildFacets.mock.invocationCallOrder[0]);
      expect(mockBuildFacets.mock.invocationCallOrder[0]).toBeLessThan(mockRefreshSummary.mock.invocationCallOrder[0]);
      expect(facetsClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(facetsClient.on.mock.invocationCallOrder[0]).toBeLessThan(mockBuildFacets.mock.invocationCallOrder[0]);
      expect(mockPoolOn).toHaveBeenNthCalledWith(6, 'error', expect.any(Function)); // this phase's
      expect(facetsClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(facetsLines(log)).toEqual(['[category-facets] paths=23429 departments=36 products=1176481']);
      expect(facetsTimings()).toEqual([expect.objectContaining({ rowsAffected: 23429 })]);
    });

    it('opens its own pool: one connection, 10-minute statement timeout, keepalive, 20 s connect timeout', async () => {
      await processFileImport({ uploadedFileId: 'f1' });

      // Pools are built in order: the COPY pool, the Keepa hook's, the top-ASINs phase's, the keyword counts',
      // the crosswalk's, this one.
      expect(mockPoolCtor).toHaveBeenCalledTimes(POOLS);
      expect(mockPoolCtor.mock.calls[5][0]).toMatchObject({
        connectionString: 'postgres://test:test@localhost:5432/test',
        max: 1,
        statement_timeout: 600_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
        connectionTimeoutMillis: 20_000,
      });
    });

    it('replay runs (skipRefresh) never rebuild the facets', async () => {
      await processFileImport({ uploadedFileId: 'f1', skipRefresh: true });

      expect(mockBuildFacets).not.toHaveBeenCalled();
      expect(facetsTimings()).toEqual([]);
    });

    it('a failure logs only the week, stage, error name and code; the import completes, the refresh still runs, the timing row is null', async () => {
      const { log, err, warn } = spyConsole();
      mockBuildFacets.mockRejectedValue(Object.assign(new Error('SECRET duplicate key'), { name: 'error', code: '23505' }));

      await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({ rowsImported: expect.any(Number) });

      expect(facetsLines(err)).toEqual([
        '[category-facets] failed (import continues) {"week":"2026-04-11","stage":"build","error":"error","code":"23505"}',
      ]);
      expect([...log.mock.calls, ...err.mock.calls, ...warn.mock.calls].flat().join(' ')).not.toContain('SECRET');
      expect(facetsClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(facetsTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('a connect failure is logged at the connect stage', async () => {
      const { err } = spyConsole();
      mockPoolConnect
        .mockReset()
        .mockResolvedValueOnce(copyClient())
        .mockResolvedValueOnce(hookClient)
        .mockResolvedValueOnce(topAsinsClient)
        .mockResolvedValueOnce(keywordCountsClient)
        .mockResolvedValueOnce(crosswalkClient)
        .mockRejectedValueOnce(Object.assign(new Error('SECRET'), { code: 'ECONNRESET' }));

      await processFileImport({ uploadedFileId: 'f1' });

      expect(facetsLines(err)).toEqual([
        '[category-facets] failed (import continues) {"week":"2026-04-11","stage":"connect","error":"Error","code":"ECONNRESET"}',
      ]);
      expect(err.mock.calls.flat().join(' ')).not.toContain('SECRET');
      expect(mockBuildFacets).not.toHaveBeenCalled();
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(facetsTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });
  });
});

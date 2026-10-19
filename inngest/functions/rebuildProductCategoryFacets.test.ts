// inngest/functions/rebuildProductCategoryFacets.test.ts
/**
 * The daily product_category_facets rebuild (spec 2026-10-19 §5, §14) under a mocked pg Pool and builder: the
 * cron's config, the one-connection pool and its socket guards, the stats line, and the fail-soft paths (coded
 * fields only; the handler resolves). The builder itself is covered in lib/products/buildCategoryFacets.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consoleLines, spyOnConsole } from '@/tests/unit/consoleLines';

const { mockCreateFunction, mockPoolCtor, mockPoolConnect, mockPoolEnd, mockPoolOn, mockBuildFacets } = vi.hoisted(() => ({
  // The real createFunction returns an InngestFunction; this one hands back its two arguments, so the test reads
  // the config and calls the handler directly.
  mockCreateFunction: vi.fn((config: unknown, handler: unknown) => ({ config, handler })),
  mockPoolCtor: vi.fn(),
  mockPoolConnect: vi.fn(),
  mockPoolEnd: vi.fn(),
  mockPoolOn: vi.fn(),
  mockBuildFacets: vi.fn(),
}));

vi.mock('@/inngest/client', () => ({ inngest: { createFunction: mockCreateFunction } }));
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
vi.mock('pg', () => ({
  Pool: class {
    connect = mockPoolConnect;
    end = mockPoolEnd;
    on = mockPoolOn;
    constructor(options: unknown) {
      mockPoolCtor(options); // every new Pool(options)
    }
  },
}));
// The real FacetsBuildError stays, so the facets_empty case rejects with the builder's own class.
vi.mock('@/lib/products/buildCategoryFacets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/products/buildCategoryFacets')>()),
  buildProductCategoryFacets: mockBuildFacets,
}));

import { rebuildProductCategoryFacetsFn } from './rebuildProductCategoryFacets';
import { FacetsBuildError } from '@/lib/products/buildCategoryFacets';

// What the mocked createFunction returned when the module loaded.
const { config, handler } = rebuildProductCategoryFacetsFn as unknown as {
  config: unknown;
  handler: () => Promise<unknown>;
};

const FAILED = '[category-facets] daily rebuild failed (previous rows stay)';

describe('rebuildProductCategoryFacetsFn', () => {
  const client = { on: vi.fn(), release: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolConnect.mockReset().mockResolvedValue(client);
    mockPoolEnd.mockReset().mockResolvedValue(undefined);
    mockBuildFacets.mockReset().mockResolvedValue({ paths: 23429, departments: 36, products: 1176481 });
  });
  afterEach(() => {
    vi.restoreAllMocks(); // the console spies
  });

  it('runs on the worker daily at 14:00 ET, one run at a time, with no retries', () => {
    expect(config).toEqual({
      id: 'rebuild-product-category-facets',
      name: 'Daily: rebuild product_category_facets',
      retries: 0,
      concurrency: { limit: 1 },
      triggers: [{ cron: 'TZ=America/New_York 0 14 * * *' }],
    });
  });

  it('builds over one guarded connection of its own pool, logs the stats, then releases the client and ends the pool', async () => {
    const [error, warn, log] = spyOnConsole();

    await expect(handler()).resolves.toEqual({ ok: true, paths: 23429, departments: 36, products: 1176481, ms: expect.any(Number) });

    expect(mockPoolCtor).toHaveBeenCalledTimes(1);
    expect(mockPoolCtor).toHaveBeenCalledWith({
      connectionString: 'postgres://test',
      max: 1,
      statement_timeout: 600_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      connectionTimeoutMillis: 20_000,
    });
    expect(mockPoolOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockPoolOn.mock.invocationCallOrder[0]).toBeLessThan(mockPoolConnect.mock.invocationCallOrder[0]);
    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(client.on.mock.invocationCallOrder[0]).toBeLessThan(mockBuildFacets.mock.invocationCallOrder[0]);
    expect(mockBuildFacets).toHaveBeenCalledTimes(1);
    expect(mockBuildFacets).toHaveBeenCalledWith(client);
    expect(consoleLines(log)).toEqual([
      expect.stringMatching(/^\[category-facets\] daily paths=23429 departments=36 products=1176481 in \d+ms$/),
    ]);
    expect(consoleLines(error, warn)).toEqual([]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
    expect(client.release.mock.invocationCallOrder[0]).toBeLessThan(mockPoolEnd.mock.invocationCallOrder[0]);
  });

  it('a build failure logs only the stage, error name and code, still releases and ends, and resolves', async () => {
    const [error, warn, log] = spyOnConsole();
    mockBuildFacets.mockRejectedValue(Object.assign(new Error('SECRET duplicate key'), { name: 'error', code: '23505' }));

    await expect(handler()).resolves.toEqual({ ok: false, stage: 'build', code: '23505' });

    expect(consoleLines(error)).toEqual([`${FAILED} {"stage":"build","error":"error","code":"23505"}`]);
    expect(consoleLines(error, warn, log).join('\n')).not.toContain('SECRET');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it('a facets_empty refusal (nothing written, the previous rows kept) is logged by its class and code', async () => {
    const [error, warn, log] = spyOnConsole();
    mockBuildFacets.mockRejectedValue(new FacetsBuildError('facets_empty', 'SECRET the catalog matched no path'));

    await expect(handler()).resolves.toEqual({ ok: false, stage: 'build', code: 'facets_empty' });

    expect(consoleLines(error)).toEqual([`${FAILED} {"stage":"build","error":"FacetsBuildError","code":"facets_empty"}`]);
    expect(consoleLines(error, warn, log).join('\n')).not.toContain('SECRET');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it('a connect failure is logged at the connect stage; the builder never runs and the pool is still ended', async () => {
    const [error, warn, log] = spyOnConsole();
    mockPoolConnect.mockRejectedValue(Object.assign(new Error('SECRET host'), { code: 'ECONNRESET' }));

    await expect(handler()).resolves.toEqual({ ok: false, stage: 'connect', code: 'ECONNRESET' });

    expect(consoleLines(error)).toEqual([`${FAILED} {"stage":"connect","error":"Error","code":"ECONNRESET"}`]);
    expect(consoleLines(error, warn, log).join('\n')).not.toContain('SECRET');
    expect(mockBuildFacets).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });
});

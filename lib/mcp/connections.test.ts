import { describe, it, expect, vi, beforeEach } from 'vitest';
const { findFirst, insert } = vi.hoisted(() => ({ findFirst: vi.fn(), insert: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { query: { mcpConnections: { findFirst } }, insert } }));
import { getMcpConnection, setMcpConnectionStatus, touchMcpConnection, resetMcpConnectionTouchesForTests } from './connections';

const row = (over: Record<string, unknown> = {}) => ({ userId: 'u1', status: 'enabled', disconnectedAt: null, reconnectedAt: null, lastRequestAt: null, lastClientId: null, updatedAt: new Date(), ...over });

interface FakeChain {
  returning: () => Promise<unknown[]>;
  catch: (fn: (e: unknown) => void) => Promise<void>;
}

/** `failWith`, when given, makes the fake chain's `.catch` invoke the real callback with that error, as a rejected upsert would. */
function chain(returning: unknown[], failWith?: Error) {
  const onConflictDoUpdate = vi.fn<(call: { set: Record<string, unknown> }) => FakeChain>().mockReturnValue({
    returning: vi.fn(async () => returning),
    catch: (fn: (e: unknown) => void) => {
      if (failWith) fn(failWith);
      return Promise.resolve();
    },
  });
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  insert.mockReturnValue({ values });
  return { values, onConflictDoUpdate };
}

describe('connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMcpConnectionTouchesForTests();
  });

  it('reads a state, mapping unknown statuses to disconnected (fail closed) and null when no row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    findFirst.mockResolvedValueOnce(row({ status: 'Enabled ', lastClientId: 'c1' }));
    expect(await getMcpConnection('u1')).toMatchObject({ status: 'disconnected', lastClientId: 'c1' });
    expect(warn).toHaveBeenCalledWith('[mcp connections]', JSON.stringify({ outcome: 'unknown_status', userId: 'u1', status: 'Enabled ' }));
    findFirst.mockResolvedValueOnce(undefined);
    expect(await getMcpConnection('u1')).toBeNull();
    warn.mockRestore();
  });

  it('setMcpConnectionStatus upserts the status with the matching timestamp', async () => {
    const now = new Date('2026-09-21T10:00:00Z');
    const c = chain([row({ status: 'disconnected', disconnectedAt: now })]);
    expect(await setMcpConnectionStatus('u1', 'disconnected', now)).toMatchObject({ status: 'disconnected', disconnectedAt: now });
    expect(c.values).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', status: 'disconnected', disconnectedAt: now }));
    expect(c.onConflictDoUpdate.mock.calls[0][0]).toMatchObject({ set: expect.objectContaining({ status: 'disconnected', disconnectedAt: now }) });
  });

  it("setMcpConnectionStatus('enabled') sets reconnectedAt and omits disconnectedAt from the write", async () => {
    const now = new Date('2026-09-21T12:00:00Z');
    const c = chain([row({ status: 'enabled', reconnectedAt: now })]);
    expect(await setMcpConnectionStatus('u1', 'enabled', now)).toMatchObject({ status: 'enabled', reconnectedAt: now });
    const set = c.onConflictDoUpdate.mock.calls[0][0].set;
    expect(set).toMatchObject({ status: 'enabled', reconnectedAt: now });
    expect(set).not.toHaveProperty('disconnectedAt');
  });

  it('touchMcpConnection stamps last-seen without touching status, at most once a minute per account', () => {
    const c = chain([]);
    touchMcpConnection('u1', 'client_a', 1_000_000);
    touchMcpConnection('u1', 'client_a', 1_030_000);
    touchMcpConnection('u1', 'client_a', 1_061_000);
    expect(c.values).toHaveBeenCalledTimes(2);
    const set = c.onConflictDoUpdate.mock.calls[0][0].set;
    expect(set).not.toHaveProperty('status');
    expect(set).toMatchObject({ lastClientId: 'client_a' });
  });

  it('touches two different users at the same instant independently (throttle is per user, not global)', () => {
    const c = chain([]);
    touchMcpConnection('u1', 'client_a', 4_000_000);
    touchMcpConnection('u2', 'client_b', 4_000_000);
    expect(c.values).toHaveBeenCalledTimes(2);
  });

  it('touchMcpConnection warns when the write fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chain([], new Error('connect ETIMEDOUT'));
    touchMcpConnection('u9', 'client_z', 9_000_000);
    expect(warn).toHaveBeenCalledWith('[mcp connections] touch failed:', 'connect ETIMEDOUT');
    warn.mockRestore();
  });
});

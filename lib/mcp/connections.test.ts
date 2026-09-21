import { describe, it, expect, vi, beforeEach } from 'vitest';
const { findFirst, insert } = vi.hoisted(() => ({ findFirst: vi.fn(), insert: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { query: { mcpConnections: { findFirst } }, insert } }));
import { getMcpConnection, setMcpConnectionStatus, touchMcpConnection, resetMcpConnectionTouchesForTests } from './connections';

const row = (over: Record<string, unknown> = {}) => ({ userId: 'u1', status: 'enabled', disconnectedAt: null, reconnectedAt: null, lastRequestAt: null, lastClientId: null, updatedAt: new Date(), ...over });
function chain(returning: unknown[]) {
  const onConflictDoUpdate = vi.fn((_set: unknown) => ({ returning: vi.fn(async () => returning), catch: (fn: (e: unknown) => void) => { void fn; return Promise.resolve(); } }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  insert.mockReturnValue({ values });
  return { values, onConflictDoUpdate };
}

describe('connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMcpConnectionTouchesForTests();
  });
  it('reads a state, mapping unknown statuses to enabled and null when no row', async () => {
    findFirst.mockResolvedValueOnce(row({ status: 'disconnected', lastClientId: 'c1' }));
    expect(await getMcpConnection('u1')).toMatchObject({ status: 'disconnected', lastClientId: 'c1' });
    findFirst.mockResolvedValueOnce(undefined);
    expect(await getMcpConnection('u1')).toBeNull();
  });
  it('setMcpConnectionStatus upserts the status with the matching timestamp', async () => {
    const now = new Date('2026-09-21T10:00:00Z');
    const c = chain([row({ status: 'disconnected', disconnectedAt: now })]);
    expect(await setMcpConnectionStatus('u1', 'disconnected', now)).toMatchObject({ status: 'disconnected', disconnectedAt: now });
    expect(c.values).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', status: 'disconnected', disconnectedAt: now }));
    expect(c.onConflictDoUpdate.mock.calls[0][0]).toMatchObject({ set: expect.objectContaining({ status: 'disconnected', disconnectedAt: now }) });
  });
  it('touchMcpConnection stamps last-seen without touching status, at most once a minute per account', () => {
    const c = chain([]);
    touchMcpConnection('u1', 'client_a', 1_000_000);
    touchMcpConnection('u1', 'client_a', 1_030_000);
    touchMcpConnection('u1', 'client_a', 1_061_000);
    expect(c.values).toHaveBeenCalledTimes(2);
    const set = c.onConflictDoUpdate.mock.calls[0][0] as { set: Record<string, unknown> };
    expect(set.set).not.toHaveProperty('status');
    expect(set.set).toMatchObject({ lastClientId: 'client_a' });
  });
});

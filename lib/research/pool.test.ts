// lib/research/pool.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));

const { createTcpPool } = vi.hoisted(() => ({ createTcpPool: vi.fn(() => ({})) }));
vi.mock('@/lib/db/tcpPool', () => ({ createTcpPool }));

import { getResearchPool, resetResearchPoolForTests } from './pool';

describe('getResearchPool', () => {
  beforeEach(() => {
    resetResearchPoolForTests();
    createTcpPool.mockClear();
  });

  it('memoizes: a second call returns the same pool without creating another', () => {
    const a = getResearchPool();
    const b = getResearchPool();
    expect(a).toBe(b);
    expect(createTcpPool).toHaveBeenCalledTimes(1);
  });

  it('creates the pool with the research name, researchLimits().poolMax, and env.DATABASE_URL', () => {
    getResearchPool();
    expect(createTcpPool).toHaveBeenCalledWith({ name: 'research', max: 4, connectionString: 'postgres://test' });
  });
});

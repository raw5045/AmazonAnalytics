import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImportStatusChip } from './ImportStatusChip';

describe('ImportStatusChip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('says how long ago an active import started, measured when the status was fetched', async () => {
    const now = Date.parse('2026-09-23T12:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const startedAt = new Date(now - 12 * 60_000).toISOString();
    const active = { fileId: 'f1', batchId: 'b1', filename: 'week.csv', phase: 'kwm_insert', startedAt, heartbeatAt: null };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ active: [active], recent: [] }) })));
    render(<ImportStatusChip />);
    expect((await screen.findAllByText(/started 12 min ago/)).length).toBeGreaterThan(0);
  });
});

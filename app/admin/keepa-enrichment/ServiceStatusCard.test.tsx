// app/admin/keepa-enrichment/ServiceStatusCard.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
// The card imports WEEKLY_CAPACITY_ASINS from the loader's module, which imports db/client — and through
// it lib/env, whose load-time parse throws under vitest. The card never touches `db`, so an empty stub.
vi.mock('@/db/client', () => ({ db: {} }));
import { ServiceStatusCard, ageLabel } from './ServiceStatusCard';
import type { KeepaServiceOverview } from '@/lib/admin/keepaServiceOverview';

const NOW = new Date('2026-10-06T12:00:00Z');
const overview: KeepaServiceOverview = {
  status: {
    bootId: 'abcdef12-0000', bootedAt: new Date('2026-10-06T08:00:00Z'), heartbeatAt: new Date('2026-10-06T11:57:30Z'),
    lastBatchAt: new Date('2026-10-06T11:57:00Z'), lastBatchLane: 'new', tokensLeft: 180, refillRate: 250, tailEnabled: false,
    lastErrorCode: null, lastErrorAt: null, laneNewDrainedAt: null, syncFiredAt: null,
  },
  counts: {
    tier1InScope: 1_003_344, tier1NeverFetched: 715_083, tier1Due: 12, tier2InScope: 1_307_312, tier2NeverFetched: 1_239_033, tier2Due: 0,
    fetchedLast24h: 160_000, fetchedLast7d: 900_000, oldestTier1FetchedAt: new Date('2026-10-03T09:39:00Z'), claimed: 100,
    scopeWeek: '2026-10-03', kcsWeek: '2026-10-03',
  },
};

describe('ServiceStatusCard', () => {
  it('shows heartbeat age, lane counts, oldest tier-1 age, tokens and unused capacity', () => {
    render(<ServiceStatusCard overview={overview} now={NOW} />);
    expect(screen.getByRole('heading', { name: 'Keepa service' })).toBeInTheDocument();
    expect(screen.getByText('2 min ago')).toBeInTheDocument(); // heartbeat
    expect(screen.getByText('715,083')).toBeInTheDocument(); // tier-1 never fetched
    expect(screen.getByText('3 days')).toBeInTheDocument(); // oldest tier-1 fetch age
    expect(screen.getByText('180 / 250 per min')).toBeInTheDocument();
    expect(screen.getByText('360,000 of 1,260,000 (29%)')).toBeInTheDocument(); // unused capacity, 7 days
    expect(screen.getByText('off')).toBeInTheDocument(); // tail lane
    expect(screen.getByText('Catalog scope week')).toBeInTheDocument();
  });

  it('says the service has never reported when the status row is empty', () => {
    render(<ServiceStatusCard overview={{ status: null, counts: overview.counts }} now={NOW} />);
    expect(screen.getAllByText('never').length).toBeGreaterThanOrEqual(3);
  });

  it('flags a catalog scope week behind the explorer week', () => {
    render(<ServiceStatusCard overview={{ ...overview, counts: { ...overview.counts, scopeWeek: '2026-09-26', kcsWeek: '2026-10-03' } }} now={NOW} />);
    expect(screen.getByText('2026-09-26 (behind the explorer)')).toBeInTheDocument();
  });

  it('does not flag a scope week ahead of the explorer week (the hours before the explorer refresh)', () => {
    render(<ServiceStatusCard overview={{ ...overview, counts: { ...overview.counts, scopeWeek: '2026-10-10', kcsWeek: '2026-10-03' } }} now={NOW} />);
    expect(screen.getByText('2026-10-10')).toBeInTheDocument();
    expect(screen.queryByText(/behind the explorer/)).not.toBeInTheDocument();
  });
});

describe('ageLabel', () => {
  it('renders minutes, hours and days, and "never" for null', () => {
    expect(ageLabel(null, NOW)).toBe('never');
    expect(ageLabel(new Date('2026-10-06T11:59:40Z'), NOW)).toBe('just now');
    expect(ageLabel(new Date('2026-10-06T11:58:30Z'), NOW)).toBe('1 min ago');
    expect(ageLabel(new Date('2026-10-06T11:57:30Z'), NOW)).toBe('2 min ago');
    expect(ageLabel(new Date('2026-10-06T09:00:00Z'), NOW)).toBe('3 h ago');
    expect(ageLabel(new Date('2026-10-03T09:39:00Z'), NOW)).toBe('3 days');
  });
});

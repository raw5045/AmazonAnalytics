// app/admin/keepa-enrichment/ServiceStatusCard.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ServiceStatusCard, ageLabel, agoLabel } from './ServiceStatusCard';
import type { KeepaQueueCounts, KeepaServiceOverview, KeepaServiceStatusView } from '@/lib/admin/keepaServiceOverview';

const NOW = new Date('2026-10-06T12:00:00Z');
const STATUS: KeepaServiceStatusView = {
  bootId: 'abcdef12-0000', bootedAt: new Date('2026-10-06T08:00:00Z'), heartbeatAt: new Date('2026-10-06T11:57:30Z'),
  lastBatchAt: new Date('2026-10-06T11:57:00Z'), lastBatchLane: 'new', tokensLeft: 180, refillRate: 250, tailEnabled: false,
  lastErrorCode: null, lastErrorAt: null, laneNewDrainedAt: new Date('2026-10-05T06:00:00Z'), syncFiredAt: null,
};
const COUNTS: KeepaQueueCounts = {
  tier1InScope: 1_003_344, tier1NeverFetched: 715_083, tier1Due: 12, tier1Stale: 0, tier1Erroring: 3,
  tier2InScope: 1_307_312, tier2NeverFetched: 1_239_033, tier2Due: 0,
  fetchedLast24h: 160_000, fetchedLast7d: 900_000, oldestTier1FetchedAt: new Date('2026-10-03T09:39:00Z'), claimed: 100,
  scopeWeek: '2026-10-03', kcsWeek: '2026-10-03',
};
const overview: KeepaServiceOverview = { status: STATUS, counts: COUNTS };

/** The value rendered next to a row's label (each row is a <dt> label followed by its <dd> value). */
const valueOf = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe('ServiceStatusCard', () => {
  it('shows every row with its value next to its label', () => {
    render(<ServiceStatusCard overview={overview} now={NOW} />);
    expect(screen.getByRole('heading', { name: 'Keepa service' })).toBeInTheDocument();
    expect(screen.getByText(/Target: no tier-1 ASIN fetched more than 8 days ago \(delisted ones recheck monthly\)\./)).toBeInTheDocument();
    expect(valueOf('Heartbeat')).toBe('2 min ago');
    expect(valueOf('Booted')).toBe('4 h ago');
    expect(valueOf('Last batch')).toBe('3 min ago (new lane)');
    expect(valueOf('Tail lane')).toBe('off');
    expect(valueOf('Catalog scope week')).toBe('2026-10-03');
    expect(valueOf('Explorer week')).toBe('2026-10-03');
    expect(screen.queryByText(/behind the explorer/)).toBeNull();
    expect(valueOf('Tier 1 in scope')).toBe('1,003,344');
    expect(valueOf('Tier 1 never fetched')).toBe('715,083');
    expect(valueOf('Tier 1 due for refresh')).toBe('12');
    expect(valueOf('Oldest tier-1 fetch')).toBe('3 days');
    expect(valueOf('Tier 1 stale (fetched > 8 days ago)')).toBe('0');
    expect(valueOf('Tier 2 in scope / never fetched')).toBe('1,307,312 / 1,239,033');
    expect(valueOf('Fetched last 24 h')).toBe('160,000');
    expect(valueOf('Unused capacity, 7 days')).toBe('360,000 of 1,260,000 (29%)');
    expect(valueOf('Tokens')).toBe('180 left · refills 250/min');
    expect(valueOf('Claimed right now')).toBe('100');
    expect(valueOf('Last error')).toBe('none');
    expect(valueOf('Tier 1 in error backoff')).toBe('3');
    expect(valueOf('New lane last drained')).toBe('1 day ago');
    expect(valueOf('Explorer sync last fired')).toBe('never');
  });

  it('shows placeholders for the status rows when the service has never reported, and capacity at the default refill rate', () => {
    render(<ServiceStatusCard overview={{ status: null, counts: COUNTS }} now={NOW} />);
    for (const label of ['Heartbeat', 'Booted', 'Last batch', 'New lane last drained', 'Explorer sync last fired']) {
      expect(valueOf(label)).toBe('never');
    }
    expect(valueOf('Tokens')).toBe('unknown');
    expect(screen.getAllByText('never')).toHaveLength(5);
    expect(screen.getAllByText('unknown')).toHaveLength(1);
    expect(valueOf('Last error')).toBe('none');
    expect(valueOf('Tail lane')).toBe('off');
    expect(valueOf('Unused capacity, 7 days')).toBe('360,000 of 1,260,000 (29%)'); // DEFAULT_REFILL_RATE_PER_MIN
  });

  it('flags a catalog scope week behind the explorer week', () => {
    render(<ServiceStatusCard overview={{ ...overview, counts: { ...COUNTS, scopeWeek: '2026-09-26', kcsWeek: '2026-10-03' } }} now={NOW} />);
    expect(valueOf('Catalog scope week')).toBe('2026-09-26 (behind the explorer)');
  });

  it('does not flag a scope week ahead of the explorer week (the hours before the explorer refresh)', () => {
    render(<ServiceStatusCard overview={{ ...overview, counts: { ...COUNTS, scopeWeek: '2026-10-10', kcsWeek: '2026-10-03' } }} now={NOW} />);
    expect(valueOf('Catalog scope week')).toBe('2026-10-10');
    expect(screen.queryByText(/behind the explorer/)).toBeNull();
  });

  it('shows the last error code with how long ago it happened', () => {
    render(<ServiceStatusCard overview={{ ...overview, status: { ...STATUS, lastErrorCode: 'keepa_http_401', lastErrorAt: new Date('2026-10-04T10:00:00Z') } }} now={NOW} />);
    expect(valueOf('Last error')).toBe('keepa_http_401 (2 days ago)');
  });

  it('derives the weekly capacity from the live refill rate (and never divides by a zero rate)', () => {
    const { rerender } = render(<ServiceStatusCard overview={{ ...overview, status: { ...STATUS, refillRate: 500 } }} now={NOW} />);
    expect(valueOf('Unused capacity, 7 days')).toBe('1,620,000 of 2,520,000 (64%)');
    expect(valueOf('Tokens')).toBe('180 left · refills 500/min');
    rerender(<ServiceStatusCard overview={{ ...overview, status: { ...STATUS, refillRate: 0 } }} now={NOW} />);
    expect(valueOf('Unused capacity, 7 days')).toBe('0 of 0 (0%)');
  });

  it('degrades to the heading and one line when the overview could not be loaded', () => {
    render(<ServiceStatusCard overview={null} error="42P01" now={NOW} />);
    expect(screen.getByRole('heading', { name: 'Keepa service' })).toBeInTheDocument();
    expect(screen.getByText('Service status unavailable (42P01)')).toBeInTheDocument();
    expect(screen.queryByText('Heartbeat')).toBeNull();
  });
});

describe('ageLabel', () => {
  it('renders minutes, hours and pluralized days, and "never" for null', () => {
    expect(ageLabel(null, NOW)).toBe('never');
    expect(ageLabel(new Date('2026-10-06T11:59:40Z'), NOW)).toBe('just now');
    expect(ageLabel(new Date('2026-10-06T11:58:30Z'), NOW)).toBe('1 min ago');
    expect(ageLabel(new Date('2026-10-06T11:57:30Z'), NOW)).toBe('2 min ago');
    expect(ageLabel(new Date('2026-10-06T09:00:00Z'), NOW)).toBe('3 h ago');
    expect(ageLabel(new Date('2026-10-05T11:00:00Z'), NOW)).toBe('1 day');
    expect(ageLabel(new Date('2026-10-03T09:39:00Z'), NOW)).toBe('3 days');
  });
});

describe('agoLabel', () => {
  it('reads like ageLabel for events, with "ago" on days too', () => {
    expect(agoLabel(null, NOW)).toBe('never');
    expect(agoLabel(new Date('2026-10-06T11:59:40Z'), NOW)).toBe('just now');
    expect(agoLabel(new Date('2026-10-06T11:57:30Z'), NOW)).toBe('2 min ago');
    expect(agoLabel(new Date('2026-10-06T09:00:00Z'), NOW)).toBe('3 h ago');
    expect(agoLabel(new Date('2026-10-05T11:00:00Z'), NOW)).toBe('1 day ago');
    expect(agoLabel(new Date('2026-10-03T09:39:00Z'), NOW)).toBe('3 days ago');
  });
});

// lib/notifications/digest/buildDigestEmail.test.ts
import { describe, it, expect } from 'vitest';
import { buildDigestEmail } from './buildDigestEmail';
import type { DigestKeywordRow } from './types';

const common = {
  weekEndDate: '2026-05-23',
  appUrl: 'https://app.example.com',
  unsubscribeUrl: 'https://app.example.com/api/notifications/unsubscribe?token=TKN',
};

const row = (over: Partial<DigestKeywordRow>): DigestKeywordRow => ({
  searchTermId: 'id-1',
  searchTermRaw: 'wireless earbuds',
  currentRank: 1204,
  priorWeekRank: 1520,
  rank4wAgo: 2100,
  improvement1w: 316,
  estMonthlyVolume: 45000,
  ...over,
});

describe('buildDigestEmail — broadcast', () => {
  const built = buildDigestEmail({ variant: 'broadcast', ...common });

  it('uses the broadcast subject', () => {
    expect(built.subject).toBe('Amazon Keywords Updated! Explore new week of keyword changes');
  });
  it('links to the explorer', () => {
    expect(built.html).toContain(`${common.appUrl}/explorer`);
  });
  it('includes the unsubscribe link in html and text', () => {
    expect(built.html).toContain(common.unsubscribeUrl);
    expect(built.text).toContain(common.unsubscribeUrl);
  });
  it('mentions the week', () => {
    expect(built.text).toContain('2026-05-23');
  });
});

describe('buildDigestEmail — watchlist', () => {
  const rows = [
    row({ searchTermId: 'a', searchTermRaw: 'small mover', improvement1w: 10, currentRank: 500, priorWeekRank: 510, rank4wAgo: 520, estMonthlyVolume: 1000 }),
    row({ searchTermId: 'b', searchTermRaw: 'big mover', improvement1w: -1710, currentRank: 8910, priorWeekRank: 7200, rank4wAgo: 6800, estMonthlyVolume: 12000 }),
    row({ searchTermId: 'c', searchTermRaw: 'no prior', improvement1w: null, currentRank: 3000, priorWeekRank: null, rank4wAgo: null, estMonthlyVolume: null }),
  ];
  const built = buildDigestEmail({ variant: 'watchlist', rows, ...common });

  it('uses the watchlist subject', () => {
    expect(built.subject).toBe('Amazon Keywords Updated! See what changed in your Watchlist and explore today!');
  });

  it('renders every keyword', () => {
    expect(built.html).toContain('small mover');
    expect(built.html).toContain('big mover');
    expect(built.html).toContain('no prior');
  });

  it('links each keyword to its detail page', () => {
    expect(built.html).toContain(`${common.appUrl}/explorer/keyword/a`);
    expect(built.html).toContain(`${common.appUrl}/explorer/keyword/b`);
  });

  it('renders a positive delta in green and negative in red', () => {
    expect(built.html).toMatch(/#15803d[^<]*\+10/);
    expect(built.html).toMatch(/#b91c1c[^<]*(−|-)1,?710/);
  });

  it('shows "not ranked this week" when currentRank is null', () => {
    const r = [row({ searchTermId: 'z', searchTermRaw: 'gone', currentRank: null, improvement1w: null })];
    const b = buildDigestEmail({ variant: 'watchlist', rows: r, ...common });
    expect(b.html).toContain('not ranked this week');
  });

  it('includes the explore/watchlist CTA + unsubscribe link', () => {
    expect(built.html).toContain(`${common.appUrl}/watchlist`);
    expect(built.html).toContain(common.unsubscribeUrl);
  });

  it('lists each keyword in the plain-text fallback', () => {
    expect(built.text).toContain('small mover');
    expect(built.text).toContain('big mover');
    expect(built.text).toContain('no prior');
  });
});

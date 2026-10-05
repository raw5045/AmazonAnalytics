// lib/notifications/buildKeepaServiceAlarmEmail.test.ts
import { describe, it, expect } from 'vitest';
import { buildKeepaServiceAlarmEmail } from './buildKeepaServiceAlarmEmail';

const NOW = new Date('2026-10-06T12:00:00Z');
const input = { heartbeatAt: new Date('2026-10-06T11:40:00Z'), lastBatchAt: new Date('2026-10-06T09:00:00Z'), appUrl: 'https://keywordquarry.com', now: NOW };
const DAY = 86_400_000;

describe('buildKeepaServiceAlarmEmail', () => {
  it('down: names the subject, the heartbeat age and the admin link', () => {
    const e = buildKeepaServiceAlarmEmail({ variant: 'down', ...input });
    expect(e.subject).toBe('Keepa service down');
    expect(e.text).toContain('20 min ago');
    expect(e.text).toContain('https://keywordquarry.com/admin/keepa-enrichment');
    expect(e.html).toContain('Railway');
  });
  it('stalled: says the service is alive but idle with work due', () => {
    const e = buildKeepaServiceAlarmEmail({ variant: 'stalled', ...input });
    expect(e.subject).toBe('Keepa service stalled');
    expect(e.text).toContain('3 h ago');
  });
  it('recovered: the service is reporting again', () => {
    const e = buildKeepaServiceAlarmEmail({ variant: 'recovered', ...input });
    expect(e.subject).toBe('Keepa service recovered');
    expect(e.text).toContain('The Keepa service is reporting again.');
  });
  it("states the watcher's own thresholds (derived from its constants)", () => {
    expect(buildKeepaServiceAlarmEmail({ variant: 'down', ...input }).text).toContain('for more than 15 minutes');
    expect(buildKeepaServiceAlarmEmail({ variant: 'stalled', ...input }).text).toContain('a batch in 2 hours');
  });
  it('says "1 day ago", and "3 days ago" beyond', () => {
    const e = buildKeepaServiceAlarmEmail({
      variant: 'down',
      ...input,
      heartbeatAt: new Date(NOW.getTime() - DAY - 3_600_000),
      lastBatchAt: new Date(NOW.getTime() - 3 * DAY),
    });
    expect(e.text).toContain('Last heartbeat: 1 day ago.');
    expect(e.text).toContain('Last batch: 3 days ago.');
  });
});

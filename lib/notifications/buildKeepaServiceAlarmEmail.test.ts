// lib/notifications/buildKeepaServiceAlarmEmail.test.ts
import { describe, it, expect } from 'vitest';
import { buildKeepaServiceAlarmEmail } from './buildKeepaServiceAlarmEmail';

const NOW = new Date('2026-10-06T12:00:00Z');
const input = { heartbeatAt: new Date('2026-10-06T11:40:00Z'), lastBatchAt: new Date('2026-10-06T09:00:00Z'), appUrl: 'https://keywordquarry.com', now: NOW };

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
  it('recovered', () => {
    expect(buildKeepaServiceAlarmEmail({ variant: 'recovered', ...input }).subject).toBe('Keepa service recovered');
  });
});

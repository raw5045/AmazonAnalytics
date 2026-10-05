// lib/notifications/buildKeepaServiceAlarmEmail.ts
/** Pure subject/text/html for the three Keepa service watcher emails (spec 2026-10-05 §6.2). */
import type { AlarmVariant } from '@/lib/keepa/watcherRules';

export interface KeepaAlarmEmailInput {
  variant: AlarmVariant;
  heartbeatAt: Date | null;
  lastBatchAt: Date | null;
  appUrl: string;
  now: Date;
}

export interface BuiltKeepaAlarmEmail {
  subject: string;
  text: string;
  html: string;
}

function age(at: Date | null, now: Date): string {
  if (!at) return 'never';
  const ms = now.getTime() - at.getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} days ago`;
}

export function buildKeepaServiceAlarmEmail(i: KeepaAlarmEmailInput): BuiltKeepaAlarmEmail {
  const link = `${i.appUrl}/admin/keepa-enrichment`;
  const facts = `Last heartbeat: ${age(i.heartbeatAt, i.now)}. Last batch: ${age(i.lastBatchAt, i.now)}.`;
  const copy = {
    down: {
      subject: 'Keepa service down',
      lead: 'The Keepa service has not written a heartbeat for more than fifteen minutes.',
      hint: 'Check the Railway service: its latest deploy, logs and restarts. It resumes from the queue on its own once it is back.',
    },
    stalled: {
      subject: 'Keepa service stalled',
      lead: 'The Keepa service is alive but has not completed a batch in two hours while work is due.',
      hint: 'Check the last error on the admin page and the Railway logs; a rejected Keepa request (bad key, plan change) looks like this.',
    },
    recovered: {
      subject: 'Keepa service recovered',
      lead: 'The Keepa service is reporting again.',
      hint: 'Nothing to do.',
    },
  }[i.variant];
  const text = `${copy.lead}\n\n${facts}\n\n${copy.hint}\n\nStatus: ${link}\n`;
  const html = `<p>${copy.lead}</p><p>${facts}</p><p>${copy.hint}</p><p><a href="${link}">Keepa service status</a></p>`;
  return { subject: copy.subject, text, html };
}

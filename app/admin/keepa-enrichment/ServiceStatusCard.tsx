// app/admin/keepa-enrichment/ServiceStatusCard.tsx
import type { ReactNode } from 'react';
import type { KeepaServiceOverview } from '@/lib/admin/keepaServiceOverview';
import { DEFAULT_REFILL_RATE_PER_MIN, TOKENS_PER_ASIN } from '@/lib/keepa/lanes';

function sinceLabel(at: Date | null, now: Date, agoOnDays: boolean): string {
  if (!at) return 'never';
  const ms = now.getTime() - at.getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  const days = Math.floor(ms / 86_400_000);
  return `${days} ${days === 1 ? 'day' : 'days'}${agoOnDays ? ' ago' : ''}`;
}

/** "just now" / "N min ago" / "N h ago" / "1 day" / "N days" / "never". Days are shown without "ago" (an age, not an event). */
export function ageLabel(at: Date | null, now: Date): string {
  return sinceLabel(at, now, false);
}

/** ageLabel for events (heartbeat, boot, last batch, last error, drained lane, sync): days read "N days ago" too. */
export function agoLabel(at: Date | null, now: Date): string {
  return sinceLabel(at, now, true);
}

const fmt = (n: number) => n.toLocaleString('en-US');

function CardShell({ children }: { children: ReactNode }) {
  return (
    <section aria-labelledby="keepa-service-heading" className="mt-6 rounded border border-slate-200 bg-slate-50 p-4">
      <h2 id="keepa-service-heading" className="text-sm font-semibold text-slate-900">Keepa service</h2>
      {children}
    </section>
  );
}

export function ServiceStatusCard({ overview, error, now }: { overview: KeepaServiceOverview | null; error?: string | null; now: Date }) {
  if (!overview) {
    return (
      <CardShell>
        <p className="mt-1 text-sm text-red-700">{`Service status unavailable (${error ?? 'unknown'})`}</p>
      </CardShell>
    );
  }
  const { status, counts } = overview;
  const refill = status?.refillRate ?? DEFAULT_REFILL_RATE_PER_MIN;
  const weeklyCapacity = Math.round((refill * 60 * 24 * 7) / TOKENS_PER_ASIN);
  const unused = Math.max(0, weeklyCapacity - counts.fetchedLast7d);
  const pct = weeklyCapacity > 0 ? Math.round((unused / weeklyCapacity) * 100) : 0;
  const scopeBehind = Boolean(counts.scopeWeek && counts.kcsWeek && counts.scopeWeek < counts.kcsWeek);
  const rows: Array<[string, string]> = [
    ['Heartbeat', agoLabel(status?.heartbeatAt ?? null, now)],
    ['Booted', agoLabel(status?.bootedAt ?? null, now)],
    ['Last batch', `${agoLabel(status?.lastBatchAt ?? null, now)}${status?.lastBatchLane ? ` (${status.lastBatchLane} lane)` : ''}`],
    ['Tail lane', status?.tailEnabled ? 'on' : 'off'],
    ['Catalog scope week', `${counts.scopeWeek ?? 'none'}${scopeBehind ? ' (behind the explorer)' : ''}`],
    ['Explorer week', counts.kcsWeek ?? 'none'],
    ['Tier 1 in scope', fmt(counts.tier1InScope)],
    ['Tier 1 never fetched', fmt(counts.tier1NeverFetched)],
    ['Tier 1 due for refresh', fmt(counts.tier1Due)],
    ['Oldest tier-1 fetch', ageLabel(counts.oldestTier1FetchedAt, now)],
    ['Tier 1 stale (fetched > 8 days ago)', fmt(counts.tier1Stale)],
    ['Tier 2 in scope / never fetched', `${fmt(counts.tier2InScope)} / ${fmt(counts.tier2NeverFetched)}`],
    ['Fetched last 24 h', fmt(counts.fetchedLast24h)],
    ['Unused capacity, 7 days', `${fmt(unused)} of ${fmt(weeklyCapacity)} (${pct}%)`],
    ['Tokens', status && status.tokensLeft !== null && status.refillRate !== null ? `${fmt(status.tokensLeft)} left · refills ${fmt(status.refillRate)}/min` : 'unknown'],
    ['Claimed right now', fmt(counts.claimed)],
    ['Last error', status?.lastErrorCode ? `${status.lastErrorCode} (${agoLabel(status.lastErrorAt, now)})` : 'none'],
    ['Tier 1 in error backoff', fmt(counts.tier1Erroring)],
    ['New lane last drained', agoLabel(status?.laneNewDrainedAt ?? null, now)],
    ['Explorer sync last fired', agoLabel(status?.syncFiredAt ?? null, now)],
  ];
  return (
    <CardShell>
      <p className="mt-1 text-xs text-slate-600">
        Always-on enrichment on its own Railway service. Target: no tier-1 ASIN fetched more than 8 days ago (delisted ones recheck monthly).
      </p>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1">
            <dt className="text-slate-600">{k}</dt>
            <dd className="text-right font-medium tabular-nums text-slate-900">{v}</dd>
          </div>
        ))}
      </dl>
    </CardShell>
  );
}

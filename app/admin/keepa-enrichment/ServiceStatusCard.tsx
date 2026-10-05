// app/admin/keepa-enrichment/ServiceStatusCard.tsx
import type { KeepaServiceOverview } from '@/lib/keepa/adminOverview';
import { WEEKLY_CAPACITY_ASINS } from '@/lib/keepa/adminOverview';

/** "just now" / "N min ago" / "N h ago" / "N days" / "never". Days are shown without "ago" (an age, not an event). */
export function ageLabel(at: Date | null, now: Date): string {
  if (!at) return 'never';
  const ms = now.getTime() - at.getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} days`;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function ServiceStatusCard({ overview, now }: { overview: KeepaServiceOverview; now: Date }) {
  const { status, counts } = overview;
  const unused = Math.max(0, WEEKLY_CAPACITY_ASINS - counts.fetchedLast7d);
  const unusedPct = Math.round((unused / WEEKLY_CAPACITY_ASINS) * 100);
  const scopeBehind = Boolean(counts.scopeWeek && counts.kcsWeek && counts.scopeWeek !== counts.kcsWeek);
  const rows: Array<[string, string]> = [
    ['Heartbeat', ageLabel(status?.heartbeatAt ?? null, now)],
    ['Booted', ageLabel(status?.bootedAt ?? null, now)],
    ['Last batch', `${ageLabel(status?.lastBatchAt ?? null, now)}${status?.lastBatchLane ? ` (${status.lastBatchLane} lane)` : ''}`],
    ['Tail lane', status?.tailEnabled ? 'on' : 'off'],
    ['Catalog scope week', `${counts.scopeWeek ?? 'none'}${scopeBehind ? ' (behind the explorer)' : ''}`],
    ['Explorer week', counts.kcsWeek ?? 'none'],
    ['Tier 1 in scope', fmt(counts.tier1InScope)],
    ['Tier 1 never fetched', fmt(counts.tier1NeverFetched)],
    ['Tier 1 due for refresh', fmt(counts.tier1Due)],
    ['Oldest tier-1 fetch', ageLabel(counts.oldestTier1FetchedAt, now)],
    ['Tier 2 in scope / never fetched', `${fmt(counts.tier2InScope)} / ${fmt(counts.tier2NeverFetched)}`],
    ['Fetched last 24 h', fmt(counts.fetchedLast24h)],
    ['Unused capacity, 7 days', `${fmt(unused)} of ${fmt(WEEKLY_CAPACITY_ASINS)} (${unusedPct}%)`],
    ['Tokens', status?.tokensLeft !== null && status?.tokensLeft !== undefined ? `${fmt(status.tokensLeft)} / ${fmt(status.refillRate ?? 0)} per min` : 'unknown'],
    ['Claimed right now', fmt(counts.claimed)],
    ['Last error', status?.lastErrorCode ? `${status.lastErrorCode} (${ageLabel(status.lastErrorAt, now)})` : 'none'],
    ['Explorer sync last fired', ageLabel(status?.syncFiredAt ?? null, now)],
  ];
  return (
    <section aria-labelledby="keepa-service-heading" className="mt-6 rounded border border-slate-200 bg-slate-50 p-4">
      <h2 id="keepa-service-heading" className="text-sm font-semibold text-slate-900">Keepa service</h2>
      <p className="mt-1 text-xs text-slate-600">
        Always-on enrichment on its own Railway service. Target: oldest tier-1 fetch no older than 8 days.
      </p>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1">
            <dt className="text-slate-600">{k}</dt>
            <dd className="text-right font-medium tabular-nums text-slate-900">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

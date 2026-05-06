'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

/**
 * Header chip in /admin/* showing import status.
 *
 * Polls /api/admin/notifications/import-status every 5 minutes (per spec
 * §6.3 — relaxed cadence since imports take ~30 min, no need to refresh
 * faster than that). Picks the most relevant entry to display:
 *
 *   1. If any import is currently active, show its in-progress chip.
 *   2. Else if there's a recent terminal entry not dismissed, show it.
 *   3. Else hide.
 *
 * Dismissal is per-fileId, persisted in localStorage. So a dismissal
 * sticks across page navigations and reloads but doesn't carry across
 * browsers/devices — fine for V1.
 */

interface ActiveEntry {
  fileId: string;
  batchId: string;
  filename: string | null;
  phase: string;
  startedAt: string | null;
  heartbeatAt: string | null;
}

interface RecentEntry {
  fileId: string;
  batchId: string;
  filename: string | null;
  outcome: 'completed' | 'completed_with_refresh_failure' | 'failed';
  completedAt: string | null;
  durationMs: number | null;
}

interface StatusResponse {
  active: ActiveEntry[];
  recent: RecentEntry[];
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min per spec
const DISMISSAL_KEY = 'admin.importChip.dismissed';

function loadDismissed(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSAL_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed);
  } catch {
    // ignore
  }
  return new Set();
}

function saveDismissed(set: Set<string>): void {
  try {
    window.localStorage.setItem(DISMISSAL_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage may be unavailable in private mode; chip just won't persist dismissal.
  }
}

export function ImportStatusChip() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await fetch('/api/admin/notifications/import-status', {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = (await res.json()) as StatusResponse;
        if (!cancelled) setStatus(data);
      } catch {
        // network blip — keep showing whatever we last had
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!status) return null;

  // Pick the entry to render: any active first, else most-recent non-dismissed terminal.
  const activeEntry = status.active[0] ?? null;
  const recentEntry = status.recent.find((r) => !dismissed.has(r.fileId)) ?? null;
  const entry = activeEntry ?? recentEntry;
  if (!entry) return null;

  const isActive = !!activeEntry;
  const fileId = entry.fileId;
  const filename = entry.filename ?? '(unknown file)';
  const batchHref = `/admin/batches/${entry.batchId}`;

  let style: { bg: string; border: string; text: string };
  let label: string;
  if (isActive) {
    style = { bg: 'bg-gray-100', border: 'border-gray-300', text: 'text-gray-700' };
    const a = activeEntry as ActiveEntry;
    const startedAgo = a.startedAt
      ? formatAgo(Date.now() - new Date(a.startedAt).getTime())
      : null;
    label = `Import in progress: ${filename}${startedAgo ? ` · started ${startedAgo} ago` : ''} · ${humanPhase(a.phase)}`;
  } else {
    const r = recentEntry as RecentEntry;
    if (r.outcome === 'completed') {
      style = { bg: 'bg-green-50', border: 'border-green-300', text: 'text-green-800' };
      label = `Import complete: ${filename}${r.durationMs ? ` · ${formatDuration(r.durationMs)}` : ''}`;
    } else if (r.outcome === 'completed_with_refresh_failure') {
      style = { bg: 'bg-amber-50', border: 'border-amber-300', text: 'text-amber-900' };
      label = `Import OK, summary stale: ${filename}`;
    } else {
      style = { bg: 'bg-red-50', border: 'border-red-300', text: 'text-red-800' };
      label = `Import failed: ${filename}`;
    }
  }

  return (
    <div
      className={`flex items-center gap-3 border-b ${style.border} ${style.bg} ${style.text} px-4 py-2 text-sm`}
    >
      <Link href={batchHref} className="flex-1 hover:underline truncate" title={filename}>
        {label}
      </Link>
      {!isActive && (
        <button
          type="button"
          onClick={() => {
            const next = new Set(dismissed);
            next.add(fileId);
            setDismissed(next);
            saveDismissed(next);
          }}
          aria-label="Dismiss"
          className="text-gray-500 hover:text-gray-900"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function formatAgo(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  return `${hr} hr`;
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  return `${min} min`;
}

function humanPhase(phase: string): string {
  switch (phase) {
    case 'lock_acquired':
      return 'starting';
    case 'staging_copy':
      return 'streaming CSV';
    case 'kwm_insert':
      return 'inserting rows';
    case 'mark_imported':
      return 'finalizing';
    case 'summary_refresh':
      return 'rebuilding summary';
    default:
      return phase;
  }
}

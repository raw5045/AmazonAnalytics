/**
 * Generic, admin-only server-handler timing panel — the reusable form of
 * explorer/PerfStrip. Each page measures its own steps (Date.now() around the
 * awaits) and passes them in; the panel renders a collapsed <details> bar with
 * a one-line summary, an expandable per-step breakdown, a computed "remainder"
 * row (total − accounted steps ≈ render + serialization), and the cold-start
 * footnote.
 *
 * Admin-gated: renders nothing unless `admin` is true. Explorer keeps its own
 * tailored PerfStrip; this covers the other main pages.
 */
import type { PerfStep } from '@/lib/perf/handlerTimer';

export interface PerfPanelData {
  totalMs: number;
  steps: PerfStep[];
  /** Override the default cold-start footnote. */
  footnote?: string;
}

const DEFAULT_FOOTNOTE =
  'this is server-handler time only. Browser-perceived total also includes ' +
  'Vercel function cold-start, Neon compute warm-up, network, and rendering — ' +
  'usually 0.2-2s on cold, near-zero on warm.';

export function PerfPanel({ admin, data }: { admin: boolean; data: PerfPanelData }) {
  if (!admin) return null;

  const summary = [
    `total=${data.totalMs}ms`,
    ...data.steps.map((s) => `${s.label}=${s.ms}ms`),
  ].join(' · ');

  const heavy = data.totalMs > 1000;
  const accounted = data.steps.reduce((sum, s) => sum + s.ms, 0);

  return (
    <details className={`text-xs ${heavy ? 'text-red-700' : 'text-gray-500'} mb-2`}>
      <summary className="cursor-pointer select-none font-mono">perf · {summary}</summary>
      <div className="mt-2 ml-4 font-mono text-gray-600 space-y-0.5">
        <Row label="server handler total" value={data.totalMs} />
        {data.steps.map((s) => (
          <Row key={s.label} label={`  ↳ ${s.label}`} value={s.ms} note={s.note} />
        ))}
        <Row
          label="  ↳ remainder (render + serialization + unsequenced overhead)"
          value={data.totalMs - accounted}
        />
        <div className="mt-2 text-gray-500">Note: {data.footnote ?? DEFAULT_FOOTNOTE}</div>
      </div>
    </details>
  );
}

function Row({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="flex">
      <span className="flex-1">{label}</span>
      <span className="tabular-nums">{value}ms</span>
      {note && <span className="ml-2 text-gray-400">({note})</span>}
    </div>
  );
}

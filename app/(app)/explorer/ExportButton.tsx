'use client';

import { useState } from 'react';
import { EXPORT_ROW_CAP } from '@/lib/explorer/export/buildCsv';

/**
 * "Export CSV" for the current explorer results. `query` is the effective
 * filter query string the page computed (saved view already resolved), so
 * the download matches the table exactly. The route caps rows and daily
 * exports; both outcomes are reported inline next to the button.
 */
type Status = 'idle' | 'exporting' | 'done' | 'error';

const FAILED = 'Export failed — please try again.';

export function ExportButton({ query }: { query: string }) {
  const [status, setStatus] = useState<Status>('idle');
  const [note, setNote] = useState<string | null>(null);

  async function run() {
    setStatus('exporting');
    setNote(null);
    try {
      const res = await fetch(`/api/explorer/export?${query}`, { headers: { accept: 'text/csv' } });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setNote(res.status === 429 && body.error ? body.error : FAILED);
        setStatus('error');
        return;
      }
      const blob = await res.blob();
      const filename =
        /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
        'keywordquarry-keywords.csv';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const rows = Number(res.headers.get('x-export-rows') ?? '0');
      const truncated = res.headers.get('x-export-truncated') === 'true';
      setNote(
        `Downloaded ${rows.toLocaleString()} rows${
          truncated ? ` (first ${EXPORT_ROW_CAP.toLocaleString()} of a larger result)` : ''
        }.`,
      );
      setStatus('done');
    } catch {
      setNote(FAILED);
      setStatus('error');
    }
  }

  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <button
        type="button"
        onClick={run}
        disabled={status === 'exporting'}
        title={`Download the current results as CSV (up to ${EXPORT_ROW_CAP.toLocaleString()} rows)`}
        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
      >
        {status === 'exporting' ? 'Exporting…' : 'Export CSV'}
      </button>
      {note && <span className={status === 'error' ? 'text-red-700' : 'text-gray-600'}>{note}</span>}
    </span>
  );
}

'use client';

import { useState } from 'react';

type Phase = 'idle' | 'presigning' | 'uploading' | 'finalizing' | 'queued' | 'failed';

export function MonthlySfrUploader() {
  const [file, setFile] = useState<File | null>(null);
  const [monthEndDate, setMonthEndDate] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [uploadPct, setUploadPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setMonthEndDate('');
    setPhase('idle');
    setUploadPct(0);
    setError(null);
    setEventId(null);
  }

  async function startUpload() {
    if (!file || !monthEndDate) return;
    setError(null);
    setEventId(null);

    try {
      // 1. Presign
      setPhase('presigning');
      const presignRes = await fetch('/api/admin/monthly-sfr/presign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, monthEndDate }),
      });
      if (!presignRes.ok) {
        throw new Error(`presign failed (${presignRes.status})`);
      }
      const { storageKey, uploadUrl } = (await presignRes.json()) as {
        storageKey: string;
        uploadUrl: string;
      };

      // 2. Browser → R2 direct upload, with progress tracking via XHR
      setPhase('uploading');
      await uploadOne(file, uploadUrl, setUploadPct);

      // 3. Notify server to kick off processing
      setPhase('finalizing');
      const processRes = await fetch('/api/admin/monthly-sfr/process', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storageKey, monthEndDate, filename: file.name }),
      });
      if (!processRes.ok) {
        throw new Error(`process trigger failed (${processRes.status})`);
      }
      const { eventId: id } = (await processRes.json()) as { eventId: string | null };
      setEventId(id);
      setPhase('queued');
    } catch (e) {
      setPhase('failed');
      setError(e instanceof Error ? e.message : 'upload failed');
    }
  }

  const canSubmit =
    file !== null &&
    /^\d{4}-\d{2}-\d{2}$/.test(monthEndDate) &&
    (phase === 'idle' || phase === 'failed');

  return (
    <div className="flex flex-col gap-4">
      <label className="block">
        <span className="text-sm font-medium text-gray-700">CSV file</span>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={phase !== 'idle' && phase !== 'failed'}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-sm"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">
          Month end date (last day of the reporting month — e.g. 2026-04-30)
        </span>
        <input
          type="date"
          disabled={phase !== 'idle' && phase !== 'failed'}
          value={monthEndDate}
          onChange={(e) => setMonthEndDate(e.target.value)}
          className="mt-1 block w-64 rounded border border-gray-300 px-2 py-1 text-sm"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={startUpload}
          disabled={!canSubmit}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:bg-gray-300"
        >
          Upload and process
        </button>
        {phase === 'queued' && (
          <button
            type="button"
            onClick={reset}
            className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
          >
            Upload another
          </button>
        )}
      </div>

      {phase !== 'idle' && (
        <div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm">
          <div className="font-medium text-gray-800">Status: {phase}</div>
          {phase === 'uploading' && (
            <div className="mt-1 text-gray-600">
              {uploadPct.toFixed(0)}% uploaded to R2 ({file?.name})
            </div>
          )}
          {phase === 'queued' && (
            <div className="mt-1 text-gray-700">
              ✓ Upload complete. Processing started in background. Check the{' '}
              <a
                href="https://app.inngest.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 underline"
              >
                Inngest dashboard
              </a>{' '}
              for status (function: <code className="font-mono text-xs">process-monthly-sfr</code>).
              {eventId && <span className="ml-2 font-mono text-xs text-gray-500">event id: {eventId}</span>}
            </div>
          )}
          {phase === 'failed' && error && (
            <div className="mt-1 text-red-700">Error: {error}</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Upload a single file to a presigned R2 URL via XHR with progress
 * tracking. We use XHR (not fetch) here because fetch doesn't expose
 * upload progress events.
 */
function uploadOne(
  file: File,
  url: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', 'text/csv');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`R2 upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('R2 upload network error'));
    xhr.send(file);
  });
}

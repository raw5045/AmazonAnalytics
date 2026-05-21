'use client';

import { useState } from 'react';

type Phase = 'idle' | 'presigning' | 'uploading' | 'finalizing' | 'queued' | 'failed';

export function CalibrationUploader() {
  const [baFile, setBaFile] = useState<File | null>(null);
  const [poeFile, setPoeFile] = useState<File | null>(null);
  const [monthEndDate, setMonthEndDate] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [baPct, setBaPct] = useState(0);
  const [poePct, setPoePct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);

  function reset() {
    setBaFile(null);
    setPoeFile(null);
    setMonthEndDate('');
    setPhase('idle');
    setBaPct(0);
    setPoePct(0);
    setError(null);
    setEventId(null);
  }

  async function startUpload() {
    if (!baFile || !poeFile || !monthEndDate) return;
    setError(null);
    setEventId(null);

    try {
      // 1. Presign both URLs in one round-trip
      setPhase('presigning');
      const presignRes = await fetch('/api/admin/calibration/presign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baFilename: baFile.name,
          poeFilename: poeFile.name,
          monthEndDate,
        }),
      });
      if (!presignRes.ok) {
        throw new Error(`presign failed (${presignRes.status})`);
      }
      const { jobKey, ba, poe } = (await presignRes.json()) as {
        jobKey: string;
        ba: { storageKey: string; uploadUrl: string };
        poe: { storageKey: string; uploadUrl: string };
      };

      // 2. Browser → R2 direct uploads in parallel
      setPhase('uploading');
      await Promise.all([
        uploadOne(baFile, ba.uploadUrl, setBaPct),
        uploadOne(poeFile, poe.uploadUrl, setPoePct),
      ]);

      // 3. Notify server to fire the combined-processing Inngest event
      setPhase('finalizing');
      const processRes = await fetch('/api/admin/calibration/process', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobKey,
          baStorageKey: ba.storageKey,
          poeStorageKey: poe.storageKey,
          baFilename: baFile.name,
          poeFilename: poeFile.name,
          monthEndDate,
        }),
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
    baFile !== null &&
    poeFile !== null &&
    /^\d{4}-\d{2}-\d{2}$/.test(monthEndDate) &&
    (phase === 'idle' || phase === 'failed');
  const inputsDisabled = phase !== 'idle' && phase !== 'failed';

  return (
    <div className="flex flex-col gap-4">
      <label className="block">
        <span className="text-sm font-medium text-gray-700">
          Monthly Brand Analytics SFR (CSV)
        </span>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={inputsDisabled}
          onChange={(e) => setBaFile(e.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-sm"
        />
        {baFile && (
          <span className="mt-1 block text-xs text-gray-500">
            {baFile.name} ({(baFile.size / 1024 / 1024).toFixed(1)} MB)
          </span>
        )}
      </label>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">
          POE 30-day search-volume CSV
        </span>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={inputsDisabled}
          onChange={(e) => setPoeFile(e.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-sm"
        />
        {poeFile && (
          <span className="mt-1 block text-xs text-gray-500">
            {poeFile.name} ({(poeFile.size / 1024).toFixed(1)} KB)
          </span>
        )}
      </label>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">
          Month end date (last day of the month this data represents)
        </span>
        <input
          type="date"
          disabled={inputsDisabled}
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
          Upload and create map
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
              BA upload:  {baPct.toFixed(0)}%
              <br />
              POE upload: {poePct.toFixed(0)}%
            </div>
          )}
          {phase === 'queued' && (
            <div className="mt-1 text-gray-700">
              ✓ Both files uploaded. Processing kicked off in background — BA
              ingest ({'~'}5 min), POE ingest ({'<'}1 min), then fit ({'<'}1 min).
              You&apos;ll get an email when it&apos;s done with the fit results.
              <br />
              <span className="mt-2 inline-block text-gray-500">
                Watch live in the{' '}
                <a
                  href="https://app.inngest.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 underline"
                >
                  Inngest dashboard
                </a>{' '}
                (function: <code className="font-mono text-xs">process-calibration-upload</code>)
              </span>
              {eventId && (
                <div className="mt-1 font-mono text-xs text-gray-500">event id: {eventId}</div>
              )}
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

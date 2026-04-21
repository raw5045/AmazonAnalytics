'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type FileStatus = 'queued' | 'uploading' | 'uploaded' | 'failed';

interface FileState {
  file: File;
  fileId?: string;
  status: FileStatus;
  progress: number;
  error?: string;
}

export function BulkUploader() {
  const [files, setFiles] = useState<FileState[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function onFilePick(list: FileList | null) {
    if (!list) return;
    const added: FileState[] = Array.from(list).map((f) => ({
      file: f,
      status: 'queued',
      progress: 0,
    }));
    setFiles((prev) => [...prev, ...added]);
  }

  async function startUpload() {
    setUploading(true);
    setError(null);

    try {
      // 1. Create batch
      const batchRes = await fetch('/api/admin/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batchType: 'zip_backfill' }),
      });
      if (!batchRes.ok) throw new Error('failed to create batch');
      const { batchId: newBatchId } = await batchRes.json();
      setBatchId(newBatchId);

      // 2. Request presigned URLs
      const presignRes = await fetch(`/api/admin/batches/${newBatchId}/presign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          files: files.map((f) => ({ filename: f.file.name, size: f.file.size })),
        }),
      });
      if (!presignRes.ok) throw new Error('failed to get presigned urls');
      const { files: presigned } = await presignRes.json();

      // 3. Upload files in parallel (limit 4)
      await runWithConcurrency(4, presigned, async (p: { fileId: string; url: string }, idx: number) => {
        setFiles((prev) =>
          prev.map((f, i) => (i === idx ? { ...f, fileId: p.fileId, status: 'uploading' } : f)),
        );
        try {
          await uploadOne(files[idx].file, p.url, (pct) => {
            setFiles((prev) => prev.map((f, i) => (i === idx ? { ...f, progress: pct } : f)));
          });
          await fetch(`/api/admin/batches/${newBatchId}/files/${p.fileId}/complete`, { method: 'POST' });
          setFiles((prev) =>
            prev.map((f, i) => (i === idx ? { ...f, status: 'uploaded', progress: 100 } : f)),
          );
        } catch (e) {
          setFiles((prev) =>
            prev.map((f, i) =>
              i === idx ? { ...f, status: 'failed', error: e instanceof Error ? e.message : 'failed' } : f,
            ),
          );
        }
      });

      // 4. Finalize batch
      await fetch(`/api/admin/batches/${newBatchId}/finalize`, { method: 'POST' });
      router.push(`/admin/batches/${newBatchId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="block rounded border-2 border-dashed p-8 text-center">
        <input
          type="file"
          accept=".csv,text/csv"
          multiple
          onChange={(e) => onFilePick(e.target.files)}
          disabled={uploading}
          className="hidden"
        />
        <span className="cursor-pointer underline">Click to select CSV files</span>
      </label>

      {files.length > 0 && (
        <ul className="divide-y rounded border">
          {files.map((f, i) => (
            <li key={i} className="flex items-center justify-between p-2 text-sm">
              <span className="truncate">{f.file.name}</span>
              <span className="ml-4 font-mono">
                {f.status} {f.progress > 0 && f.progress < 100 ? `${f.progress}%` : ''}
                {f.error && <span className="text-red-600"> {f.error}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <button
        onClick={startUpload}
        disabled={files.length === 0 || uploading}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {uploading ? 'Uploading…' : `Start upload (${files.length} files)`}
      </button>

      {batchId && <p className="text-xs text-gray-500">Batch: {batchId}</p>}
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}

async function uploadOne(file: File, url: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'text/csv');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(file);
  });
}

async function runWithConcurrency<T>(
  limit: number,
  items: T[],
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers = Array(Math.min(limit, items.length))
    .fill(null)
    .map(async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    });
  await Promise.all(workers);
}

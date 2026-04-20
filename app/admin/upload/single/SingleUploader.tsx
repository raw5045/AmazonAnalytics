'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SingleUploader() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const router = useRouter();

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError(null);

    try {
      const batchRes = await fetch('/api/admin/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batchType: 'single_csv' }),
      });
      const { batchId } = await batchRes.json();

      const presignRes = await fetch(`/api/admin/batches/${batchId}/presign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ filename: file.name, size: file.size }] }),
      });
      const { files: presigned } = await presignRes.json();
      const p = presigned[0];

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', p.url);
        xhr.setRequestHeader('Content-Type', 'text/csv');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
        xhr.onerror = () => reject(new Error('network error'));
        xhr.send(file);
      });

      await fetch(`/api/admin/batches/${batchId}/files/${p.fileId}/complete`, { method: 'POST' });
      await fetch(`/api/admin/batches/${batchId}/finalize`, { method: 'POST' });

      router.push(`/admin/batches/${batchId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={uploading}
      />
      <button
        onClick={handleUpload}
        disabled={!file || uploading}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {uploading ? `Uploading… ${progress}%` : 'Upload'}
      </button>
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}

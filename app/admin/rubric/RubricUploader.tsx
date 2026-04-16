'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function RubricUploader() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/admin/schema/rubric', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Upload failed');
      }
      const { uploadedFileId } = await res.json();
      router.push(`/admin/rubric/${uploadedFileId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <form onSubmit={handleUpload} className="flex max-w-md flex-col gap-4">
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={uploading}
      />
      <button
        type="submit"
        disabled={!file || uploading}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {uploading ? 'Uploading…' : 'Upload rubric CSV'}
      </button>
      {error && <p className="text-red-600">{error}</p>}
    </form>
  );
}

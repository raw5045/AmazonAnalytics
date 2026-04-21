import { eq, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles, reportingWeeks } from '@/db/schema';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { BatchActions } from './BatchActions';

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const batch = await db.query.uploadBatches.findFirst({ where: eq(uploadBatches.id, id) });
  if (!batch) notFound();

  const files = await db.query.uploadedFiles.findMany({
    where: eq(uploadedFiles.batchId, id),
    orderBy: [asc(uploadedFiles.weekEndDate)],
  });

  const loadedWeeks = await db.query.reportingWeeks.findMany({
    orderBy: [asc(reportingWeeks.weekEndDate)],
  });
  const loadedWeekSet = new Set(loadedWeeks.map((w) => w.weekEndDate));

  const passed = files.filter((f) => f.validationStatus === 'pass').length;
  const warned = files.filter((f) => f.validationStatus === 'pass_with_warnings').length;
  const failed = files.filter((f) => f.validationStatus === 'fail' || f.validationStatus === 'import_failed').length;
  const pending = files.filter((f) => f.validationStatus === 'pending').length;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Batch {batch.id.slice(0, 8)}</h1>
        <dl className="mt-2 grid grid-cols-4 gap-4 text-sm">
          <div><dt className="text-gray-500">Status</dt><dd className="font-mono">{batch.status}</dd></div>
          <div><dt className="text-gray-500">Total files</dt><dd>{files.length}</dd></div>
          <div><dt className="text-gray-500">Passed / warned / failed</dt><dd>{passed} / {warned} / {failed}</dd></div>
          <div><dt className="text-gray-500">Pending</dt><dd>{pending}</dd></div>
        </dl>
      </header>

      <BatchActions batchId={batch.id} status={batch.status} />

      <section>
        <h2 className="text-lg font-semibold">Files</h2>
        <table className="mt-2 w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr><th className="p-2">Filename</th><th className="p-2">Week end</th><th className="p-2">Row count</th><th className="p-2">Status</th><th className="p-2"></th></tr>
          </thead>
          <tbody className="divide-y">
            {files.map((f) => (
              <tr key={f.id}>
                <td className="p-2 truncate max-w-xs">{f.originalFilename}</td>
                <td className="p-2">{f.weekEndDate ?? '—'}</td>
                <td className="p-2">{f.rowCountRaw ?? '—'}</td>
                <td className="p-2 font-mono">{f.validationStatus}</td>
                <td className="p-2"><Link className="underline" href={`/admin/batches/${batch.id}/files/${f.id}`}>Details</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Loaded weeks (global)</h2>
        <p className="mt-1 text-sm text-gray-500">{loadedWeekSet.size} weeks currently in keyword_weekly_metrics</p>
      </section>
    </div>
  );
}

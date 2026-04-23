import { eq, asc, sql, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  uploadBatches,
  uploadedFiles,
  reportingWeeks,
  stagingWeeklyMetrics,
  keywordWeeklyMetrics,
} from '@/db/schema';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { BatchActions } from './BatchActions';
import { AutoRefresh } from './AutoRefresh';

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

  const passed = files.filter((f) => f.validationStatus === 'pass').length;
  const warned = files.filter((f) => f.validationStatus === 'pass_with_warnings').length;
  const failed = files.filter((f) => f.validationStatus === 'fail' || f.validationStatus === 'import_failed').length;
  const pending = files.filter((f) => f.validationStatus === 'pending').length;
  const imported = files.filter((f) => f.validationStatus === 'imported').length;

  // Live progress: per-file staging row count + final-table row count.
  // Helps the user see import is actually moving even when status is just "importing".
  const fileIds = files.map((f) => f.id);
  let stagingProgressByFile = new Map<string, number>();
  let importedProgressByFile = new Map<string, number>();
  if (fileIds.length > 0) {
    const stagingRows = (await db
      .select({
        fileId: stagingWeeklyMetrics.uploadedFileId,
        c: sql<number>`count(*)::int`,
      })
      .from(stagingWeeklyMetrics)
      .where(inArray(stagingWeeklyMetrics.uploadedFileId, fileIds))
      .groupBy(stagingWeeklyMetrics.uploadedFileId)) as Array<{ fileId: string; c: number }>;
    stagingProgressByFile = new Map(stagingRows.map((r) => [r.fileId, r.c]));

    const importedRows = (await db
      .select({
        fileId: keywordWeeklyMetrics.sourceFileId,
        c: sql<number>`count(*)::int`,
      })
      .from(keywordWeeklyMetrics)
      .where(inArray(keywordWeeklyMetrics.sourceFileId, fileIds))
      .groupBy(keywordWeeklyMetrics.sourceFileId)) as Array<{ fileId: string; c: number }>;
    importedProgressByFile = new Map(importedRows.map((r) => [r.fileId, r.c]));
  }

  // Auto-refresh while anything is in motion: batch is uploading/validating/importing,
  // OR any file is pending/pass/pass_with_warnings (waiting on something to happen next).
  const inMotionStatuses = new Set(['uploaded', 'validating', 'importing']);
  const fileInMotionStatuses = new Set(['pending']);
  const shouldAutoRefresh =
    inMotionStatuses.has(batch.status) ||
    files.some((f) => fileInMotionStatuses.has(f.validationStatus));

  // Human-readable current activity for the header
  let activityHint = '';
  if (batch.status === 'uploaded' || files.some((f) => f.validationStatus === 'pending')) {
    activityHint = 'Validating files…';
  } else if (batch.status === 'importing') {
    activityHint = 'Importing into keyword_weekly_metrics…';
  } else if (batch.status === 'imported') {
    activityHint = 'All done.';
  }

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh shouldRefresh={shouldAutoRefresh} />

      <header>
        <h1 className="text-2xl font-semibold">Batch {batch.id.slice(0, 8)}</h1>
        <dl className="mt-2 grid grid-cols-4 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">Status</dt>
            <dd className="font-mono">
              {shouldAutoRefresh ? <span className="inline-block animate-pulse">⏳ </span> : null}
              {batch.status}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Total files</dt>
            <dd>{files.length}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Passed / warned / failed / imported</dt>
            <dd>
              {passed} / {warned} / {failed} / {imported}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Pending</dt>
            <dd>{pending}</dd>
          </div>
        </dl>
        {activityHint && (
          <p className="mt-3 rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
            {shouldAutoRefresh && <span className="mr-2 inline-block animate-spin">↻</span>}
            {activityHint}
            {shouldAutoRefresh && <span className="ml-2 text-xs text-blue-700">(auto-refresh on)</span>}
          </p>
        )}
      </header>

      <BatchActions batchId={batch.id} status={batch.status} />

      <section>
        <h2 className="text-lg font-semibold">Files</h2>
        <table className="mt-2 w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="p-2">Filename</th>
              <th className="p-2">Week end</th>
              <th className="p-2">Total rows</th>
              <th className="p-2">Status</th>
              <th className="p-2">Progress</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {files.map((f) => {
              const stagedSoFar = stagingProgressByFile.get(f.id) ?? 0;
              const importedSoFar = importedProgressByFile.get(f.id) ?? 0;
              const total = f.rowCountRaw ?? 0;
              let progressLabel = '—';
              if (f.validationStatus === 'imported') {
                progressLabel = `✓ ${importedSoFar.toLocaleString()} rows imported`;
              } else if (stagedSoFar > 0 && total > 0) {
                const pct = Math.min(99, Math.floor((stagedSoFar / total) * 100));
                progressLabel = `Staging: ${stagedSoFar.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
              } else if (importedSoFar > 0 && total > 0) {
                const pct = Math.min(99, Math.floor((importedSoFar / total) * 100));
                progressLabel = `Promoting: ${importedSoFar.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
              } else if (f.validationStatus === 'pass' || f.validationStatus === 'pass_with_warnings') {
                progressLabel = 'Ready to import';
              } else if (f.validationStatus === 'pending') {
                progressLabel = 'Validating…';
              } else if (f.validationStatus === 'fail' || f.validationStatus === 'import_failed') {
                progressLabel = '✗ Failed';
              }
              return (
                <tr key={f.id}>
                  <td className="p-2 truncate max-w-xs">{f.originalFilename}</td>
                  <td className="p-2">{f.weekEndDate ?? '—'}</td>
                  <td className="p-2">{f.rowCountRaw?.toLocaleString() ?? '—'}</td>
                  <td className="p-2 font-mono">{f.validationStatus}</td>
                  <td className="p-2 text-xs text-gray-700">{progressLabel}</td>
                  <td className="p-2">
                    <Link className="underline" href={`/admin/batches/${batch.id}/files/${f.id}`}>
                      Details
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Loaded weeks (global)</h2>
        <p className="mt-1 text-sm text-gray-500">
          {loadedWeeks.length} weeks currently in keyword_weekly_metrics
        </p>
      </section>
    </div>
  );
}

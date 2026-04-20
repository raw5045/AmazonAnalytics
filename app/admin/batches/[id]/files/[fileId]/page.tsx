import { eq, asc, and, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadedFiles, ingestionErrors } from '@/db/schema';
import { notFound } from 'next/navigation';
import { ReplaceWeekButton } from './ReplaceWeekButton';

export default async function FileDetailPage({
  params,
}: {
  params: Promise<{ id: string; fileId: string }>;
}) {
  const { fileId } = await params;
  const file = await db.query.uploadedFiles.findFirst({ where: eq(uploadedFiles.id, fileId) });
  if (!file) notFound();

  const errors = await db.query.ingestionErrors.findMany({
    where: eq(ingestionErrors.uploadedFileId, fileId),
    orderBy: [asc(ingestionErrors.rowNumber)],
    limit: 500,
  });

  const weekLoadedError = errors.find((e) => e.code === 'WEEK_ALREADY_LOADED');
  let conflictingFileId: string | null = null;
  if (weekLoadedError && file.weekEndDate) {
    const existing = await db.query.uploadedFiles.findFirst({
      where: and(
        eq(uploadedFiles.weekEndDate, file.weekEndDate),
        ne(uploadedFiles.id, file.id),
      ),
    });
    conflictingFileId = existing?.id ?? null;
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">File {file.originalFilename}</h1>
        <dl className="mt-2 grid grid-cols-3 gap-4 text-sm">
          <div><dt className="text-gray-500">Status</dt><dd className="font-mono">{file.validationStatus}</dd></div>
          <div><dt className="text-gray-500">Week end</dt><dd>{file.weekEndDate ?? '—'}</dd></div>
          <div><dt className="text-gray-500">Rows</dt><dd>{file.rowCountRaw ?? '—'}</dd></div>
        </dl>
      </header>

      {weekLoadedError && conflictingFileId && (
        <div className="rounded border border-amber-300 bg-amber-50 p-4">
          <h3 className="font-semibold">Duplicate week — action needed</h3>
          <p className="mt-2 text-sm">
            Week {file.weekEndDate} is already loaded. Click below to replace the existing week with this file.
          </p>
          <div className="mt-3">
            <ReplaceWeekButton fileId={file.id} replacesFileId={conflictingFileId} />
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">Errors ({errors.length})</h2>
          <table className="mt-2 w-full text-sm">
            <thead className="bg-gray-100 text-left">
              <tr><th className="p-2">Row</th><th className="p-2">Column</th><th className="p-2">Code</th><th className="p-2">Message</th></tr>
            </thead>
            <tbody className="divide-y">
              {errors.map((e) => (
                <tr key={e.id}>
                  <td className="p-2">{e.rowNumber ?? '—'}</td>
                  <td className="p-2">{e.columnName ?? '—'}</td>
                  <td className="p-2 font-mono">{e.code}</td>
                  <td className="p-2">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {file.validationWarningsJson != null && (
        <section>
          <h2 className="text-lg font-semibold">Warnings</h2>
          <pre className="mt-2 rounded bg-gray-100 p-2 text-xs overflow-auto">{JSON.stringify(file.validationWarningsJson, null, 2)}</pre>
        </section>
      )}

      {file.validationInfoJson != null && (
        <section>
          <h2 className="text-lg font-semibold">Informational stats</h2>
          <pre className="mt-2 rounded bg-gray-100 p-2 text-xs overflow-auto">{JSON.stringify(file.validationInfoJson, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadedFiles, schemaVersions } from '@/db/schema';
import { notFound } from 'next/navigation';
import { ApproveSchemaButton } from './ApproveSchemaButton';

export default async function RubricDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = await db.query.uploadedFiles.findFirst({
    where: eq(uploadedFiles.id, id),
  });
  if (!file) notFound();

  const schemaVersion = file.schemaVersionId
    ? await db.query.schemaVersions.findFirst({ where: eq(schemaVersions.id, file.schemaVersionId) })
    : null;

  return (
    <div>
      <h1 className="text-2xl font-semibold">Rubric preview</h1>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <dt>File</dt>
        <dd>{file.originalFilename}</dd>
        <dt>Week end</dt>
        <dd>{file.weekEndDate ?? '—'}</dd>
        <dt>Reporting date</dt>
        <dd>{file.reportingDateRaw ?? '—'}</dd>
        <dt>Schema version</dt>
        <dd>{schemaVersion ? `v${schemaVersion.versionNumber} (${schemaVersion.status})` : 'processing…'}</dd>
      </dl>
      {schemaVersion?.status === 'draft' && (
        <div className="mt-6">
          <ApproveSchemaButton schemaVersionId={schemaVersion.id} fileId={file.id} />
        </div>
      )}
      {!schemaVersion && (
        <p className="mt-4 text-gray-500">Processing… refresh in a few seconds.</p>
      )}
    </div>
  );
}

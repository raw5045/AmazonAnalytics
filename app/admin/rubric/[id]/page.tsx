import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadedFiles, schemaVersions } from '@/db/schema';
import { notFound, redirect } from 'next/navigation';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { ApproveSchemaButton } from './ApproveSchemaButton';

export default async function RubricDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // Page-level gate, mirroring app/admin/ask-ai/page.tsx: Next 16 renders layouts and pages in
  // parallel, and a client-sent Next-Router-State-Tree can claim the /admin layout already ran, so
  // app/admin/layout.tsx's requireAdmin() is not a guaranteed gate on its own (vendored docs,
  // 01-app/02-guides/authentication.md, "Layouts and auth checks"). Checked here before any data read.
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer');
    throw e;
  }
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

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import {
  uploadBatches,
  uploadedFiles,
  ingestionErrors,
  stagingWeeklyMetrics,
} from '@/db/schema';
import { deleteFromR2 } from '@/lib/storage/r2';

/**
 * Cancel a batch and clean up everything associated with it:
 * - Delete each file's object from R2
 * - Delete ingestion_errors rows
 * - Delete staging_weekly_metrics rows (in case import was mid-way)
 * - Delete uploaded_files rows
 * - Delete the batch row itself
 *
 * Refuses to cancel batches that have already imported (data is in
 * keyword_weekly_metrics; cancelling would leave orphaned data).
 * Refuses to cancel mid-import batches (Inngest worker would still
 * be running and would re-create rows).
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json(
        { error: e.message },
        { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 },
      );
    }
    throw e;
  }

  const { id } = await params;

  const batch = await db.query.uploadBatches.findFirst({ where: eq(uploadBatches.id, id) });
  if (!batch) {
    return NextResponse.json({ error: 'batch not found' }, { status: 404 });
  }
  if (batch.status === 'imported' || batch.status === 'imported_partial') {
    return NextResponse.json(
      { error: 'cannot cancel a batch that has already imported data' },
      { status: 400 },
    );
  }
  if (batch.status === 'importing') {
    return NextResponse.json(
      { error: 'cannot cancel while import is running; wait for it to finish' },
      { status: 400 },
    );
  }

  // Look up all files in this batch so we can clean R2 and DB
  const files = await db.query.uploadedFiles.findMany({
    where: eq(uploadedFiles.batchId, id),
  });

  let r2Deleted = 0;
  let r2Failed = 0;

  for (const f of files) {
    if (f.storageKey) {
      const ok = await deleteFromR2(f.storageKey);
      if (ok) r2Deleted++;
      else r2Failed++;
    }
    // Delete dependent rows BEFORE the file row (FK order)
    await db.delete(ingestionErrors).where(eq(ingestionErrors.uploadedFileId, f.id));
    await db.delete(stagingWeeklyMetrics).where(eq(stagingWeeklyMetrics.uploadedFileId, f.id));
  }

  // Null out self-references before deleting the file rows
  for (const f of files) {
    await db
      .update(uploadedFiles)
      .set({ replacesFileId: null })
      .where(eq(uploadedFiles.id, f.id));
  }

  // Delete the file rows
  await db.delete(uploadedFiles).where(eq(uploadedFiles.batchId, id));

  // Finally, delete the batch itself
  await db.delete(uploadBatches).where(eq(uploadBatches.id, id));

  return NextResponse.json({
    ok: true,
    deletedFiles: files.length,
    r2Deleted,
    r2Failed,
    redirectTo: '/admin/batches',
  });
}

export const runtime = 'nodejs';

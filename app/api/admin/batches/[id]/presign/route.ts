import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadedFiles, uploadBatches } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { buildUploadStorageKey, getPresignedUploadUrl } from '@/lib/storage/r2';

interface PresignRequest {
  files: { filename: string; size: number }[];
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { id: batchId } = await params;
  const body = (await req.json().catch(() => ({}))) as Partial<PresignRequest>;
  if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
    return NextResponse.json({ error: 'files array is required' }, { status: 400 });
  }
  if (body.files.length > 100) {
    return NextResponse.json({ error: 'max 100 files per presign request' }, { status: 400 });
  }

  // Insert one uploaded_files row per file (pending), get back ids
  const rows = await db
    .insert(uploadedFiles)
    .values(
      body.files.map((f) => ({
        batchId,
        storageKey: '',
        originalFilename: f.filename,
        validationStatus: 'pending' as const,
      })),
    )
    .returning();

  // Generate presigned URLs in parallel, set storageKey
  const presigned = await Promise.all(
    rows.map(async (row, idx) => {
      const filename = body.files![idx].filename;
      const key = buildUploadStorageKey({ batchId, fileId: row.id, filename });
      await db.update(uploadedFiles).set({ storageKey: key }).where(eq(uploadedFiles.id, row.id));
      const url = await getPresignedUploadUrl(key, 'text/csv', 3600); // 1 hr
      return { fileId: row.id, storageKey: key, url };
    }),
  );

  // Update batch total_files
  await db
    .update(uploadBatches)
    .set({ totalFiles: rows.length })
    .where(eq(uploadBatches.id, batchId));

  return NextResponse.json({ files: presigned });
}

export const runtime = 'nodejs';

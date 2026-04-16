import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { uploadToR2 } from '@/lib/storage/r2';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles } from '@/db/schema';
import { inngest } from '@/inngest/client';
import { createHash } from 'crypto';

export async function POST(req: Request) {
  let user;
  try {
    user = await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const formData = await req.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const checksum = createHash('sha256').update(buf).digest('hex');
  const storageKey = `rubrics/${checksum}.csv`;
  await uploadToR2(storageKey, buf, 'text/csv');

  // Create a batch row and file row
  const [batch] = await db
    .insert(uploadBatches)
    .values({
      batchType: 'single_csv',
      status: 'validating',
      totalFiles: 1,
      createdByUserId: user.id,
    })
    .returning();

  const [uploadedFile] = await db
    .insert(uploadedFiles)
    .values({
      batchId: batch.id,
      storageKey,
      originalFilename: file.name,
      fileChecksum: checksum,
      validationStatus: 'pending',
    })
    .returning();

  // Trigger Inngest
  await inngest.send({
    name: 'csv/rubric.uploaded',
    data: { uploadedFileId: uploadedFile.id, storageKey },
  });

  return NextResponse.json({ batchId: batch.id, uploadedFileId: uploadedFile.id });
}

export const runtime = 'nodejs';
export const maxDuration = 30;

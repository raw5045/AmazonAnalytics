import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles } from '@/db/schema';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { id } = await params;
  const files = await db.query.uploadedFiles.findMany({ where: eq(uploadedFiles.batchId, id) });
  const passed = files.filter((f) => f.validationStatus === 'pass').length;
  const warned = files.filter((f) => f.validationStatus === 'pass_with_warnings').length;
  const failed = files.filter((f) => f.validationStatus === 'fail' || f.validationStatus === 'import_failed').length;
  const total = files.length;

  const failedPct = total === 0 ? 0 : (failed / total) * 100;
  let status: 'clean' | 'partial_review' | 'blocked' = 'clean';
  if (failed > 0) {
    status = failedPct >= 10 ? 'blocked' : 'partial_review';
  }

  await db
    .update(uploadBatches)
    .set({
      status,
      passedFiles: passed,
      warningFiles: warned,
      failedFiles: failed,
    })
    .where(eq(uploadBatches.id, id));

  return NextResponse.json({ ok: true, status });
}

export const runtime = 'nodejs';

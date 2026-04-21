import { NextResponse } from 'next/server';
import { eq, asc } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadedFiles, ingestionErrors } from '@/db/schema';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { fileId } = await params;
  const file = await db.query.uploadedFiles.findFirst({ where: eq(uploadedFiles.id, fileId) });
  if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const errors = await db.query.ingestionErrors.findMany({
    where: eq(ingestionErrors.uploadedFileId, fileId),
    orderBy: [asc(ingestionErrors.rowNumber)],
    limit: 500,
  });

  return NextResponse.json({ file, errors });
}

export const runtime = 'nodejs';

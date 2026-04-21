import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadedFiles } from '@/db/schema';
import { inngest } from '@/inngest/client';

export async function POST(
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

  await inngest.send({
    name: 'csv/file.validate',
    data: { uploadedFileId: fileId },
  });

  return NextResponse.json({ ok: true });
}

export const runtime = 'nodejs';

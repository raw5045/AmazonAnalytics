import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadedFiles } from '@/db/schema';
import { inngest } from '@/inngest/client';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { id: newFileId } = await params;
  const body = (await req.json().catch(() => ({}))) as { replacesFileId?: string };
  if (!body.replacesFileId) {
    return NextResponse.json({ error: 'replacesFileId is required' }, { status: 400 });
  }

  await db
    .update(uploadedFiles)
    .set({ isReplacement: true, replacesFileId: body.replacesFileId })
    .where(eq(uploadedFiles.id, newFileId));

  await db
    .update(uploadedFiles)
    .set({ replacedAt: new Date() })
    .where(eq(uploadedFiles.id, body.replacesFileId));

  // Re-validate the replacement file so WEEK_ALREADY_LOADED error goes away
  await inngest.send({ name: 'csv/file.validate', data: { uploadedFileId: newFileId } });

  return NextResponse.json({ ok: true });
}

export const runtime = 'nodejs';

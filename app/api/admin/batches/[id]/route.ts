import { NextResponse } from 'next/server';
import { eq, asc } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles } from '@/db/schema';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const { id } = await params;
  const batch = await db.query.uploadBatches.findFirst({ where: eq(uploadBatches.id, id) });
  if (!batch) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const files = await db.query.uploadedFiles.findMany({
    where: eq(uploadedFiles.batchId, id),
    orderBy: [asc(uploadedFiles.weekEndDate), asc(uploadedFiles.createdAt)],
  });

  return NextResponse.json({ batch, files });
}

export const runtime = 'nodejs';

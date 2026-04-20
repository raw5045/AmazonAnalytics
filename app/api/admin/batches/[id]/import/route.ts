import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadBatches } from '@/db/schema';
import { inngest } from '@/inngest/client';

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
  const batch = await db.query.uploadBatches.findFirst({ where: eq(uploadBatches.id, id) });
  if (!batch) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await inngest.send({ name: 'csv/batch.import-approved', data: { batchId: id } });
  return NextResponse.json({ ok: true });
}

export const runtime = 'nodejs';

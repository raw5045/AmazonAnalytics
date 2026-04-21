import { NextResponse } from 'next/server';
import { desc } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadBatches } from '@/db/schema';

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

  const body = (await req.json().catch(() => ({}))) as { batchType?: 'single_csv' | 'zip_backfill' };
  const batchType = body.batchType === 'zip_backfill' ? 'zip_backfill' : 'single_csv';

  const [batch] = await db
    .insert(uploadBatches)
    .values({
      batchType,
      status: 'uploaded',
      totalFiles: 0,
      createdByUserId: user.id,
    })
    .returning();

  return NextResponse.json({ batchId: batch.id });
}

export async function GET(_req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const batches = await db.query.uploadBatches.findMany({
    orderBy: [desc(uploadBatches.createdAt)],
    limit: 100,
  });

  return NextResponse.json({ batches });
}

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { eq, and, ne } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { schemaVersions, auditLog, uploadedFiles } from '@/db/schema';
import { inngest } from '@/inngest/client';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAdmin();
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
  const body = (await req.json().catch(() => ({}))) as { fileId?: string };
  if (!body.fileId) {
    return NextResponse.json({ error: 'fileId is required' }, { status: 400 });
  }

  const version = await db.query.schemaVersions.findFirst({
    where: eq(schemaVersions.id, id),
  });
  if (!version) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (version.status !== 'draft') {
    return NextResponse.json({ error: 'schema is not in draft state' }, { status: 400 });
  }

  // Retire any currently active version
  await db
    .update(schemaVersions)
    .set({ status: 'retired' })
    .where(and(eq(schemaVersions.status, 'active'), ne(schemaVersions.id, id)));

  // Activate this one
  await db
    .update(schemaVersions)
    .set({ status: 'active', approvedByUserId: user.id, approvedAt: new Date() })
    .where(eq(schemaVersions.id, id));

  // Audit log
  await db.insert(auditLog).values({
    userId: user.id,
    action: 'schema_version.approved',
    entityType: 'schema_versions',
    entityId: id,
  });

  // Re-queue the rubric file for full import through the single-file pipeline
  const file = await db.query.uploadedFiles.findFirst({
    where: eq(uploadedFiles.id, body.fileId),
  });
  if (file) {
    await inngest.send({
      name: 'csv/single.uploaded',
      data: { uploadedFileId: file.id, storageKey: file.storageKey, schemaVersionId: id },
    });
  }

  return NextResponse.json({ ok: true });
}

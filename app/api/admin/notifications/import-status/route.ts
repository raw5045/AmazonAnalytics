/**
 * GET /api/admin/notifications/import-status
 *
 * Powers the header chip in the admin layout. Returns:
 *   - `active`: imports currently mid-flight (not at a terminal phase yet)
 *   - `recent`: imports that reached a terminal phase in the last 24 h
 *
 * The client picks the most relevant entry to show (active first, then
 * the most recent terminal entry) and dismisses entries via localStorage
 * — the server never sees dismissals, so an admin who refreshes a page
 * after dismissing will still see their dismissals stick.
 *
 * Recency window of 24 h is generous on purpose: per spec V1, the
 * banner sticks until the user dismisses it manually. The 24h cap
 * prevents the chip from showing imports from a week ago if the user
 * never opens the admin UI in between.
 */
import { NextResponse } from 'next/server';
import { and, eq, gt, isNotNull, or, sql } from 'drizzle-orm';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { uploadedFiles } from '@/db/schema';

export async function GET() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.code }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  // Active = the worker is currently processing it (heartbeat fresh, not
  // at a terminal phase).
  const active = await db
    .select({
      fileId: uploadedFiles.id,
      batchId: uploadedFiles.batchId,
      filename: uploadedFiles.originalFilename,
      phase: uploadedFiles.importPhase,
      startedAt: uploadedFiles.importStartedAt,
      heartbeatAt: uploadedFiles.importHeartbeatAt,
    })
    .from(uploadedFiles)
    .where(
      and(
        isNotNull(uploadedFiles.importStartedAt),
        // Worker is alive: heartbeat within last 5 min
        gt(uploadedFiles.importHeartbeatAt, sql`NOW() - INTERVAL '5 minutes'`),
        // Not at a terminal phase
        sql`${uploadedFiles.importPhase} IS NOT NULL AND ${uploadedFiles.importPhase} NOT IN ('completed', 'completed_with_refresh_failure')`,
        // Not already in a terminal validation_status
        sql`${uploadedFiles.validationStatus} != 'import_failed'`,
      ),
    )
    .orderBy(sql`${uploadedFiles.importStartedAt} DESC`)
    .limit(10);

  // Recent = terminal phase reached in the last 24 hours. Includes both
  // success and failure outcomes; the client decides how to render each.
  // We use import_heartbeat_at as a proxy for "when did this finish?" —
  // the worker stops heartbeating right at the end of processFileImport,
  // so the last heartbeat is within minutes of the actual completion.
  const recent = await db
    .select({
      fileId: uploadedFiles.id,
      batchId: uploadedFiles.batchId,
      filename: uploadedFiles.originalFilename,
      phase: uploadedFiles.importPhase,
      validationStatus: uploadedFiles.validationStatus,
      startedAt: uploadedFiles.importStartedAt,
      heartbeatAt: uploadedFiles.importHeartbeatAt,
    })
    .from(uploadedFiles)
    .where(
      and(
        gt(uploadedFiles.importHeartbeatAt, sql`NOW() - INTERVAL '24 hours'`),
        or(
          eq(uploadedFiles.importPhase, 'completed'),
          eq(uploadedFiles.importPhase, 'completed_with_refresh_failure'),
          eq(uploadedFiles.validationStatus, 'import_failed'),
        ),
      ),
    )
    .orderBy(sql`${uploadedFiles.importHeartbeatAt} DESC`)
    .limit(10);

  return NextResponse.json({
    active: active.map((a) => ({
      fileId: a.fileId,
      batchId: a.batchId,
      filename: a.filename,
      phase: a.phase,
      startedAt: a.startedAt,
      heartbeatAt: a.heartbeatAt,
    })),
    recent: recent.map((r) => ({
      fileId: r.fileId,
      batchId: r.batchId,
      filename: r.filename,
      outcome: classifyOutcome(r.phase, r.validationStatus),
      completedAt: r.heartbeatAt,
      durationMs:
        r.startedAt && r.heartbeatAt
          ? new Date(r.heartbeatAt).getTime() - new Date(r.startedAt).getTime()
          : null,
    })),
  });
}

function classifyOutcome(
  phase: string | null,
  validationStatus: string | null,
): 'completed' | 'completed_with_refresh_failure' | 'failed' {
  if (validationStatus === 'import_failed') return 'failed';
  if (phase === 'completed_with_refresh_failure') return 'completed_with_refresh_failure';
  return 'completed';
}

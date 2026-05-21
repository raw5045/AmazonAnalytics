/**
 * Generate two presigned R2 upload URLs (one for BA, one for POE) for
 * a combined calibration upload. Browser uploads both files directly
 * to R2 in parallel via the returned URLs.
 *
 * Request:  { baFilename, poeFilename, monthEndDate }
 * Response: { jobKey, ba: {storageKey, uploadUrl}, poe: {storageKey, uploadUrl} }
 */
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { getPresignedUploadUrl } from '@/lib/storage/r2';
import { randomUUID } from 'node:crypto';

interface PresignRequest {
  baFilename: string;
  poeFilename: string;
  monthEndDate: string;
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json(
        { error: e.message },
        { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 },
      );
    }
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as Partial<PresignRequest>;
  if (!body.baFilename || !body.poeFilename) {
    return NextResponse.json(
      { error: 'baFilename and poeFilename are required' },
      { status: 400 },
    );
  }
  if (!body.monthEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.monthEndDate)) {
    return NextResponse.json(
      { error: 'monthEndDate is required (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  // One jobKey for the pair so process + completion routes can
  // correlate the two uploads as a single calibration run.
  const jobKey = randomUUID();

  const baSafe = body.baFilename.split(/[\\/]/).pop()!.replace(/[^a-zA-Z0-9._-]/g, '_');
  const poeSafe = body.poeFilename.split(/[\\/]/).pop()!.replace(/[^a-zA-Z0-9._-]/g, '_');
  const baStorageKey = `calibration/${body.monthEndDate}/${jobKey}/ba_${baSafe}`;
  const poeStorageKey = `calibration/${body.monthEndDate}/${jobKey}/poe_${poeSafe}`;

  const [baUploadUrl, poeUploadUrl] = await Promise.all([
    getPresignedUploadUrl(baStorageKey, 'text/csv', 3600),
    getPresignedUploadUrl(poeStorageKey, 'text/csv', 3600),
  ]);

  return NextResponse.json({
    jobKey,
    ba: { storageKey: baStorageKey, uploadUrl: baUploadUrl },
    poe: { storageKey: poeStorageKey, uploadUrl: poeUploadUrl },
  });
}

export const runtime = 'nodejs';

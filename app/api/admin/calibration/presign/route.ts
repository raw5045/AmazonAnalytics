/**
 * Generate presigned R2 upload URLs for a combined calibration upload:
 * one for BA (always), plus one each for POE and/or SQP when provided.
 * Browser uploads the files directly to R2 in parallel via the
 * returned URLs.
 *
 * BA is required; POE and SQP are each optional but at least one of
 * them must be present (POE stores validation data, SQP trains the
 * fit — spec 2026-07-16).
 *
 * Request:  { baFilename, poeFilename?, sqpFilename?, monthEndDate }
 * Response: { jobKey, ba: {storageKey, uploadUrl},
 *             poe: {storageKey, uploadUrl} | null,
 *             sqp: {storageKey, uploadUrl} | null }
 */
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { getPresignedUploadUrl } from '@/lib/storage/r2';
import { randomUUID } from 'node:crypto';

interface PresignRequest {
  baFilename: string;
  poeFilename?: string | null;
  sqpFilename?: string | null;
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
  if (!body.baFilename) {
    return NextResponse.json({ error: 'baFilename is required' }, { status: 400 });
  }
  if (!body.poeFilename && !body.sqpFilename) {
    return NextResponse.json(
      { error: 'At least one of poeFilename / sqpFilename is required' },
      { status: 400 },
    );
  }
  if (!body.monthEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.monthEndDate)) {
    return NextResponse.json(
      { error: 'monthEndDate is required (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  // One jobKey for the set so process + completion routes can
  // correlate the uploads as a single calibration run.
  const jobKey = randomUUID();

  const presignOptional = async (
    prefix: 'poe' | 'sqp',
    filename: string | null | undefined,
  ): Promise<{ storageKey: string; uploadUrl: string } | null> => {
    if (!filename) return null;
    const safe = filename.split(/[\\/]/).pop()!.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `calibration/${body.monthEndDate}/${jobKey}/${prefix}_${safe}`;
    return { storageKey, uploadUrl: await getPresignedUploadUrl(storageKey, 'text/csv', 3600) };
  };

  const baSafe = body.baFilename.split(/[\\/]/).pop()!.replace(/[^a-zA-Z0-9._-]/g, '_');
  const baStorageKey = `calibration/${body.monthEndDate}/${jobKey}/ba_${baSafe}`;

  const [baUploadUrl, poe, sqp] = await Promise.all([
    getPresignedUploadUrl(baStorageKey, 'text/csv', 3600),
    presignOptional('poe', body.poeFilename),
    presignOptional('sqp', body.sqpFilename),
  ]);

  return NextResponse.json({
    jobKey,
    ba: { storageKey: baStorageKey, uploadUrl: baUploadUrl },
    poe,
    sqp,
  });
}

export const runtime = 'nodejs';

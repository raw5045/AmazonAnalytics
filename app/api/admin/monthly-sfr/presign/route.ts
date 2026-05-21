/**
 * Generate a presigned R2 upload URL for a monthly BA SFR CSV.
 *
 * The browser uploads the file directly to R2 using the returned URL —
 * the file never flows through this server, so Vercel's body-size
 * limits don't apply. Mirrors the pattern in
 * /api/admin/batches/[id]/presign.
 *
 * Request:  { filename: string, monthEndDate: 'YYYY-MM-DD' }
 * Response: { storageKey: string, uploadUrl: string }
 */
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { getPresignedUploadUrl } from '@/lib/storage/r2';
import { randomUUID } from 'node:crypto';

interface PresignRequest {
  filename: string;
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
  if (!body.filename || typeof body.filename !== 'string') {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 });
  }
  if (!body.monthEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.monthEndDate)) {
    return NextResponse.json(
      { error: 'monthEndDate is required (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  // Build the storage key under a dedicated prefix so monthly uploads
  // are easy to distinguish from weekly batch uploads.
  const id = randomUUID();
  const safeName = body.filename.split(/[\\/]/).pop()!.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storageKey = `monthly-sfr/${body.monthEndDate}/${id}/${safeName}`;
  const uploadUrl = await getPresignedUploadUrl(storageKey, 'text/csv', 3600);

  return NextResponse.json({ storageKey, uploadUrl });
}

export const runtime = 'nodejs';

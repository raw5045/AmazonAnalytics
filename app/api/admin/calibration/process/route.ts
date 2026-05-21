/**
 * Trigger background processing of an uploaded calibration pair
 * (BA + POE). Called by the UI after the browser has finished
 * PUTting both files to R2.
 *
 * Request:  { jobKey, baStorageKey, poeStorageKey, baFilename, poeFilename, monthEndDate }
 * Response: { ok: true, eventId: string }
 */
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { inngest } from '@/inngest/client';

interface ProcessRequest {
  jobKey: string;
  baStorageKey: string;
  poeStorageKey: string;
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

  const body = (await req.json().catch(() => ({}))) as Partial<ProcessRequest>;
  const required: (keyof ProcessRequest)[] = [
    'jobKey',
    'baStorageKey',
    'poeStorageKey',
    'baFilename',
    'poeFilename',
    'monthEndDate',
  ];
  for (const key of required) {
    if (!body[key]) {
      return NextResponse.json({ error: `${key} is required` }, { status: 400 });
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.monthEndDate!)) {
    return NextResponse.json({ error: 'monthEndDate must be YYYY-MM-DD' }, { status: 400 });
  }
  if (!body.baStorageKey!.startsWith('calibration/') || !body.poeStorageKey!.startsWith('calibration/')) {
    return NextResponse.json(
      { error: 'Storage keys must be under the calibration/ prefix' },
      { status: 400 },
    );
  }

  const result = await inngest.send({
    name: 'calibration/uploaded',
    data: {
      jobKey: body.jobKey,
      baStorageKey: body.baStorageKey,
      poeStorageKey: body.poeStorageKey,
      baFilename: body.baFilename,
      poeFilename: body.poeFilename,
      monthEndDate: body.monthEndDate,
    },
  });

  return NextResponse.json({ ok: true, eventId: result.ids?.[0] ?? null });
}

export const runtime = 'nodejs';

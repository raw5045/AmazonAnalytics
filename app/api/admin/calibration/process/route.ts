/**
 * Trigger background processing of an uploaded calibration set
 * (BA + POE and/or SQP). Called by the UI after the browser has
 * finished PUTting the files to R2.
 *
 * BA is required; POE and SQP are each optional but at least one of
 * them must be present (POE stores validation data, SQP trains the
 * fit — spec 2026-07-16).
 *
 * Request:  { jobKey, baStorageKey, baFilename, monthEndDate,
 *             poeStorageKey?, poeFilename?, sqpStorageKey?, sqpFilename? }
 * Response: { ok: true, eventId: string }
 */
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { inngest } from '@/inngest/client';

interface ProcessRequest {
  jobKey: string;
  baStorageKey: string;
  poeStorageKey?: string | null;
  sqpStorageKey?: string | null;
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

  const body = (await req.json().catch(() => ({}))) as Partial<ProcessRequest>;
  const required: (keyof ProcessRequest)[] = [
    'jobKey',
    'baStorageKey',
    'baFilename',
    'monthEndDate',
  ];
  for (const key of required) {
    if (!body[key]) {
      return NextResponse.json({ error: `${key} is required` }, { status: 400 });
    }
  }
  // POE and SQP travel as (storageKey, filename) pairs — both or neither.
  if (!!body.poeStorageKey !== !!body.poeFilename) {
    return NextResponse.json(
      { error: 'poeStorageKey and poeFilename must be provided together' },
      { status: 400 },
    );
  }
  if (!!body.sqpStorageKey !== !!body.sqpFilename) {
    return NextResponse.json(
      { error: 'sqpStorageKey and sqpFilename must be provided together' },
      { status: 400 },
    );
  }
  if (!body.poeStorageKey && !body.sqpStorageKey) {
    return NextResponse.json(
      { error: 'At least one of the POE / SQP files is required' },
      { status: 400 },
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.monthEndDate!)) {
    return NextResponse.json({ error: 'monthEndDate must be YYYY-MM-DD' }, { status: 400 });
  }
  const storageKeys = [body.baStorageKey!, body.poeStorageKey, body.sqpStorageKey].filter(
    (k): k is string => !!k,
  );
  if (storageKeys.some((k) => !k.startsWith('calibration/'))) {
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
      poeStorageKey: body.poeStorageKey ?? null,
      sqpStorageKey: body.sqpStorageKey ?? null,
      baFilename: body.baFilename,
      poeFilename: body.poeFilename ?? null,
      sqpFilename: body.sqpFilename ?? null,
      monthEndDate: body.monthEndDate,
    },
  });

  return NextResponse.json({ ok: true, eventId: result.ids?.[0] ?? null });
}

export const runtime = 'nodejs';

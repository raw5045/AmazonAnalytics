/**
 * Trigger background processing of an already-uploaded monthly BA CSV.
 *
 * Called by the upload UI after the browser has finished PUTting the
 * file to R2 via the presigned URL. Fires an Inngest event that the
 * worker picks up and processes via the detached job pattern (see
 * worker/monthlySfrJobs.ts).
 *
 * Request:  { storageKey: string, monthEndDate: 'YYYY-MM-DD', filename: string }
 * Response: { ok: true, eventId: string }
 */
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { inngest } from '@/inngest/client';

interface ProcessRequest {
  storageKey: string;
  monthEndDate: string;
  filename: string;
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
  if (!body.storageKey || !body.monthEndDate || !body.filename) {
    return NextResponse.json(
      { error: 'storageKey, monthEndDate, and filename are required' },
      { status: 400 },
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.monthEndDate)) {
    return NextResponse.json({ error: 'monthEndDate must be YYYY-MM-DD' }, { status: 400 });
  }
  if (!body.storageKey.startsWith('monthly-sfr/')) {
    // Defense in depth — only let presigned monthly uploads be processed.
    // Prevents an attacker from triggering ingest of an arbitrary R2 key.
    return NextResponse.json(
      { error: 'storageKey must be under the monthly-sfr/ prefix' },
      { status: 400 },
    );
  }

  const result = await inngest.send({
    name: 'monthly-sfr/uploaded',
    data: {
      storageKey: body.storageKey,
      monthEndDate: body.monthEndDate,
      filename: body.filename,
    },
  });

  return NextResponse.json({ ok: true, eventId: result.ids?.[0] ?? null });
}

export const runtime = 'nodejs';

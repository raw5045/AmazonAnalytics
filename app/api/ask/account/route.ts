/**
 * PATCH /api/ask/account — the member's two write toggles (spec 2026-10-01 §8). Order: kill
 * switches (Ask AI, then writes) → same-origin → session → body (size, JSON, shape: before any DB
 * call, like the DELETE route's uuid check) → eligibility → update. `cache-control: no-store` on
 * every response, bodyless ones included.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/AuthError';
import { askAiEnabled, askAiWritesEnabled } from '@/lib/ask/config';
import { askAiEligible } from '@/lib/ask/eligibility';
import { getAccount, setAutoApprove } from '@/lib/ask/ledger';
import { isSameOrigin } from '@/lib/ask/sameOrigin';
import { BAD_REQUEST_MESSAGE, CROSS_SITE_MESSAGE, TOO_LARGE_MESSAGE } from '@/lib/ask/messages';

export const runtime = 'nodejs';
/** The body is two booleans (under 60 bytes as JSON); 1 KiB is ample headroom. */
const MAX_BODY_BYTES = 1024;
const bodySchema = z
  .strictObject({ autoApproveChanges: z.boolean().optional(), autoApproveDeletes: z.boolean().optional() })
  .refine((b) => b.autoApproveChanges !== undefined || b.autoApproveDeletes !== undefined, { message: 'nothing to update' });

const NO_STORE = { 'cache-control': 'no-store' };
function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}
/** Bodyless, as on the other Ask AI routes: never a hint whether the feature or the account is what is missing. */
const notFoundResponse = (): NextResponse => new NextResponse(null, { status: 404, headers: NO_STORE });
const badRequest = (): NextResponse => json({ error: BAD_REQUEST_MESSAGE, code: 'bad_request' }, 400);

export async function PATCH(req: Request) {
  if (!askAiEnabled() || !askAiWritesEnabled()) return notFoundResponse();
  if (!isSameOrigin(req)) return json({ error: CROSS_SITE_MESSAGE }, 403);
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.code === 'UNAUTHENTICATED' ? 401 : 403);
    throw e;
  }
  // As on the chat route: content-length is only a hint that lets an obviously oversized request
  // skip buffering; the byte count of the real text is authoritative.
  const contentLength = req.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) return json({ error: TOO_LARGE_MESSAGE }, 413);
  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return json({ error: TOO_LARGE_MESSAGE }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return badRequest();
  }
  const body = bodySchema.safeParse(parsed);
  if (!body.success) return badRequest();
  if (!askAiEligible(user.role, await getAccount(user.id))) return notFoundResponse();
  // A field not sent reaches the ledger as undefined, which leaves that toggle as is.
  const updated = await setAutoApprove(user.id, { changes: body.data.autoApproveChanges, deletes: body.data.autoApproveDeletes });
  // No row to update: an admin before their first chat turn (gates.ts creates the row then), or a
  // row gone since the eligibility read.
  if (!updated) return notFoundResponse();
  return json({ autoApproveChanges: updated.autoApproveChanges, autoApproveDeletes: updated.autoApproveDeletes }, 200);
}

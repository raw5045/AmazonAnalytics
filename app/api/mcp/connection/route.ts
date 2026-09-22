/**
 * GET  /api/mcp/connection → this account's MCP connection status (Connect AI page)
 * POST /api/mcp/connection { action: 'disconnect' | 'reconnect' } → app-level disconnect record (amendment §3.4)
 * Session-authenticated, same-origin only, visible only to accounts the MCP audience admits.
 */
import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/AuthError';
import { mcpAudience, mcpEnabled } from '@/lib/mcp/config';
import { connectAiEligible } from '@/lib/mcp/eligibility';
import { getMcpConnection, setMcpConnectionStatus } from '@/lib/mcp/connections';
import type { User } from '@/db/schema';

export const runtime = 'nodejs';

async function eligibleUser(): Promise<User | null> {
  const user = await requireAuthenticatedUser();
  return connectAiEligible(user.role, mcpAudience()) ? user : null;
}

function authFailure(e: unknown): NextResponse {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
  throw e;
}

export async function GET() {
  // M-5 (Task 15 re-review): same kill switch as /api/mcp itself (app/api/mcp/route.ts) —
  // dark before touching auth or the DB, so flipping MCP_ENABLED off also dark-mode's the
  // Connect AI page's own status/disconnect API, not just the protocol endpoint.
  if (!mcpEnabled()) return new NextResponse(null, { status: 404 });
  let user: User | null;
  try {
    user = await eligibleUser();
  } catch (e) {
    return authFailure(e);
  }
  if (!user) return new NextResponse(null, { status: 404 });
  const c = await getMcpConnection(user.id);
  return NextResponse.json(
    { status: c?.status ?? 'enabled', connectedOnce: c !== null, lastRequestAt: c?.lastRequestAt?.toISOString() ?? null, lastClientId: c?.lastClientId ?? null },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(req: Request) {
  // M-5: see the GET handler's comment above — same kill switch, checked first.
  if (!mcpEnabled()) return new NextResponse(null, { status: 404 });
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json({ error: 'Cross-site requests are not allowed.' }, { status: 403 });
  }
  let user: User | null;
  try {
    user = await eligibleUser();
  } catch (e) {
    return authFailure(e);
  }
  if (!user) return new NextResponse(null, { status: 404 });
  // A missing/invalid Content-Type, an empty body, or a body that is valid
  // JSON but not an object (e.g. `null`, `"x"`, `42`) must all 400 rather
  // than throw — req.json() rejects on unparsable JSON (caught below), but
  // resolves to non-object values like `null` without rejecting.
  const parsed = await req.json().catch(() => null);
  const action = parsed && typeof parsed === 'object' ? (parsed as { action?: unknown }).action : undefined;
  if (action !== 'disconnect' && action !== 'reconnect') {
    return NextResponse.json({ error: 'action must be disconnect or reconnect' }, { status: 400 });
  }
  const c = await setMcpConnectionStatus(user.id, action === 'disconnect' ? 'disconnected' : 'enabled');
  return NextResponse.json({ status: c.status }, { headers: { 'cache-control': 'no-store' } });
}

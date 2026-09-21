/**
 * GET  /api/mcp/connection → this account's MCP connection status (Connect AI page)
 * POST /api/mcp/connection { action: 'disconnect' | 'reconnect' } → app-level disconnect record (amendment §3.4)
 * Session-authenticated, same-origin only, visible only to accounts the MCP audience admits.
 */
import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/AuthError';
import { mcpAudience } from '@/lib/mcp/config';
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
  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  if (body.action !== 'disconnect' && body.action !== 'reconnect') {
    return NextResponse.json({ error: 'action must be disconnect or reconnect' }, { status: 400 });
  }
  const c = await setMcpConnectionStatus(user.id, body.action === 'disconnect' ? 'disconnected' : 'enabled');
  return NextResponse.json({ status: c.status }, { headers: { 'cache-control': 'no-store' } });
}

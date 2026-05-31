/**
 * POST /api/watchlist/items/bulk
 *
 * Accepts a list of keyword strings, matches them against the
 * search_terms catalog by normalized form, and adds matched
 * keywords to the current user's watchlist in one shot.
 *
 * See docs/superpowers/specs/2026-05-29-watchlist-bulk-add-design.md
 * for the full contract.
 */
import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import {
  bulkAddToWatchlist,
  BulkAddInputError,
} from '@/lib/watchlist/bulkAdd';
import { HARD_MAX_INPUT } from '@/lib/watchlist/validation';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    return handleAuthError(e);
  }

  // Parse + validate body shape.
  const body = (await req.json().catch(() => ({}))) as { keywords?: unknown };
  if (!Array.isArray(body.keywords)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const keywords = body.keywords;
  if (keywords.length > HARD_MAX_INPUT) {
    return NextResponse.json({ error: 'too_many_keywords' }, { status: 400 });
  }
  if (!keywords.every((k) => typeof k === 'string')) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  try {
    const result = await bulkAddToWatchlist(user.id, keywords as string[]);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof BulkAddInputError) {
      return NextResponse.json({ error: e.code }, { status: 400 });
    }
    // Let Next render a 500; surfaces in Vercel logs.
    throw e;
  }
}

function handleAuthError(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json(
      { error: e.message },
      { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 },
    );
  }
  throw e;
}

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
vi.mock('@/db/client', () => ({ db: { execute: vi.fn() } }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
const auth = vi.hoisted(() => ({ state: 'admin' as 'admin' | 'unauthenticated' | 'forbidden' }));
vi.mock('@/lib/auth/requireAdmin', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/auth/requireAdmin')>();
  return {
    ...mod,
    requireAdmin: async () => {
      if (auth.state === 'unauthenticated') throw new mod.AuthError('UNAUTHENTICATED', 'Not signed in');
      if (auth.state === 'forbidden') throw new mod.AuthError('FORBIDDEN', 'Admin only');
      return { id: 'a1', role: 'admin' };
    },
  };
});
const data = vi.hoisted(() => ({ loadWatchlistRowsByUser: vi.fn(), getCurrentDigestWeek: vi.fn() }));
vi.mock('@/lib/notifications/digest/loadDigestData', () => data);
// The token signer reads DIGEST_UNSUB_SECRET from process.env and warns when unset; not under test.
vi.mock('@/lib/notifications/digest/unsubToken', () => ({ signUnsubToken: () => 'preview-token' }));
import DigestPreviewPage from './page';

const props = (variant?: string) => ({ searchParams: Promise.resolve(variant ? { variant } : {}) });

describe('DigestPreviewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.state = 'admin';
    data.getCurrentDigestWeek.mockResolvedValue('2026-09-25');
    data.loadWatchlistRowsByUser.mockResolvedValue(new Map());
  });

  it('redirects a non-admin before any data read — the page checks requireAdmin() itself, not only the layout', async () => {
    auth.state = 'unauthenticated';
    await expect(DigestPreviewPage(props())).rejects.toThrow('redirect:/sign-in');
    expect(data.getCurrentDigestWeek).not.toHaveBeenCalled();
    expect(data.loadWatchlistRowsByUser).not.toHaveBeenCalled();
    auth.state = 'forbidden';
    await expect(DigestPreviewPage(props())).rejects.toThrow('redirect:/explorer');
    expect(data.getCurrentDigestWeek).not.toHaveBeenCalled();
    expect(data.loadWatchlistRowsByUser).not.toHaveBeenCalled();
  });

  it('renders the broadcast variant for an admin without reading any watchlist', async () => {
    render(await DigestPreviewPage(props('broadcast')));
    expect(screen.getByText(/^Preview — variant:/)).toHaveTextContent('variant: broadcast, week: 2026-09-25');
    expect(data.loadWatchlistRowsByUser).not.toHaveBeenCalled();
  });

  it('renders the watchlist variant from the gated admin user (the same user the gate resolved)', async () => {
    render(await DigestPreviewPage(props()));
    expect(screen.getByText(/^Preview — variant:/)).toHaveTextContent('variant: watchlist, week: 2026-09-25');
    expect(data.loadWatchlistRowsByUser).toHaveBeenCalledWith(['a1']);
  });
});

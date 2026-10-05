import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
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
// The page reads Neon directly through db.select(); both of its chains resolve empty here.
const dbm = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { select: dbm.select } }));
const overviewMock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/admin/keepaServiceOverview', () => ({ loadKeepaServiceOverview: overviewMock.load }));
import KeepaEnrichmentAdminPage from './page';

describe('KeepaEnrichmentAdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.state = 'admin';
    dbm.select.mockReturnValue({ from: () => ({ limit: async () => [], orderBy: () => ({ limit: async () => [] }) }) });
    overviewMock.load.mockResolvedValue({ status: null, counts: { tier1InScope: 0, tier1NeverFetched: 0, tier1Due: 0, tier1Stale: 0, tier1Erroring: 0, tier2InScope: 0, tier2NeverFetched: 0, tier2Due: 0, fetchedLast24h: 0, fetchedLast7d: 0, oldestTier1FetchedAt: null, claimed: 0, scopeWeek: null, kcsWeek: null } });
  });

  it('redirects a non-admin before any data read — the page checks requireAdmin() itself, not only the layout', async () => {
    auth.state = 'unauthenticated';
    await expect(KeepaEnrichmentAdminPage()).rejects.toThrow('redirect:/sign-in');
    expect(dbm.select).not.toHaveBeenCalled();
    expect(overviewMock.load).not.toHaveBeenCalled();
    auth.state = 'forbidden';
    await expect(KeepaEnrichmentAdminPage()).rejects.toThrow('redirect:/explorer');
    expect(dbm.select).not.toHaveBeenCalled();
    expect(overviewMock.load).not.toHaveBeenCalled();
  });

  it('renders the enrichment controls and recent runs for an admin', async () => {
    render(await KeepaEnrichmentAdminPage());
    expect(screen.getByRole('heading', { name: 'Keepa enrichment' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Keepa service' })).toBeInTheDocument();
    expect(screen.getByText('No runs yet.')).toBeInTheDocument();
    expect(dbm.select).toHaveBeenCalledTimes(2);
    expect(overviewMock.load).toHaveBeenCalledWith(null);
  });

  it('reads the explorer week once and hands it to the overview loader', async () => {
    dbm.select.mockReturnValue({ from: () => ({ limit: async () => [{ currentWeekEndDate: '2026-10-03' }], orderBy: () => ({ limit: async () => [] }) }) });
    render(await KeepaEnrichmentAdminPage());
    expect(overviewMock.load).toHaveBeenCalledWith('2026-10-03');
    expect(dbm.select).toHaveBeenCalledTimes(2);
  });

  it('degrades the status card to one line when the overview loader fails, and keeps the rest of the page', async () => {
    overviewMock.load.mockRejectedValue(Object.assign(new Error('relation "asin_products" does not exist'), { code: '42P01' }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(await KeepaEnrichmentAdminPage());
    expect(screen.getByText('Service status unavailable (42P01)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Manual full refresh' })).toBeInTheDocument();
    expect(screen.getByText('No runs yet.')).toBeInTheDocument();
    expect(logged).toHaveBeenCalledWith('[keepa-admin] overview failed', JSON.stringify({ error: 'Error', code: '42P01' }));
    expect(JSON.stringify(logged.mock.calls)).not.toContain('does not exist'); // coded fields only, never the message
    logged.mockRestore();
  });
});

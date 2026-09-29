import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
vi.mock('@/db/client', () => ({ db: { execute: vi.fn() } }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); }, useRouter: () => ({ refresh: vi.fn() }) }));
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
const loader = vi.hoisted(() => ({ loadAbuseDigestData: vi.fn() }));
vi.mock('@/lib/notifications/abuseDigest/loadAbuseDigestData', () => loader);
// The flag evaluator and email builder are pure but want a full stats fixture; the gate and the
// day → loader wiring are what this test covers, so both are stubbed.
vi.mock('@/lib/notifications/abuseDigest/evaluateFlags', () => ({ evaluateFlags: () => [] }));
vi.mock('@/lib/notifications/abuseDigest/buildAbuseDigestEmail', () => ({
  buildAbuseDigestEmail: () => ({ subject: 'Abuse digest 2026-09-20', html: '<p>digest preview body</p>' }),
}));
import AbuseDigestPreviewPage from './page';

const props = (day: string) => ({ searchParams: Promise.resolve({ day }) });

describe('AbuseDigestPreviewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.state = 'admin';
    loader.loadAbuseDigestData.mockResolvedValue({});
  });

  it('redirects a non-admin before any data read — the page checks requireAdmin() itself, not only the layout', async () => {
    auth.state = 'unauthenticated';
    await expect(AbuseDigestPreviewPage(props('2026-09-20'))).rejects.toThrow('redirect:/sign-in');
    expect(loader.loadAbuseDigestData).not.toHaveBeenCalled();
    auth.state = 'forbidden';
    await expect(AbuseDigestPreviewPage(props('2026-09-20'))).rejects.toThrow('redirect:/explorer');
    expect(loader.loadAbuseDigestData).not.toHaveBeenCalled();
  });

  it('renders the preview for the requested day for an admin', async () => {
    render(await AbuseDigestPreviewPage(props('2026-09-20')));
    expect(screen.getByRole('heading', { name: 'Abuse digest' })).toBeInTheDocument();
    expect(loader.loadAbuseDigestData).toHaveBeenCalledWith('2026-09-20');
    expect(screen.getByText('digest preview body')).toBeInTheDocument();
  });
});

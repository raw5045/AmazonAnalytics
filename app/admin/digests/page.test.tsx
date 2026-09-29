import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
vi.mock('@/db/client', () => ({ db: { execute: vi.fn() } }));
// redirect for the page's own gate; useRouter for the SendDigestButton client component.
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
const data = vi.hoisted(() => ({ loadDigestWeeks: vi.fn(), countSubscribedRecipients: vi.fn() }));
vi.mock('@/lib/notifications/digest/loadDigestData', () => data);
import AdminDigestsPage from './page';

describe('AdminDigestsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.state = 'admin';
    data.loadDigestWeeks.mockResolvedValue([]);
    data.countSubscribedRecipients.mockResolvedValue(0);
  });

  it('redirects a non-admin before any data read — the page checks requireAdmin() itself, not only the layout', async () => {
    auth.state = 'unauthenticated';
    await expect(AdminDigestsPage()).rejects.toThrow('redirect:/sign-in');
    expect(data.loadDigestWeeks).not.toHaveBeenCalled();
    expect(data.countSubscribedRecipients).not.toHaveBeenCalled();
    auth.state = 'forbidden';
    await expect(AdminDigestsPage()).rejects.toThrow('redirect:/explorer');
    expect(data.loadDigestWeeks).not.toHaveBeenCalled();
    expect(data.countSubscribedRecipients).not.toHaveBeenCalled();
  });

  it('renders the digest weeks table for an admin', async () => {
    render(await AdminDigestsPage());
    expect(screen.getByRole('heading', { name: 'Weekly digests' })).toBeInTheDocument();
    expect(screen.getByText('No completed weeks yet.')).toBeInTheDocument();
  });
});

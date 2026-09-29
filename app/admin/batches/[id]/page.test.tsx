import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
// redirect for the page's own gate; notFound for a missing batch; useRouter for BatchActions/AutoRefresh.
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  notFound: () => { throw new Error('notFound'); },
  useRouter: () => ({ refresh: vi.fn() }),
}));
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
// The page reads Neon directly through db.query; the batch lookup is the first data read to guard.
const dbm = vi.hoisted(() => ({ findBatch: vi.fn(), findFiles: vi.fn(), findWeeks: vi.fn() }));
vi.mock('@/db/client', () => ({
  db: {
    query: {
      uploadBatches: { findFirst: dbm.findBatch },
      uploadedFiles: { findMany: dbm.findFiles },
      reportingWeeks: { findMany: dbm.findWeeks },
    },
  },
}));
import BatchDetailPage from './page';

const BATCH_ID = 'b1b1b1b1-0000-4000-8000-000000000000';
const props = { params: Promise.resolve({ id: BATCH_ID }) };

describe('BatchDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.state = 'admin';
    dbm.findBatch.mockResolvedValue({ id: BATCH_ID, status: 'imported' });
    dbm.findFiles.mockResolvedValue([]);
    dbm.findWeeks.mockResolvedValue([]);
  });

  it('redirects a non-admin before any data read — the page checks requireAdmin() itself, not only the layout', async () => {
    auth.state = 'unauthenticated';
    await expect(BatchDetailPage(props)).rejects.toThrow('redirect:/sign-in');
    expect(dbm.findBatch).not.toHaveBeenCalled();
    auth.state = 'forbidden';
    await expect(BatchDetailPage(props)).rejects.toThrow('redirect:/explorer');
    expect(dbm.findBatch).not.toHaveBeenCalled();
  });

  it('renders the batch detail for an admin', async () => {
    render(await BatchDetailPage(props));
    expect(screen.getByRole('heading', { name: 'Batch b1b1b1b1' })).toBeInTheDocument();
    expect(screen.getByText('All done.')).toBeInTheDocument();
  });
});

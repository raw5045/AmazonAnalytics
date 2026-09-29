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
// The page reads Neon directly through db.query; the relational query is the data read to guard.
const dbm = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { query: { uploadBatches: { findMany: dbm.findMany } } } }));
import BatchesHistoryPage from './page';

describe('BatchesHistoryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.state = 'admin';
    dbm.findMany.mockResolvedValue([]);
  });

  it('redirects a non-admin before any data read — the page checks requireAdmin() itself, not only the layout', async () => {
    auth.state = 'unauthenticated';
    await expect(BatchesHistoryPage()).rejects.toThrow('redirect:/sign-in');
    expect(dbm.findMany).not.toHaveBeenCalled();
    auth.state = 'forbidden';
    await expect(BatchesHistoryPage()).rejects.toThrow('redirect:/explorer');
    expect(dbm.findMany).not.toHaveBeenCalled();
  });

  it('lists recent batches for an admin', async () => {
    dbm.findMany.mockResolvedValue([
      { id: 'b1', createdAt: new Date('2026-09-25T10:00:00Z'), batchType: 'bulk', totalFiles: 3, passedFiles: 2, warningFiles: 1, failedFiles: 0, status: 'imported' },
    ]);
    render(await BatchesHistoryPage());
    expect(screen.getByRole('heading', { name: 'Upload history' })).toBeInTheDocument();
    expect(screen.getByText('2026-09-25T10:00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/admin/batches/b1');
  });
});

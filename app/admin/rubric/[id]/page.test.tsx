import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
// redirect for the page's own gate; notFound for a missing file; useRouter for ApproveSchemaButton.
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
// The page reads Neon directly through db.query; the file lookup is the first data read to guard.
const dbm = vi.hoisted(() => ({ findFile: vi.fn(), findSchema: vi.fn() }));
vi.mock('@/db/client', () => ({
  db: { query: { uploadedFiles: { findFirst: dbm.findFile }, schemaVersions: { findFirst: dbm.findSchema } } },
}));
import RubricDetailPage from './page';

const props = { params: Promise.resolve({ id: 'f1' }) };

describe('RubricDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.state = 'admin';
    dbm.findFile.mockResolvedValue({ id: 'f1', originalFilename: 'rubric.csv', weekEndDate: '2026-09-18', reportingDateRaw: null, schemaVersionId: null });
  });

  it('redirects a non-admin before any data read — the page checks requireAdmin() itself, not only the layout', async () => {
    auth.state = 'unauthenticated';
    await expect(RubricDetailPage(props)).rejects.toThrow('redirect:/sign-in');
    expect(dbm.findFile).not.toHaveBeenCalled();
    auth.state = 'forbidden';
    await expect(RubricDetailPage(props)).rejects.toThrow('redirect:/explorer');
    expect(dbm.findFile).not.toHaveBeenCalled();
  });

  it('renders the rubric preview for an admin', async () => {
    render(await RubricDetailPage(props));
    expect(screen.getByRole('heading', { name: 'Rubric preview' })).toBeInTheDocument();
    expect(screen.getByText('rubric.csv')).toBeInTheDocument();
    expect(dbm.findSchema).not.toHaveBeenCalled();
  });
});

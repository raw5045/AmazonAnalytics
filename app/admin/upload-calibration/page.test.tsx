import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
vi.mock('@/db/client', () => ({ db: { execute: vi.fn() } }));
// redirect for the page's own gate; useRouter for the client component(s) the page always renders.
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
import UploadCalibrationPage from './page';

describe('UploadCalibrationPage', () => {
  beforeEach(() => {
    auth.state = 'admin';
  });

  it('redirects a non-admin — the page checks requireAdmin() itself, not only the layout', async () => {
    auth.state = 'unauthenticated';
    await expect(UploadCalibrationPage()).rejects.toThrow('redirect:/sign-in');
    auth.state = 'forbidden';
    await expect(UploadCalibrationPage()).rejects.toThrow('redirect:/explorer');
  });

  it('renders the calibration uploader for an admin', async () => {
    render(await UploadCalibrationPage());
    expect(screen.getByRole('heading', { name: 'Upload calibration data' })).toBeInTheDocument();
  });
});

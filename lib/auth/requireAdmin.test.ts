import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetCurrentUser } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
}));

vi.mock('./getCurrentUser', () => ({ getCurrentUser: mockGetCurrentUser }));

import { requireAdmin, AuthError } from './requireAdmin';

describe('requireAdmin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws AuthError when no user is logged in', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);
    await expect(requireAdmin()).rejects.toThrow(AuthError);
  });

  it('throws AuthError when user is not admin', async () => {
    mockGetCurrentUser.mockResolvedValueOnce({ id: 'u', role: 'standard_user' });
    await expect(requireAdmin()).rejects.toThrow(AuthError);
  });

  it('returns user when user is admin', async () => {
    mockGetCurrentUser.mockResolvedValueOnce({ id: 'u', role: 'admin' });
    const user = await requireAdmin();
    expect(user.role).toBe('admin');
  });
});

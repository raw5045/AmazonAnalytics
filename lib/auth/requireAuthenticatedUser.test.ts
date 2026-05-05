import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetCurrentUser } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
}));

vi.mock('./getCurrentUser', () => ({ getCurrentUser: mockGetCurrentUser }));

import { requireAuthenticatedUser } from './requireAuthenticatedUser';
import { AuthError } from './requireAdmin';

describe('requireAuthenticatedUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws AuthError when no user is logged in', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);
    await expect(requireAuthenticatedUser()).rejects.toThrow(AuthError);
  });

  it('returns user when role is admin', async () => {
    mockGetCurrentUser.mockResolvedValueOnce({ id: 'u', role: 'admin' });
    const user = await requireAuthenticatedUser();
    expect(user.role).toBe('admin');
  });

  it('returns user when role is standard_user', async () => {
    mockGetCurrentUser.mockResolvedValueOnce({ id: 'u', role: 'standard_user' });
    const user = await requireAuthenticatedUser();
    expect(user.role).toBe('standard_user');
  });
});

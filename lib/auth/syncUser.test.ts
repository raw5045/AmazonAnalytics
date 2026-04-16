import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    insert: vi.fn(),
    update: vi.fn(),
    select: vi.fn(),
    query: { users: { findFirst: vi.fn() } },
  },
}));

vi.mock('@/db/client', () => ({ db: mockDb }));

import { syncUserFromClerk } from './syncUser';

describe('syncUserFromClerk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a new user when clerk_user_id does not exist', async () => {
    mockDb.query.users.findFirst.mockResolvedValueOnce(undefined);
    mockDb.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValueOnce({
        returning: vi.fn().mockResolvedValueOnce([{ id: 'new-uuid', clerkUserId: 'user_123' }]),
      }),
    });

    const result = await syncUserFromClerk({
      clerkUserId: 'user_123',
      email: 'test@example.com',
      name: 'Test User',
    });

    expect(result.clerkUserId).toBe('user_123');
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('updates an existing user when clerk_user_id exists', async () => {
    mockDb.query.users.findFirst.mockResolvedValueOnce({
      id: 'existing-uuid',
      clerkUserId: 'user_123',
      email: 'old@example.com',
      role: 'standard_user',
    });
    mockDb.update.mockReturnValueOnce({
      set: vi.fn().mockReturnValueOnce({
        where: vi.fn().mockReturnValueOnce({
          returning: vi
            .fn()
            .mockResolvedValueOnce([{ id: 'existing-uuid', email: 'new@example.com' }]),
        }),
      }),
    });

    const result = await syncUserFromClerk({
      clerkUserId: 'user_123',
      email: 'new@example.com',
      name: 'Updated',
    });

    expect(result.email).toBe('new@example.com');
    expect(mockDb.update).toHaveBeenCalled();
  });
});

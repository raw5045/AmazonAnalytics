import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSync, mockWelcome } = vi.hoisted(() => ({
  mockSync: vi.fn(),
  mockWelcome: vi.fn().mockResolvedValue(true),
}));

vi.mock('./syncUser', () => ({ syncUserFromClerk: mockSync }));
vi.mock('@/lib/notifications/sendWelcomeEmail', () => ({ sendWelcomeEmail: mockWelcome }));

import { provisionUser } from './provisionUser';

const input = { clerkUserId: 'user_1', email: 'jane@shop.co', name: 'Jane' };

describe('provisionUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the welcome email exactly when the row was just created', async () => {
    mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'jane@shop.co', name: 'Jane' }, created: true });
    const r = await provisionUser(input);
    expect(r.created).toBe(true);
    expect(mockSync).toHaveBeenCalledWith(input);
    expect(mockWelcome).toHaveBeenCalledWith({ to: 'jane@shop.co', name: 'Jane' });
  });

  it('does not send when the row already existed', async () => {
    mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'jane@shop.co', name: 'Jane' }, created: false });
    const r = await provisionUser(input);
    expect(r.created).toBe(false);
    expect(mockWelcome).not.toHaveBeenCalled();
  });

  it('does not send to an undeliverable address even on first creation', async () => {
    mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'x@example.com', name: null }, created: true });
    await provisionUser({ clerkUserId: 'user_2', email: 'x@example.com', name: null });
    expect(mockWelcome).not.toHaveBeenCalled();
  });

  it('returns the synced user untouched', async () => {
    const user = { id: 'u', clerkUserId: 'user_1', email: 'jane@shop.co', name: 'Jane', role: 'standard_user' };
    mockSync.mockResolvedValueOnce({ user, created: false });
    expect((await provisionUser(input)).user).toBe(user);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSync, mockWelcome, mockAfter } = vi.hoisted(() => ({
  mockSync: vi.fn(),
  mockWelcome: vi.fn().mockResolvedValue(true),
  mockAfter: vi.fn(),
}));

vi.mock('./syncUser', () => ({ syncUserFromClerk: mockSync }));
vi.mock('@/lib/notifications/sendWelcomeEmail', () => ({ sendWelcomeEmail: mockWelcome }));
vi.mock('next/server', () => ({ after: mockAfter }));

import { provisionUser } from './provisionUser';

const input = { clerkUserId: 'user_1', email: 'jane@shop.co', name: 'Jane' };
const created = () =>
  mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'jane@shop.co', name: 'Jane' }, created: true });
const existed = () =>
  mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'jane@shop.co', name: 'Jane' }, created: false });

describe('provisionUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the welcome email inline, exactly when the row was just created', async () => {
    created();
    const r = await provisionUser(input);
    expect(r.created).toBe(true);
    expect(mockSync).toHaveBeenCalledWith(input);
    expect(mockWelcome).toHaveBeenCalledWith({ to: 'jane@shop.co', name: 'Jane' });
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('does not send when the row already existed', async () => {
    existed();
    const r = await provisionUser(input);
    expect(r.created).toBe(false);
    expect(mockWelcome).not.toHaveBeenCalled();
  });

  it('does not send to an undeliverable address even on first creation', async () => {
    mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'x@example.com', name: null }, created: true });
    await provisionUser({ clerkUserId: 'user_2', email: 'x@example.com', name: null });
    expect(mockWelcome).not.toHaveBeenCalled();
  });

  it("in 'after' mode, schedules the welcome for after the response instead of awaiting it", async () => {
    created();
    const r = await provisionUser(input, { welcome: 'after' });
    expect(r.created).toBe(true);
    expect(mockWelcome).not.toHaveBeenCalled(); // nothing sent inside the request
    expect(mockAfter).toHaveBeenCalledTimes(1);
    await (mockAfter.mock.calls[0][0] as () => Promise<unknown>)(); // run the scheduled task
    expect(mockWelcome).toHaveBeenCalledWith({ to: 'jane@shop.co', name: 'Jane' });
  });

  it("in 'after' mode, schedules nothing when the row already existed", async () => {
    existed();
    await provisionUser(input, { welcome: 'after' });
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockWelcome).not.toHaveBeenCalled();
  });

  it('refuses an empty email without syncing', async () => {
    await expect(provisionUser({ clerkUserId: 'user_3', email: '', name: null })).rejects.toThrow(/email/);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('returns the synced user untouched', async () => {
    const user = { id: 'u', clerkUserId: 'user_1', email: 'jane@shop.co', name: 'Jane', role: 'standard_user' };
    mockSync.mockResolvedValueOnce({ user, created: false });
    expect((await provisionUser(input)).user).toBe(user);
  });
});

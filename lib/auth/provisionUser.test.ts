import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSync, mockWelcome, mockAddContact, mockAfter } = vi.hoisted(() => ({
  mockSync: vi.fn(),
  mockWelcome: vi.fn().mockResolvedValue(true),
  mockAddContact: vi.fn().mockResolvedValue('added'),
  mockAfter: vi.fn(),
}));

vi.mock('./syncUser', () => ({ syncUserFromClerk: mockSync }));
vi.mock('@/lib/notifications/sendWelcomeEmail', () => ({ sendWelcomeEmail: mockWelcome }));
vi.mock('@/lib/notifications/resendContacts', () => ({ addResendContact: mockAddContact }));
vi.mock('next/server', () => ({ after: mockAfter }));

import { provisionUser } from './provisionUser';

const input = { clerkUserId: 'user_1', email: 'jane@shop.co', name: 'Jane' };
const created = () =>
  mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'jane@shop.co', name: 'Jane' }, created: true });
const existed = () =>
  mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'jane@shop.co', name: 'Jane' }, created: false });

describe('provisionUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs both signup side effects inline, exactly when the row was just created', async () => {
    created();
    const r = await provisionUser(input);
    expect(r.created).toBe(true);
    expect(mockSync).toHaveBeenCalledWith(input);
    expect(mockWelcome).toHaveBeenCalledWith({ to: 'jane@shop.co', name: 'Jane' });
    expect(mockAddContact).toHaveBeenCalledWith({ email: 'jane@shop.co', name: 'Jane' });
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('does nothing when the row already existed', async () => {
    existed();
    const r = await provisionUser(input);
    expect(r.created).toBe(false);
    expect(mockWelcome).not.toHaveBeenCalled();
    expect(mockAddContact).not.toHaveBeenCalled();
  });

  it('skips both side effects for an undeliverable address even on first creation', async () => {
    mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'x@example.com', name: null }, created: true });
    await provisionUser({ clerkUserId: 'user_2', email: 'x@example.com', name: null });
    expect(mockWelcome).not.toHaveBeenCalled();
    expect(mockAddContact).not.toHaveBeenCalled();
  });

  it('passes a null name through to the contact when the member has none', async () => {
    mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'anon@shop.co', name: null }, created: true });
    await provisionUser({ clerkUserId: 'user_4', email: 'anon@shop.co', name: null });
    expect(mockAddContact).toHaveBeenCalledWith({ email: 'anon@shop.co', name: null });
  });

  it("in 'after' mode, schedules both side effects for after the response instead of awaiting them", async () => {
    created();
    const r = await provisionUser(input, { sideEffects: 'after' });
    expect(r.created).toBe(true);
    expect(mockWelcome).not.toHaveBeenCalled(); // nothing runs inside the request
    expect(mockAddContact).not.toHaveBeenCalled();
    expect(mockAfter).toHaveBeenCalledTimes(1);
    await (mockAfter.mock.calls[0][0] as () => Promise<unknown>)(); // run the scheduled task
    expect(mockWelcome).toHaveBeenCalledWith({ to: 'jane@shop.co', name: 'Jane' });
    expect(mockAddContact).toHaveBeenCalledWith({ email: 'jane@shop.co', name: 'Jane' });
  });

  it("in 'after' mode, schedules nothing when the row already existed", async () => {
    existed();
    await provisionUser(input, { sideEffects: 'after' });
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockWelcome).not.toHaveBeenCalled();
    expect(mockAddContact).not.toHaveBeenCalled();
  });

  it('still adds the contact when the welcome email reports failure (independent side effects)', async () => {
    created();
    mockWelcome.mockResolvedValueOnce(false);
    await provisionUser(input);
    expect(mockAddContact).toHaveBeenCalledTimes(1);
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

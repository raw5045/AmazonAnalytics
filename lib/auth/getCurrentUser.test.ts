import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockAuth, mockCurrentUser, mockFindFirst, mockProvision } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCurrentUser: vi.fn(),
  mockFindFirst: vi.fn(),
  mockProvision: vi.fn(),
}));

vi.mock('@clerk/nextjs/server', () => ({ auth: mockAuth, currentUser: mockCurrentUser }));
vi.mock('@/db/client', () => ({ db: { query: { users: { findFirst: mockFindFirst } } } }));
vi.mock('./provisionUser', () => ({ provisionUser: mockProvision }));

import { getCurrentUser } from './getCurrentUser';

describe('getCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns null with no Clerk session and never touches the database', async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    expect(await getCurrentUser()).toBeNull();
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('returns the existing row without asking Clerk or provisioning', async () => {
    mockAuth.mockResolvedValueOnce({ userId: 'user_1' });
    mockFindFirst.mockResolvedValueOnce({ id: 'u1', clerkUserId: 'user_1' });
    expect(await getCurrentUser()).toEqual({ id: 'u1', clerkUserId: 'user_1' });
    expect(mockCurrentUser).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('provisions the row on the spot when Clerk has a session but the webhook has not landed', async () => {
    mockAuth.mockResolvedValueOnce({ userId: 'user_1' });
    mockFindFirst.mockResolvedValueOnce(undefined);
    mockCurrentUser.mockResolvedValueOnce({
      id: 'user_1',
      firstName: 'Jane',
      lastName: 'Doe',
      primaryEmailAddress: { emailAddress: 'jane@shop.co' },
      emailAddresses: [{ emailAddress: 'old@shop.co' }, { emailAddress: 'jane@shop.co' }],
    });
    mockProvision.mockResolvedValueOnce({
      user: { id: 'u1', clerkUserId: 'user_1', email: 'jane@shop.co' },
      created: true,
    });
    const u = await getCurrentUser();
    expect(mockProvision).toHaveBeenCalledWith({ clerkUserId: 'user_1', email: 'jane@shop.co', name: 'Jane Doe' });
    expect(u).toEqual({ id: 'u1', clerkUserId: 'user_1', email: 'jane@shop.co' });
  });

  it('falls back to the first email address and a null name when Clerk has neither primary nor name', async () => {
    mockAuth.mockResolvedValueOnce({ userId: 'user_2' });
    mockFindFirst.mockResolvedValueOnce(undefined);
    mockCurrentUser.mockResolvedValueOnce({
      id: 'user_2',
      firstName: null,
      lastName: null,
      primaryEmailAddress: null,
      emailAddresses: [{ emailAddress: 'only@shop.co' }],
    });
    mockProvision.mockResolvedValueOnce({ user: { id: 'u2' }, created: true });
    await getCurrentUser();
    expect(mockProvision).toHaveBeenCalledWith({ clerkUserId: 'user_2', email: 'only@shop.co', name: null });
  });

  it('returns null when Clerk no longer knows the user', async () => {
    mockAuth.mockResolvedValueOnce({ userId: 'user_gone' });
    mockFindFirst.mockResolvedValueOnce(undefined);
    mockCurrentUser.mockResolvedValueOnce(null);
    expect(await getCurrentUser()).toBeNull();
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('returns null rather than provisioning when the Clerk user has no email address at all', async () => {
    mockAuth.mockResolvedValueOnce({ userId: 'user_3' });
    mockFindFirst.mockResolvedValueOnce(undefined);
    mockCurrentUser.mockResolvedValueOnce({ id: 'user_3', firstName: null, lastName: null, primaryEmailAddress: null, emailAddresses: [] });
    expect(await getCurrentUser()).toBeNull();
    expect(mockProvision).not.toHaveBeenCalled();
  });
});

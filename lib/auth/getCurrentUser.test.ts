import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockAuth, mockCurrentUser, mockFindFirst, mockProvision } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCurrentUser: vi.fn(),
  mockFindFirst: vi.fn(),
  mockProvision: vi.fn(),
}));

vi.mock('@clerk/nextjs/server', () => ({ auth: mockAuth, currentUser: mockCurrentUser }));
vi.mock('@clerk/nextjs/errors', () => ({
  isClerkAPIResponseError: (e: unknown) => !!e && typeof e === 'object' && 'clerkError' in e,
}));
vi.mock('@/db/client', () => ({ db: { query: { users: { findFirst: mockFindFirst } } } }));
vi.mock('./provisionUser', () => ({ provisionUser: mockProvision }));

import { getCurrentUser } from './getCurrentUser';
import { AuthError } from './AuthError';

const clerkError = (status: number) => Object.assign(new Error(`clerk ${status}`), { clerkError: true, status });

describe('getCurrentUser', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
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

  it('provisions the row on the spot (welcome deferred past the response) when Clerk has a session but no row exists', async () => {
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
    expect(mockProvision).toHaveBeenCalledWith(
      { clerkUserId: 'user_1', email: 'jane@shop.co', name: 'Jane Doe' },
      { welcome: 'after' },
    );
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
    expect(mockProvision).toHaveBeenCalledWith(
      { clerkUserId: 'user_2', email: 'only@shop.co', name: null },
      { welcome: 'after' },
    );
  });

  it('throws UNPROVISIONABLE (not a bounce to /sign-in) when Clerk answers 404 for the session user', async () => {
    mockAuth.mockResolvedValueOnce({ userId: 'user_gone' });
    mockFindFirst.mockResolvedValueOnce(undefined);
    mockCurrentUser.mockRejectedValueOnce(clerkError(404));
    await expect(getCurrentUser()).rejects.toMatchObject({ name: 'AuthError', code: 'UNPROVISIONABLE' });
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('surfaces other Clerk API failures instead of silently signing the member out', async () => {
    mockAuth.mockResolvedValueOnce({ userId: 'user_1' });
    mockFindFirst.mockResolvedValueOnce(undefined);
    const err = clerkError(503);
    mockCurrentUser.mockRejectedValueOnce(err);
    await expect(getCurrentUser()).rejects.toBe(err);
    expect(error).toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('throws UNPROVISIONABLE rather than provisioning when the Clerk user has no email address', async () => {
    mockAuth.mockResolvedValueOnce({ userId: 'user_3' });
    mockFindFirst.mockResolvedValueOnce(undefined);
    mockCurrentUser.mockResolvedValueOnce({
      id: 'user_3',
      firstName: null,
      lastName: null,
      primaryEmailAddress: null,
      emailAddresses: [],
    });
    const p = getCurrentUser();
    await expect(p).rejects.toBeInstanceOf(AuthError);
    await expect(p).rejects.toMatchObject({ code: 'UNPROVISIONABLE' });
    expect(mockProvision).not.toHaveBeenCalled();
  });
});

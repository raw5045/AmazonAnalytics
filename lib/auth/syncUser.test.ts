import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    insert: vi.fn(),
    update: vi.fn(),
    query: { users: { findFirst: vi.fn() } },
  },
}));

vi.mock('@/db/client', () => ({ db: mockDb }));

import { syncUserFromClerk, type SyncDeps } from './syncUser';

/** insert().values().onConflictDoUpdate().returning() → result (or rejection). */
function insertChain(result: unknown[] | Error) {
  const returning =
    result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  const onConflictDoUpdate = vi.fn().mockReturnValueOnce({ returning });
  const values = vi.fn().mockReturnValueOnce({ onConflictDoUpdate });
  mockDb.insert.mockReturnValueOnce({ values });
  return { values, onConflictDoUpdate, returning };
}

/** update().set().where().returning() → result. */
function updateChain(result: unknown[]) {
  const returning = vi.fn().mockResolvedValueOnce(result);
  const where = vi.fn().mockReturnValueOnce({ returning });
  const set = vi.fn().mockReturnValueOnce({ where });
  mockDb.update.mockReturnValueOnce({ set });
  return { set, where, returning };
}

const base = {
  id: 'uuid-1',
  clerkUserId: 'user_123',
  email: 'test@example.com',
  name: 'Test User',
  role: 'standard_user',
};

const emailConflict = () =>
  Object.assign(new Error('duplicate key value violates unique constraint "users_email_idx"'), {
    code: '23505',
    constraint: 'users_email_idx',
  });

const deps = (lookup: SyncDeps['lookupClerkUser']): SyncDeps => ({ lookupClerkUser: lookup });
const neverCalled = deps(
  vi.fn(async () => {
    throw new Error('lookupClerkUser should not be called');
  }),
);

describe('syncUserFromClerk', () => {
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

  it('upserts on clerk_user_id and reports created=true for a fresh insert', async () => {
    const chain = insertChain([{ ...base, created: true }]);
    const r = await syncUserFromClerk(
      { clerkUserId: 'user_123', email: 'test@example.com', name: 'Test User' },
      neverCalled,
    );
    expect(r.created).toBe(true);
    expect(r.user).toEqual(base); // the `created` marker is stripped from the row
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        clerkUserId: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
        lastLoginAt: expect.any(Date), // a freshly created user is, by definition, signed in
      }),
    );
    expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('reports created=false when the row already existed (the upsert took the update path)', async () => {
    insertChain([{ ...base, email: 'new@example.com', created: false }]);
    const r = await syncUserFromClerk({ clerkUserId: 'user_123', email: 'new@example.com', name: null }, neverCalled);
    expect(r.created).toBe(false);
    expect(r.user.email).toBe('new@example.com');
  });

  it('refuses an empty email before touching the database', async () => {
    await expect(syncUserFromClerk({ clerkUserId: 'user_1', email: '', name: null }, neverCalled)).rejects.toThrow(
      /email/,
    );
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  describe('email conflict (23505 on users_email_idx)', () => {
    const stale = { ...base, id: 'uuid-stale', clerkUserId: 'user_OLD', role: 'admin' };
    const newcomer = { clerkUserId: 'user_NEW', email: 'test@example.com', name: null };

    it('re-links the row to the new Clerk id — role reset — when Clerk no longer has the old user', async () => {
      insertChain(emailConflict());
      mockDb.query.users.findFirst.mockResolvedValueOnce(stale);
      const lookup = vi.fn().mockResolvedValueOnce(null); // Clerk 404 → the old account is gone
      const upd = updateChain([{ ...stale, clerkUserId: 'user_NEW', role: 'standard_user' }]);
      const r = await syncUserFromClerk(newcomer, deps(lookup));
      expect(lookup).toHaveBeenCalledWith('user_OLD');
      expect(r.created).toBe(false);
      expect(r.user.clerkUserId).toBe('user_NEW');
      expect(upd.set).toHaveBeenCalledWith(
        expect.objectContaining({ clerkUserId: 'user_NEW', role: 'standard_user' }),
      );
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).not.toContain('test@example.com'); // ids only, never the address
    });

    it("refreshes the old user's email from Clerk and retries when that user still exists under a new address", async () => {
      insertChain(emailConflict());
      mockDb.query.users.findFirst.mockResolvedValueOnce(stale);
      const lookup = vi.fn().mockResolvedValueOnce({ email: 'moved@example.com' });
      const refresh = updateChain([{ ...stale, email: 'moved@example.com' }]);
      const retry = insertChain([{ ...base, clerkUserId: 'user_NEW', created: true }]);
      const r = await syncUserFromClerk(newcomer, deps(lookup));
      expect(refresh.set).toHaveBeenCalledWith(expect.objectContaining({ email: 'moved@example.com' }));
      expect(refresh.set).not.toHaveBeenCalledWith(expect.objectContaining({ clerkUserId: 'user_NEW' }));
      expect(retry.values).toHaveBeenCalled();
      expect(r.created).toBe(true);
      expect(r.user.clerkUserId).toBe('user_NEW');
    });

    it('rethrows when Clerk says the old user still holds this very address (nothing safe to do)', async () => {
      const err = emailConflict();
      insertChain(err);
      mockDb.query.users.findFirst.mockResolvedValueOnce(stale);
      await expect(
        syncUserFromClerk(newcomer, deps(vi.fn().mockResolvedValueOnce({ email: 'test@example.com' }))),
      ).rejects.toBe(err);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('rethrows the original error when the Clerk lookup itself fails', async () => {
      const err = emailConflict();
      insertChain(err);
      mockDb.query.users.findFirst.mockResolvedValueOnce(stale);
      await expect(
        syncUserFromClerk(newcomer, deps(vi.fn().mockRejectedValueOnce(new Error('clerk down')))),
      ).rejects.toBe(err);
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalled();
    });

    it('rethrows when no row actually holds the email', async () => {
      const err = emailConflict();
      insertChain(err);
      mockDb.query.users.findFirst.mockResolvedValueOnce(undefined);
      await expect(syncUserFromClerk(newcomer, neverCalled)).rejects.toBe(err);
    });

    it('recognises the conflict when the driver error is wrapped in a cause', async () => {
      const cause = Object.assign(new Error('dup'), {
        code: '23505',
        detail: 'Key (email)=(test@example.com) already exists.',
      });
      insertChain(Object.assign(new Error('Failed query'), { cause }));
      mockDb.query.users.findFirst.mockResolvedValueOnce(stale);
      updateChain([{ ...stale, clerkUserId: 'user_NEW', role: 'standard_user' }]);
      const r = await syncUserFromClerk(newcomer, deps(vi.fn().mockResolvedValueOnce(null)));
      expect(r.user.clerkUserId).toBe('user_NEW');
    });
  });

  it('rethrows unrelated database errors untouched', async () => {
    const err = Object.assign(new Error('connection reset'), { code: '57P01' });
    insertChain(err);
    await expect(
      syncUserFromClerk({ clerkUserId: 'user_123', email: 'test@example.com', name: null }, neverCalled),
    ).rejects.toBe(err);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('rethrows a unique violation on clerk_user_id (not the email index) untouched', async () => {
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "users_clerk_user_id_idx"'),
      { code: '23505', constraint: 'users_clerk_user_id_idx', detail: 'Key (clerk_user_id)=(user_123) already exists.' },
    );
    insertChain(err);
    await expect(
      syncUserFromClerk({ clerkUserId: 'user_123', email: 'test@example.com', name: null }, neverCalled),
    ).rejects.toBe(err);
    expect(mockDb.query.users.findFirst).not.toHaveBeenCalled();
  });
});

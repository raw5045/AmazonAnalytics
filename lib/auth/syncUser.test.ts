import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    insert: vi.fn(),
    update: vi.fn(),
    query: { users: { findFirst: vi.fn() } },
  },
}));

vi.mock('@/db/client', () => ({ db: mockDb }));

import { syncUserFromClerk } from './syncUser';

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

describe('syncUserFromClerk', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('upserts on clerk_user_id and reports created=true for a fresh insert', async () => {
    const chain = insertChain([{ ...base, created: true }]);
    const r = await syncUserFromClerk({ clerkUserId: 'user_123', email: 'test@example.com', name: 'Test User' });
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
    const r = await syncUserFromClerk({ clerkUserId: 'user_123', email: 'new@example.com', name: null });
    expect(r.created).toBe(false);
    expect(r.user.email).toBe('new@example.com');
  });

  it('re-links a stale row that holds the same email under a dead Clerk id', async () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint "users_email_idx"'), {
      code: '23505',
      constraint: 'users_email_idx',
    });
    insertChain(err);
    const upd = updateChain([{ ...base, clerkUserId: 'user_NEW' }]);
    const r = await syncUserFromClerk({ clerkUserId: 'user_NEW', email: 'test@example.com', name: null });
    expect(r.created).toBe(false);
    expect(r.user.clerkUserId).toBe('user_NEW');
    expect(upd.set).toHaveBeenCalledWith(expect.objectContaining({ clerkUserId: 'user_NEW' }));
    expect(warn).toHaveBeenCalled();
  });

  it('recognises the email conflict when the driver error is wrapped in a cause', async () => {
    const cause = Object.assign(new Error('dup'), {
      code: '23505',
      detail: 'Key (email)=(test@example.com) already exists.',
    });
    insertChain(Object.assign(new Error('Failed query'), { cause }));
    updateChain([{ ...base, clerkUserId: 'user_NEW' }]);
    const r = await syncUserFromClerk({ clerkUserId: 'user_NEW', email: 'test@example.com', name: null });
    expect(r.user.clerkUserId).toBe('user_NEW');
  });

  it('rethrows unrelated database errors untouched', async () => {
    const err = Object.assign(new Error('connection reset'), { code: '57P01' });
    insertChain(err);
    await expect(
      syncUserFromClerk({ clerkUserId: 'user_123', email: 'test@example.com', name: null }),
    ).rejects.toBe(err);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('rethrows the email conflict if no row with that email can be re-linked', async () => {
    const err = Object.assign(new Error('dup'), { code: '23505', constraint: 'users_email_idx' });
    insertChain(err);
    updateChain([]);
    await expect(
      syncUserFromClerk({ clerkUserId: 'user_NEW', email: 'test@example.com', name: null }),
    ).rejects.toBe(err);
  });
});

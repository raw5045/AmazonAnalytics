import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSyncUser } = vi.hoisted(() => ({
  mockSyncUser: vi.fn().mockResolvedValue({ id: 'uuid', clerkUserId: 'user_123' }),
}));

vi.mock('svix', () => ({
  Webhook: class {
    constructor(public secret: string) {}
    verify(body: string, headers: Record<string, string>) {
      if (headers['svix-signature'] === 'bad') throw new Error('invalid signature');
      return JSON.parse(body);
    }
  },
}));

vi.mock('@/lib/auth/syncUser', () => ({
  syncUserFromClerk: mockSyncUser,
}));

vi.mock('@/lib/env', () => ({
  env: { CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_test' },
}));

// Mock the db client for user.deleted handling
const { mockDbDelete } = vi.hoisted(() => ({
  mockDbDelete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock('@/db/client', () => ({
  db: { delete: mockDbDelete },
}));

import { POST } from './route';

function makeRequest(body: unknown, signature = 'good') {
  return new Request('http://localhost/api/webhooks/clerk', {
    method: 'POST',
    headers: {
      'svix-id': 'msg_1',
      'svix-timestamp': String(Date.now()),
      'svix-signature': signature,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/webhooks/clerk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects requests with invalid signature', async () => {
    const req = makeRequest({ type: 'user.created', data: {} }, 'bad');
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('processes user.created event', async () => {
    const req = makeRequest({
      type: 'user.created',
      data: {
        id: 'user_123',
        email_addresses: [{ id: 'a', email_address: 'test@x.com' }],
        primary_email_address_id: 'a',
        first_name: 'Test',
        last_name: 'User',
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockSyncUser).toHaveBeenCalledWith({
      clerkUserId: 'user_123',
      email: 'test@x.com',
      name: 'Test User',
    });
  });

  it('rejects requests missing svix headers', async () => {
    const req = new Request('http://localhost/api/webhooks/clerk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user.created', data: {} }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

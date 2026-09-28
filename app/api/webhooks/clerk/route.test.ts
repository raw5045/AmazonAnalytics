import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSyncUser, mockSendWelcome, mockAddContact, mockRemoveContact } = vi.hoisted(() => ({
  mockSyncUser: vi.fn().mockResolvedValue({
    user: { id: 'uuid', clerkUserId: 'user_123', email: 'test@x.com', name: 'Test User' },
    created: true,
  }),
  mockSendWelcome: vi.fn().mockResolvedValue(true),
  mockAddContact: vi.fn().mockResolvedValue('added'),
  mockRemoveContact: vi.fn().mockResolvedValue('removed'),
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

vi.mock('@/lib/notifications/sendWelcomeEmail', () => ({
  sendWelcomeEmail: mockSendWelcome,
}));

vi.mock('@/lib/notifications/resendContacts', () => ({
  addResendContact: mockAddContact,
  removeResendContact: mockRemoveContact,
}));

vi.mock('@/lib/env', () => ({
  env: { CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_test' },
}));

// Mock the db client for user.deleted handling: delete → where → returning
const { mockDbDelete, mockReturning } = vi.hoisted(() => {
  const mockReturning = vi.fn().mockResolvedValue([]);
  return {
    mockReturning,
    mockDbDelete: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: mockReturning }) }),
  };
});

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

  it('sends the welcome email exactly on first creation', async () => {
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
    expect(mockSendWelcome).toHaveBeenCalledWith({ to: 'test@x.com', name: 'Test User' });
    expect(mockAddContact).toHaveBeenCalledWith({ email: 'test@x.com', name: 'Test User' });
  });

  it('does not send the welcome email on a webhook retry (row already existed)', async () => {
    mockSyncUser.mockResolvedValueOnce({
      user: { id: 'uuid', clerkUserId: 'user_123', email: 'test@x.com', name: 'Test User' },
      created: false,
    });
    const req = makeRequest({
      type: 'user.created',
      data: {
        id: 'user_123',
        email_addresses: [{ id: 'a', email_address: 'test@x.com' }],
        primary_email_address_id: 'a',
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockSendWelcome).not.toHaveBeenCalled();
    expect(mockAddContact).not.toHaveBeenCalled();
  });

  it('does not send the welcome email on user.updated when the row already existed', async () => {
    mockSyncUser.mockResolvedValueOnce({
      user: { id: 'uuid', clerkUserId: 'user_123', email: 'test@x.com', name: 'Test User' },
      created: false,
    });
    const req = makeRequest({
      type: 'user.updated',
      data: {
        id: 'user_123',
        email_addresses: [{ id: 'a', email_address: 'test@x.com' }],
        primary_email_address_id: 'a',
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockSendWelcome).not.toHaveBeenCalled();
  });

  it('welcomes on user.updated if that is the first time the row is created (insert gates the email, not the event type)', async () => {
    const req = makeRequest({
      type: 'user.updated',
      data: {
        id: 'user_123',
        email_addresses: [{ id: 'a', email_address: 'test@x.com' }],
        primary_email_address_id: 'a',
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockSendWelcome).toHaveBeenCalledTimes(1);
  });

  it('acknowledges with 200 and provisions nothing when the Clerk user carries no email address', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = makeRequest({
      type: 'user.created',
      data: { id: 'user_noemail', email_addresses: [], primary_email_address_id: '' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockSyncUser).not.toHaveBeenCalled();
    expect(mockSendWelcome).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips the welcome email for undeliverable test-domain addresses', async () => {
    mockSyncUser.mockResolvedValueOnce({
      user: { id: 'uuid', clerkUserId: 'user_9', email: 'bot@example.com', name: null },
      created: true,
    });
    const req = makeRequest({
      type: 'user.created',
      data: {
        id: 'user_9',
        email_addresses: [{ id: 'a', email_address: 'bot@example.com' }],
        primary_email_address_id: 'a',
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockSendWelcome).not.toHaveBeenCalled();
  });

  describe('user.deleted', () => {
    const deleted = () => makeRequest({ type: 'user.deleted', data: { id: 'user_del', deleted: true } });

    it('deletes the row and removes the Resend contact for its email', async () => {
      mockReturning.mockResolvedValueOnce([{ email: 'gone@shop.co' }]);
      const res = await POST(deleted());
      expect(res.status).toBe(200);
      expect(mockDbDelete).toHaveBeenCalledTimes(1);
      expect(mockRemoveContact).toHaveBeenCalledWith('gone@shop.co');
    });

    it('removes nothing from Resend when no row matched (already gone)', async () => {
      mockReturning.mockResolvedValueOnce([]);
      const res = await POST(deleted());
      expect(res.status).toBe(200);
      expect(mockRemoveContact).not.toHaveBeenCalled();
    });

    it('still acknowledges with 200 when the Resend removal reports failure (fail-soft)', async () => {
      mockReturning.mockResolvedValueOnce([{ email: 'gone@shop.co' }]);
      mockRemoveContact.mockResolvedValueOnce('failed');
      const res = await POST(deleted());
      expect(res.status).toBe(200);
      expect(mockRemoveContact).toHaveBeenCalledWith('gone@shop.co');
    });

    it('returns 500 (so Svix retries) when the row delete itself throws, without touching Resend', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockReturning.mockRejectedValueOnce(new Error('neon blip'));
      const res = await POST(deleted());
      expect(res.status).toBe(500);
      expect(mockRemoveContact).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it('awaits the removal before acknowledging', async () => {
      mockReturning.mockResolvedValueOnce([{ email: 'gone@shop.co' }]);
      let settle!: (v: string) => void;
      mockRemoveContact.mockReturnValueOnce(new Promise<string>((r) => { settle = r; }));
      let responded = false;
      const pending = POST(deleted()).then((res) => { responded = true; return res; });
      await vi.waitFor(() => expect(mockRemoveContact).toHaveBeenCalledWith('gone@shop.co'));
      expect(responded).toBe(false);
      settle('removed');
      expect((await pending).status).toBe(200);
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

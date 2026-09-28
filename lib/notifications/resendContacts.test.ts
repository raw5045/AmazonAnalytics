import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCreate, mockRemove } = vi.hoisted(() => ({ mockCreate: vi.fn(), mockRemove: vi.fn() }));

vi.mock('resend', () => ({
  Resend: class {
    contacts = { create: mockCreate, remove: mockRemove };
    constructor(public apiKey: string) {}
  },
}));

import { addResendContact, removeResendContact, splitName } from './resendContacts';

const ok = (data: unknown) => ({ data, error: null, headers: null });
const fail = (error: { name: string; message: string; statusCode: number | null }) => ({
  data: null,
  error,
  headers: null,
});

function configured() {
  vi.clearAllMocks();
  vi.stubEnv('RESEND_API_KEY', 're_test');
  vi.stubEnv('RESEND_SEGMENT_ID', 'seg_beta');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}
function restore() {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
}

describe('splitName', () => {
  it.each([
    [null, {}],
    [undefined, {}],
    ['', {}],
    ['   ', {}],
    ['Jane', { firstName: 'Jane' }],
    ['Jane Doe', { firstName: 'Jane', lastName: 'Doe' }],
    ['  Mary   Ann  Smith ', { firstName: 'Mary', lastName: 'Ann Smith' }],
  ])('%j → %j', (name, expected) => {
    expect(splitName(name as string | null | undefined)).toEqual(expected);
  });
});

describe('addResendContact', () => {
  beforeEach(configured);
  afterEach(restore);

  it('creates an account-level contact inside the configured segment, with the split name', async () => {
    mockCreate.mockResolvedValueOnce(ok({ object: 'contact', id: 'c_1' }));
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane Doe' })).toBe('added');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      email: 'jane@shop.co',
      firstName: 'Jane',
      lastName: 'Doe',
      segments: [{ id: 'seg_beta' }],
    });
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('sends no name fields when the member has no name', async () => {
    mockCreate.mockResolvedValueOnce(ok({ object: 'contact', id: 'c_2' }));
    await addResendContact({ email: 'anon@shop.co', name: null });
    expect(mockCreate).toHaveBeenCalledWith({ email: 'anon@shop.co', segments: [{ id: 'seg_beta' }] });
  });

  it('is a silent no-op when RESEND_SEGMENT_ID is unset (feature off)', async () => {
    vi.stubEnv('RESEND_SEGMENT_ID', '');
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('skipped');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns and skips when the segment is set but the API key is missing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('skipped');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('trims a pasted segment id (a trailing newline would make every add a 422)', async () => {
    vi.stubEnv('RESEND_SEGMENT_ID', ' seg_beta\n');
    mockCreate.mockResolvedValueOnce(ok({ object: 'contact', id: 'c_3' }));
    await addResendContact({ email: 'jane@shop.co', name: null });
    expect(mockCreate).toHaveBeenCalledWith({ email: 'jane@shop.co', segments: [{ id: 'seg_beta' }] });
  });

  it('treats a whitespace-only segment id as unset', async () => {
    vi.stubEnv('RESEND_SEGMENT_ID', '   ');
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('skipped');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each(['itest_1700000000000@example.com', 'rw_5@shop.co', 'bot@example.com', 'nobody@localhost'])(
    'never adds a synthetic or undeliverable address (%s)',
    async (email) => {
      expect(await addResendContact({ email, name: null })).toBe('skipped');
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  it('treats an "already exists" message as benign, whatever the status', async () => {
    mockCreate.mockResolvedValueOnce(
      fail({ name: 'validation_error', message: 'Contact already exists', statusCode: 409 }),
    );
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('exists');
    mockCreate.mockResolvedValueOnce(
      fail({ name: 'validation_error', message: 'A contact with this email already exists.', statusCode: 422 }),
    );
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('exists');
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('does not mistake a temporary 409 (resource_locked) for a duplicate', async () => {
    mockCreate.mockResolvedValueOnce(
      fail({ name: 'resource_locked', message: 'Another request is already updating this resource.', statusCode: 409 }),
    );
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('failed');
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('reports failed and logs when Resend returns any other error', async () => {
    mockCreate.mockResolvedValueOnce(
      fail({ name: 'rate_limit_exceeded', message: 'Too many requests', statusCode: 429 }),
    );
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('failed');
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('reports failed and logs on the SDK-caught network failure shape (application_error, statusCode null)', async () => {
    mockCreate.mockResolvedValueOnce(
      fail({
        name: 'application_error',
        message: 'Unable to fetch data. The request could not be resolved.',
        statusCode: null,
      }),
    );
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('failed');
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('reports failed and never throws when the client throws (e.g. a malformed key)', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Headers.append: invalid header value'));
    await expect(addResendContact({ email: 'jane@shop.co', name: 'Jane' })).resolves.toBe('failed');
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe('removeResendContact', () => {
  beforeEach(configured);
  afterEach(restore);

  it('removes the contact by email (every segment — the account is gone)', async () => {
    mockRemove.mockResolvedValueOnce(ok({ object: 'contact', contact: 'c_1', deleted: true }));
    expect(await removeResendContact('jane@shop.co')).toBe('removed');
    expect(mockRemove).toHaveBeenCalledWith({ email: 'jane@shop.co' });
  });

  it('is a silent no-op when the feature is off', async () => {
    vi.stubEnv('RESEND_SEGMENT_ID', '');
    expect(await removeResendContact('jane@shop.co')).toBe('skipped');
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('skips synthetic and undeliverable addresses', async () => {
    expect(await removeResendContact('itest_1@example.com')).toBe('skipped');
    expect(await removeResendContact('bot@example.com')).toBe('skipped');
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it.each(['victim%40shop.co?@attacker.co', 'x#y@shop.co', '../domains/d?@attacker.co', 'a\\b@shop.co'])(
    'refuses to put a URL-unsafe address in the delete path (%s)',
    async (email) => {
      expect(await removeResendContact(email)).toBe('failed');
      expect(mockRemove).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
    },
  );

  it('treats an unknown contact as already gone', async () => {
    mockRemove.mockResolvedValueOnce(fail({ name: 'not_found', message: 'Contact not found', statusCode: 404 }));
    expect(await removeResendContact('gone@shop.co')).toBe('missing');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reports failed and logs on the SDK-caught network failure shape (application_error, statusCode null)', async () => {
    mockRemove.mockResolvedValueOnce(
      fail({
        name: 'application_error',
        message: 'Unable to fetch data. The request could not be resolved.',
        statusCode: null,
      }),
    );
    expect(await removeResendContact('jane@shop.co')).toBe('failed');
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('reports failed and logs on any other error, and when the client throws (e.g. a malformed key)', async () => {
    mockRemove.mockResolvedValueOnce(fail({ name: 'application_error', message: 'boom', statusCode: 500 }));
    expect(await removeResendContact('jane@shop.co')).toBe('failed');
    mockRemove.mockRejectedValueOnce(new Error('Headers.append: invalid header value'));
    expect(await removeResendContact('jane@shop.co')).toBe('failed');
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});

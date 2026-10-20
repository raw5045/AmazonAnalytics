import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@/lib/env', () => ({
  env: {
    R2_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
    R2_BUCKET_NAME: 'test-bucket',
  },
}));

// A fake S3 client: send() resolves whatever the test queues, so what is under test is the stream
// wiring around the object body.
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mockSend;
  },
  GetObjectCommand: class {},
  PutObjectCommand: class {},
  DeleteObjectCommand: class {},
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));

import {
  buildUploadStorageKey,
  downloadStreamFromR2,
  isRetryableR2Error,
  R2StreamError,
} from './r2';

/** Starts a download whose object body the test drives by hand (write, end, destroy). */
async function download(opts?: { inactivityTimeoutMs?: number }) {
  const body = new PassThrough();
  mockSend.mockResolvedValueOnce({ Body: body });
  const stream = await downloadStreamFromR2('uploads/b/f/week.csv', opts);
  return { body, stream };
}

/** Resolves with the first 'error' the emitter emits (and is its listener). */
const firstError = (emitter: NodeJS.EventEmitter) =>
  new Promise<unknown>((resolve) => emitter.once('error', resolve));

describe('downloadStreamFromR2', () => {
  it('passes the body through and ends when the body ends', async () => {
    const { body, stream } = await download();
    body.write('a,b\n');
    body.end('1,2\n');

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);

    expect(Buffer.concat(chunks).toString()).toBe('a,b\n1,2\n');
  });

  it('forwards a body error (a socket reset) to the returned stream, and nothing escapes unhandled', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const { body, stream } = await download();
      const errored = firstError(stream);
      stream.resume();
      body.write('partial');
      const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      body.destroy(reset);

      await expect(errored).resolves.toBe(reset);
      await new Promise((resolve) => setImmediate(resolve));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('a body that goes silent errors the stream with an R2StreamError and destroys the body', async () => {
    const { body, stream } = await download({ inactivityTimeoutMs: 50 });
    const errored = firstError(stream);
    stream.resume();
    body.write('one chunk, then silence');

    const err = await errored;

    expect(err).toBeInstanceOf(R2StreamError);
    expect((err as R2StreamError).name).toBe('R2StreamError');
    expect((err as R2StreamError).message).toMatch(/^R2 stream uploads\/b\/f\/week\.csv inactive for 50ms$/);
    expect((err as R2StreamError).code).toBe('r2_stream_inactive');
    expect(body.destroyed).toBe(true);
  });
});

describe('isRetryableR2Error', () => {
  const withCode = (code: string) => Object.assign(new Error('x'), { code });
  const sdkError = (name: string, httpStatusCode?: number) =>
    Object.assign(new Error('x'), { name, $metadata: { httpStatusCode } });

  it.each<[string, unknown]>([
    ['the inactivity guard (R2StreamError)', new R2StreamError('R2 stream k inactive for 120000ms')],
    ['an R2StreamError-like error from another module copy', { name: 'R2StreamError', code: 'r2_stream_inactive' }],
    ['a socket reset (ECONNRESET)', withCode('ECONNRESET')],
    ['a socket timeout (ETIMEDOUT)', withCode('ETIMEDOUT')],
    ['a broken pipe (EPIPE)', withCode('EPIPE')],
    ['a refused connection (ECONNREFUSED)', withCode('ECONNREFUSED')],
    ['a DNS hiccup (EAI_AGAIN)', withCode('EAI_AGAIN')],
    ['a premature close (ERR_STREAM_PREMATURE_CLOSE)', withCode('ERR_STREAM_PREMATURE_CLOSE')],
    ['an R2 InternalError 500 on GetObject (2026-09-28)', sdkError('InternalError', 500)],
    ['ServiceUnavailable 503', sdkError('ServiceUnavailable', 503)],
    ['any other 5xx', sdkError('UnknownError', 502)],
    ['SlowDown (throttling)', sdkError('SlowDown')],
    ['the SDK TimeoutError', sdkError('TimeoutError')],
    ['the request-level abort (AbortError)', sdkError('AbortError')],
  ])('retries %s', (_label, e) => {
    expect(isRetryableR2Error(e)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['NoSuchKey 404', sdkError('NoSuchKey', 404)],
    ['AccessDenied 403', sdkError('AccessDenied', 403)],
    ['a plain Error', new Error('boom')],
    ['a Postgres error (unique violation)', withCode('23505')],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ECONNRESET'],
  ])('does not retry %s', (_label, e) => {
    expect(isRetryableR2Error(e)).toBe(false);
  });
});

describe('buildUploadStorageKey', () => {
  it('generates a key under uploads/<batchId>/<fileId>/<safe_filename>', () => {
    const key = buildUploadStorageKey({
      batchId: 'b-123',
      fileId: 'f-456',
      filename: 'US_Top_Search_Terms_Simple_Week_2026_04_18.csv',
    });
    expect(key).toBe(
      'uploads/b-123/f-456/US_Top_Search_Terms_Simple_Week_2026_04_18.csv',
    );
  });

  it('sanitizes dangerous filename characters', () => {
    const key = buildUploadStorageKey({
      batchId: 'b-1',
      fileId: 'f-1',
      filename: '../../../etc/passwd.csv',
    });
    expect(key).not.toContain('..');
    expect(key).toMatch(/^uploads\/b-1\/f-1\/[a-zA-Z0-9._-]+$/);
  });
});

import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { pipeline, Transform, type Readable } from 'node:stream';
import { env } from '@/lib/env';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

export async function uploadToR2(key: string, body: Buffer | Uint8Array, contentType: string) {
  await r2.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}

export async function getPresignedUploadUrl(key: string, contentType: string, expiresInSec = 900) {
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(r2, cmd, { expiresIn: expiresInSec });
}

export async function downloadFromR2(key: string): Promise<Buffer> {
  const result = await r2.send(
    new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }),
  );
  const chunks: Buffer[] = [];
  const stream = result.Body as NodeJS.ReadableStream;
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export interface UploadKeyInput {
  batchId: string;
  fileId: string;
  filename: string;
}

export function buildUploadStorageKey(input: UploadKeyInput): string {
  // Strip any path components (prevent directory traversal)
  const base = input.filename.split(/[\\/]/).pop() ?? 'upload.csv';
  // Keep only safe characters
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `uploads/${input.batchId}/${input.fileId}/${safe}`;
}

const R2_STREAM_INACTIVE = 'r2_stream_inactive';

/**
 * The error the inactivity guard destroys a download with. Its `code` lets the
 * import's COPY retry (and the logs) tell a stalled transfer from a bad row.
 */
export class R2StreamError extends Error {
  readonly code = R2_STREAM_INACTIVE;
  constructor(message: string) {
    super(message);
    this.name = 'R2StreamError';
  }
}

const RETRYABLE_CODES = new Set([
  R2_STREAM_INACTIVE,
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ERR_STREAM_PREMATURE_CLOSE',
]);
const RETRYABLE_SDK_NAMES = new Set([
  'InternalError',
  'ServiceUnavailable',
  'SlowDown',
  'TimeoutError',
  'AbortError',
]);

/**
 * True for a download failure worth retrying: the inactivity guard's
 * R2StreamError, a dropped, refused or timed-out socket, or an R2 5xx or
 * throttle (the 2026-09-28 import failed on an R2 InternalError 500 at
 * GetObject). False for what would fail the same way again: a missing key, a
 * 403, a bad row, a plain Error.
 */
export function isRetryableR2Error(e: unknown): boolean {
  if (e instanceof R2StreamError) return true;
  if (typeof e !== 'object' || e === null) return false;
  const { code, name, $metadata } = e as {
    code?: unknown;
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;
  const status = $metadata?.httpStatusCode;
  if (typeof status === 'number' && status >= 500) return true;
  return typeof name === 'string' && RETRYABLE_SDK_NAMES.has(name);
}

/**
 * Stream-level inactivity timeout. Destroys the stream with an R2StreamError
 * if no chunk arrives within `ms`. Catches the case where R2 returns a body but
 * the underlying TCP stream stalls mid-transfer — a real hang we observed
 * could not be distinguished from a hung Promise without this.
 */
class InactivityTimeout extends Transform {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly ms: number, private readonly label: string) {
    super();
    this.reset();
  }
  private reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.destroy(new R2StreamError(`${this.label} inactive for ${this.ms}ms`));
    }, this.ms);
  }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void) {
    this.reset();
    cb(null, chunk);
  }
  _flush(cb: (err?: Error | null) => void) {
    if (this.timer) clearTimeout(this.timer);
    cb();
  }
  _destroy(err: Error | null, cb: (err: Error | null) => void) {
    if (this.timer) clearTimeout(this.timer);
    cb(err);
  }
}

export interface DownloadStreamOptions {
  /** Max time to wait for the GetObject HTTP response (headers received). Default 120s. */
  requestTimeoutMs?: number;
  /** Max time to wait between chunks once the stream starts. Default 120s. */
  inactivityTimeoutMs?: number;
}

/**
 * Download an R2 object as a Readable stream, with both request-level and
 * stream-inactivity timeouts. Without these, a stalled R2 transfer would
 * silently hang the import indefinitely (no error event ever fires on
 * downstream consumers). Any failure — a stall (R2StreamError) or a body
 * error — arrives as an 'error' on the returned stream; isRetryableR2Error
 * says whether it is worth another attempt.
 */
export async function downloadStreamFromR2(
  key: string,
  opts: DownloadStreamOptions = {},
): Promise<Readable> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
  const inactivityTimeoutMs = opts.inactivityTimeoutMs ?? 120_000;

  const controller = new AbortController();
  const requestTimer = setTimeout(() => controller.abort(), requestTimeoutMs);

  let result;
  try {
    result = await r2.send(
      new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }),
      { abortSignal: controller.signal },
    );
  } finally {
    clearTimeout(requestTimer);
  }

  if (!result.Body) throw new Error(`R2 object has no body: ${key}`);

  // Run the body through the inactivity guard with pipeline, not .pipe():
  // .pipe() never forwards errors, so a body error (a socket reset) never
  // reached the consumer, and the guard's own timeout error had no listener
  // at all — an unhandled 'error' event that killed the worker mid-COPY on
  // 2026-10-19. pipeline forwards a body error to `guarded` and destroys the
  // body when the guard times out. The callback is a deliberate no-op: the
  // consumer sees the error on `guarded`.
  const guarded = new InactivityTimeout(inactivityTimeoutMs, `R2 stream ${key}`);
  pipeline(result.Body as Readable, guarded, () => undefined);
  return guarded;
}

/**
 * Delete an object from R2. Used by the cancel-batch flow to clean up
 * uploaded CSV files that should no longer exist. Returns true if the
 * delete succeeded (or the key didn't exist), false on hard error.
 */
export async function deleteFromR2(key: string): Promise<boolean> {
  if (!key) return true;
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
    return true;
  } catch (e) {
    console.warn('[r2] delete failed for', key, '-', (e as Error).message);
    return false;
  }
}

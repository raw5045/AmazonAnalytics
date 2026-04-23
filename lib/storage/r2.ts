import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

export async function downloadStreamFromR2(key: string): Promise<import('node:stream').Readable> {
  const result = await r2.send(new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
  return result.Body as import('node:stream').Readable;
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

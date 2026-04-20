import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

vi.mock('@/lib/storage/r2', async () => {
  const buf = readFileSync(path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'));
  return {
    downloadStreamFromR2: vi.fn().mockImplementation(async () => Readable.from(buf)),
    downloadFromR2: vi.fn().mockResolvedValue(buf),
    uploadToR2: vi.fn().mockResolvedValue('k'),
    getPresignedUploadUrl: vi.fn().mockResolvedValue('https://presigned.example/x'),
    buildUploadStorageKey: () => 'uploads/test/file.csv',
  };
});

import { db } from '@/db/client';
import { eq } from 'drizzle-orm';
import {
  users,
  uploadBatches,
  uploadedFiles,
  keywordWeeklyMetrics,
  reportingWeeks,
  stagingWeeklyMetrics,
  ingestionErrors,
} from '@/db/schema';
import { processFileValidation } from '@/inngest/functions/validate';
import { processFileImport } from '@/inngest/functions/importFile';

describe('ingestion flow (integration)', () => {
  let userId: string;
  let batchId: string;
  let fileId: string;

  beforeAll(async () => {
    const [user] = await db
      .insert(users)
      .values({ clerkUserId: `itest_${Date.now()}`, email: `itest_${Date.now()}@x.com` })
      .returning();
    userId = user.id;

    const [batch] = await db
      .insert(uploadBatches)
      .values({ batchType: 'single_csv', status: 'uploaded', totalFiles: 1, createdByUserId: userId })
      .returning();
    batchId = batch.id;

    const [file] = await db
      .insert(uploadedFiles)
      .values({
        batchId,
        storageKey: 'test/fake.csv',
        originalFilename: 'sample.csv',
        validationStatus: 'pending',
      })
      .returning();
    fileId = file.id;
  });

  afterAll(async () => {
    await db.delete(ingestionErrors).where(eq(ingestionErrors.uploadedFileId, fileId));
    await db.delete(stagingWeeklyMetrics).where(eq(stagingWeeklyMetrics.uploadedFileId, fileId));
    await db.delete(keywordWeeklyMetrics).where(eq(keywordWeeklyMetrics.sourceFileId, fileId));
    await db.delete(reportingWeeks).where(eq(reportingWeeks.sourceFileId, fileId));
    await db.delete(uploadedFiles).where(eq(uploadedFiles.id, fileId));
    await db.delete(uploadBatches).where(eq(uploadBatches.id, batchId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('validates, imports, and lands rows in keyword_weekly_metrics', async () => {
    const v = await processFileValidation({ uploadedFileId: fileId });
    expect(v.outcome).toBe('pass');

    const i = await processFileImport({ uploadedFileId: fileId });
    expect(i.rowsImported).toBeGreaterThan(90);

    const rows = await db.query.keywordWeeklyMetrics.findMany({
      where: eq(keywordWeeklyMetrics.sourceFileId, fileId),
    });
    expect(rows.length).toBeGreaterThan(90);

    const week = await db.query.reportingWeeks.findFirst({
      where: eq(reportingWeeks.sourceFileId, fileId),
    });
    expect(week?.isComplete).toBe(true);
  });
});

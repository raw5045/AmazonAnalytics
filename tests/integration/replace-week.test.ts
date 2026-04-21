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

describe('replace-week flow (integration)', () => {
  let userId: string;
  let batchId: string;
  let firstFileId: string;
  let secondFileId: string;

  beforeAll(async () => {
    const [user] = await db
      .insert(users)
      .values({ clerkUserId: `rw_${Date.now()}`, email: `rw_${Date.now()}@x.com` })
      .returning();
    userId = user.id;

    const [batch] = await db
      .insert(uploadBatches)
      .values({ batchType: 'single_csv', status: 'uploaded', totalFiles: 2, createdByUserId: userId })
      .returning();
    batchId = batch.id;

    const [f1] = await db
      .insert(uploadedFiles)
      .values({ batchId, storageKey: 'k1', originalFilename: 'a.csv', validationStatus: 'pending' })
      .returning();
    firstFileId = f1.id;

    const [f2] = await db
      .insert(uploadedFiles)
      .values({ batchId, storageKey: 'k2', originalFilename: 'b.csv', validationStatus: 'pending' })
      .returning();
    secondFileId = f2.id;
  });

  afterAll(async () => {
    // Clean up in FK-safe order. Scope deletes to this batch/files to avoid nuking other test data.
    await db.delete(ingestionErrors).where(eq(ingestionErrors.uploadedFileId, firstFileId));
    await db.delete(ingestionErrors).where(eq(ingestionErrors.uploadedFileId, secondFileId));
    await db.delete(stagingWeeklyMetrics).where(eq(stagingWeeklyMetrics.uploadedFileId, firstFileId));
    await db.delete(stagingWeeklyMetrics).where(eq(stagingWeeklyMetrics.uploadedFileId, secondFileId));
    await db.delete(keywordWeeklyMetrics).where(eq(keywordWeeklyMetrics.sourceFileId, firstFileId));
    await db.delete(keywordWeeklyMetrics).where(eq(keywordWeeklyMetrics.sourceFileId, secondFileId));
    await db.delete(reportingWeeks).where(eq(reportingWeeks.sourceFileId, firstFileId));
    await db.delete(reportingWeeks).where(eq(reportingWeeks.sourceFileId, secondFileId));
    await db.delete(uploadedFiles).where(eq(uploadedFiles.batchId, batchId));
    await db.delete(uploadBatches).where(eq(uploadBatches.id, batchId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('rejects second upload of same week and accepts after marking replacement', async () => {
    // First file: validate + import
    await processFileValidation({ uploadedFileId: firstFileId });
    await processFileImport({ uploadedFileId: firstFileId });

    // Second file (same week): validation should fail with WEEK_ALREADY_LOADED
    const v2 = await processFileValidation({ uploadedFileId: secondFileId });
    expect(v2.outcome).toBe('fail');
    const errs = await db.query.ingestionErrors.findMany({
      where: eq(ingestionErrors.uploadedFileId, secondFileId),
    });
    expect(errs.some((e) => e.code === 'WEEK_ALREADY_LOADED')).toBe(true);

    // Mark replacement + re-validate + import
    await db
      .update(uploadedFiles)
      .set({ isReplacement: true, replacesFileId: firstFileId })
      .where(eq(uploadedFiles.id, secondFileId));
    await db.delete(ingestionErrors).where(eq(ingestionErrors.uploadedFileId, secondFileId));

    const v3 = await processFileValidation({ uploadedFileId: secondFileId });
    expect(v3.outcome).toBe('pass');

    const i2 = await processFileImport({ uploadedFileId: secondFileId });
    expect(i2.rowsImported).toBeGreaterThan(90);

    // reporting_weeks should now point at the second file
    const week = await db.query.reportingWeeks.findFirst({
      where: eq(reportingWeeks.sourceFileId, secondFileId),
    });
    expect(week).toBeTruthy();

    // keyword_weekly_metrics rows should be from the second file
    const rows = await db.query.keywordWeeklyMetrics.findMany({
      where: eq(keywordWeeklyMetrics.sourceFileId, secondFileId),
    });
    expect(rows.length).toBeGreaterThan(90);
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

vi.mock('@/lib/storage/r2', async () => {
  const buf = readFileSync(
    path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'),
  );
  return {
    downloadFromR2: vi.fn().mockResolvedValue(buf),
    uploadToR2: vi.fn().mockResolvedValue('mocked-key'),
  };
});

import { db } from '@/db/client';
import { uploadBatches, uploadedFiles, schemaVersions, users } from '@/db/schema';
import { processRubricUpload } from '@/inngest/functions/rubric';
import { eq } from 'drizzle-orm';

describe('rubric flow (integration)', () => {
  let batchId: string;
  let fileId: string;
  let testUserId: string;
  let createdSchemaVersionId: string | undefined;

  beforeAll(async () => {
    // Create a test user for FK
    const [user] = await db
      .insert(users)
      .values({
        clerkUserId: `test_integration_${Date.now()}`,
        email: `integration_${Date.now()}@example.com`,
      })
      .returning();
    testUserId = user.id;

    const [batch] = await db
      .insert(uploadBatches)
      .values({
        batchType: 'single_csv',
        status: 'validating',
        totalFiles: 1,
        createdByUserId: testUserId,
      })
      .returning();
    batchId = batch.id;

    const [file] = await db
      .insert(uploadedFiles)
      .values({
        batchId,
        storageKey: 'test/fake.csv',
        originalFilename: 'valid-sample.csv',
        fileChecksum: 'abc123',
        validationStatus: 'pending',
      })
      .returning();
    fileId = file.id;
  });

  afterAll(async () => {
    // Clean up in FK-safe order: child rows -> schema version -> batch -> user
    await db.delete(uploadedFiles).where(eq(uploadedFiles.id, fileId));
    if (createdSchemaVersionId) {
      await db
        .delete(schemaVersions)
        .where(eq(schemaVersions.id, createdSchemaVersionId));
    }
    await db.delete(uploadBatches).where(eq(uploadBatches.id, batchId));
    await db.delete(users).where(eq(users.id, testUserId));
  });

  it('processes the real sample and creates a draft schema version', async () => {
    const result = await processRubricUpload({
      uploadedFileId: fileId,
      storageKey: 'test/fake.csv',
    });
    createdSchemaVersionId = result.schemaVersionId;
    expect(result.schemaVersionId).toBeTruthy();

    const version = await db.query.schemaVersions.findFirst({
      where: eq(schemaVersions.id, result.schemaVersionId),
    });
    expect(version?.status).toBe('draft');
    expect(version?.headerHash).toBeTruthy();
  });
});

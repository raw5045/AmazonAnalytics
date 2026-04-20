import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: {
    R2_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
    R2_BUCKET_NAME: 'test-bucket',
  },
}));

import { buildUploadStorageKey } from './r2';

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

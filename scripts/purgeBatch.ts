/**
 * One-off purge for a specific batch. Unlike the cancel endpoint, this one
 * will also tear down keyword_weekly_metrics rows and reporting_weeks entries
 * created by the (broken) importer — used to recover from the concurrency
 * bug that produced duplicate staging + zero-row imports in batch 8b20651d.
 *
 * Usage:   pnpm tsx scripts/purgeBatch.ts <batchId>
 * Safety:  refuses to run if env var BATCH_PURGE_CONFIRM !== 'yes'.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

async function main() {
  const batchId = process.argv[2];
  if (!batchId) {
    console.error('Usage: pnpm tsx scripts/purgeBatch.ts <batchId>');
    process.exit(1);
  }
  if (process.env.BATCH_PURGE_CONFIRM !== 'yes') {
    console.error('Refusing to run: set BATCH_PURGE_CONFIRM=yes to proceed.');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL!);

  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  const bucket = process.env.R2_BUCKET_NAME!;

  console.log(`\n=== PURGE BATCH ${batchId} ===\n`);

  const [batch] = await sql`SELECT * FROM upload_batches WHERE id = ${batchId}`;
  if (!batch) {
    console.error('Batch not found.');
    process.exit(1);
  }
  console.log('Batch status:', batch.status, '| created:', batch.created_at);

  const files = (await sql`SELECT id, storage_key, original_filename FROM uploaded_files WHERE batch_id = ${batchId}`) as Array<{
    id: string;
    storage_key: string | null;
    original_filename: string;
  }>;
  console.log(`Found ${files.length} file(s):`);
  for (const f of files) console.log(`  - ${f.id.slice(0, 8)} | ${f.original_filename}`);
  if (files.length === 0) {
    console.log('No files in batch — deleting batch row only.');
  }

  const fileIds = files.map((f) => f.id);

  // 1. Delete keyword_weekly_metrics rows that came from any file in this batch.
  //    Partitioned table; source_file_id FK not enforced as RESTRICT but we
  //    clean these before file rows so nothing is orphaned.
  if (fileIds.length > 0) {
    const [kwmBefore] = await sql`SELECT COUNT(*)::int AS c FROM keyword_weekly_metrics WHERE source_file_id = ANY(${fileIds}::uuid[])`;
    console.log(`\nkeyword_weekly_metrics rows to delete: ${kwmBefore.c.toLocaleString()}`);
    await sql`DELETE FROM keyword_weekly_metrics WHERE source_file_id = ANY(${fileIds}::uuid[])`;
    console.log('  ✓ kwm rows deleted');
  }

  // 2. Delete reporting_weeks entries pointing at these files.
  if (fileIds.length > 0) {
    const rw = await sql`SELECT week_end_date FROM reporting_weeks WHERE source_file_id = ANY(${fileIds}::uuid[])`;
    console.log(`reporting_weeks rows to delete: ${rw.length}`);
    for (const r of rw) console.log('  -', r.week_end_date);
    await sql`DELETE FROM reporting_weeks WHERE source_file_id = ANY(${fileIds}::uuid[])`;
    console.log('  ✓ reporting_weeks rows deleted');
  }

  // 3. Delete staging rows.
  if (fileIds.length > 0) {
    const [stBefore] = await sql`SELECT COUNT(*)::int AS c FROM staging_weekly_metrics WHERE uploaded_file_id = ANY(${fileIds}::uuid[])`;
    console.log(`staging_weekly_metrics rows to delete: ${stBefore.c.toLocaleString()}`);
    await sql`DELETE FROM staging_weekly_metrics WHERE uploaded_file_id = ANY(${fileIds}::uuid[])`;
    console.log('  ✓ staging rows deleted');
  }

  // 4. Delete ingestion_errors rows.
  if (fileIds.length > 0) {
    await sql`DELETE FROM ingestion_errors WHERE uploaded_file_id = ANY(${fileIds}::uuid[])`;
    console.log('  ✓ ingestion_errors deleted');
  }

  // 5. Delete R2 objects.
  console.log('\nDeleting R2 objects...');
  for (const f of files) {
    if (!f.storage_key) continue;
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: f.storage_key }));
      console.log(`  ✓ ${f.storage_key}`);
    } catch (e) {
      console.warn(`  ✗ ${f.storage_key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 6. Null out self-references (replaces_file_id) then delete file rows.
  if (fileIds.length > 0) {
    await sql`UPDATE uploaded_files SET replaces_file_id = NULL WHERE id = ANY(${fileIds}::uuid[])`;
    await sql`DELETE FROM uploaded_files WHERE batch_id = ${batchId}`;
    console.log('\n  ✓ uploaded_files deleted');
  }

  // 7. Delete the batch row itself.
  await sql`DELETE FROM upload_batches WHERE id = ${batchId}`;
  console.log('  ✓ upload_batches deleted');

  console.log(`\n=== PURGE COMPLETE ===`);
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});

/**
 * Fire the 'csv/batch.import-approved' Inngest event for a batch,
 * bypassing the UI. Same effect as clicking "Import valid files" on
 * the batch detail page.
 *
 * Used when the batch detail page is unloadable (e.g., 504 from a
 * slow kwm-count query). Required env: INNGEST_EVENT_KEY.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Inngest } from 'inngest';

async function main() {
  const batchId = process.argv[2];
  if (!batchId) {
    console.error('Usage: pnpm tsx scripts/fireImport.ts <batchId>');
    process.exit(1);
  }
  if (!process.env.INNGEST_EVENT_KEY) {
    console.error('INNGEST_EVENT_KEY not set in .env.local');
    process.exit(1);
  }

  const inngest = new Inngest({ id: 'amazon-sfr-analytics', name: 'Amazon SFR Analytics' });
  const result = await inngest.send({
    name: 'csv/batch.import-approved',
    data: { batchId },
  });
  console.log('Fired:', JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });

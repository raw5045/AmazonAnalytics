/**
 * Smoke-test the import-completion email pipeline by sending a sample
 * "success" email to all admins. Useful for:
 *   - Verifying RESEND_API_KEY works
 *   - Confirming the templates render right in your mail client
 *   - Verifying the recipient list resolves correctly
 *
 * Sends NO real data — uses mock metrics that look realistic.
 *
 * Override outcome via env: OUTCOME=failed pnpm tsx scripts/sendTestEmail.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

// Dynamic import after dotenv is loaded so env.ts's strict zod validation
// runs against fully-populated process.env.
async function main() {
  const { sendImportEmail } = await import('@/lib/notifications/sendImportEmail');

  const outcome = (process.env.OUTCOME ?? 'completed') as
    | 'completed'
    | 'completed_with_refresh_failure'
    | 'failed';
  console.log(`Sending sample "${outcome}" email to all admins...`);
  await sendImportEmail({
    outcome,
    filename: 'US_Top_Search_Terms_Simple_Week_2026_05_02.csv',
    batchId: 'fake-batch-id-for-test',
    durationMs: 30 * 60 * 1000 + 36_000,
    rowsImported: 3_094_002,
    rowsInSummary: 3_882_892,
    latestWeek: '2026-05-02',
    lastPhase: outcome === 'failed' ? 'kwm_insert' : undefined,
    errorMessage:
      outcome === 'completed' ? undefined : 'this is a sample error for testing',
  });
  console.log('Done. Check your inbox.');
}
main().catch((e) => { console.error(e); process.exit(1); });

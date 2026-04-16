import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { appSettings } from './schema';

const DEFAULT_SETTINGS = [
  { key: 'batch_failure_threshold_pct', valueJson: { value: 10 } },
  { key: 'unranked_comparison_value', valueJson: { value: 1000000 } },
  { key: 'row_count_anomaly_low_pct', valueJson: { value: 50 } },
  { key: 'row_count_anomaly_high_pct', valueJson: { value: 200 } },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set. Check .env.local at repo root.');
  }
  const client = neon(process.env.DATABASE_URL);
  const db = drizzle(client);
  for (const s of DEFAULT_SETTINGS) {
    await db.insert(appSettings).values(s).onConflictDoNothing({ target: appSettings.key });
  }
  console.log('Seeded app_settings');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

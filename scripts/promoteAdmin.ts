import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';

async function main() {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  if (!email) {
    console.error('INITIAL_ADMIN_EMAIL env var not set');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL env var not set');
    process.exit(1);
  }
  const client = neon(process.env.DATABASE_URL);
  const db = drizzle(client, { schema: { users } });
  const [updated] = await db
    .update(users)
    .set({ role: 'admin' })
    .where(eq(users.email, email))
    .returning();
  if (!updated) {
    console.error(`No user found with email ${email}. Sign in first to create the user row.`);
    process.exit(1);
  }
  console.log(`Promoted ${email} to admin`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

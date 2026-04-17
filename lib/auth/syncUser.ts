import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, type User } from '@/db/schema';

export interface SyncUserInput {
  clerkUserId: string;
  email: string;
  name?: string | null;
}

export async function syncUserFromClerk(input: SyncUserInput): Promise<User> {
  const existing = await db.query.users.findFirst({
    where: eq(users.clerkUserId, input.clerkUserId),
  });

  if (existing) {
    const [updated] = await db
      .update(users)
      .set({
        email: input.email,
        name: input.name ?? existing.name,
      })
      .where(eq(users.clerkUserId, input.clerkUserId))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(users)
    .values({
      clerkUserId: input.clerkUserId,
      email: input.email,
      name: input.name ?? null,
    })
    .returning();
  return created;
}

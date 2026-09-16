import { syncUserFromClerk, type SyncUserInput, type SyncUserResult } from './syncUser';
import { sendWelcomeEmail } from '@/lib/notifications/sendWelcomeEmail';
import { isUndeliverableEmail } from '@/lib/notifications/digest/recipients';

/**
 * Sync the app row for a Clerk user and, exactly once per user, send the
 * welcome email.
 *
 * Shared by the Clerk webhook (user.created / user.updated) and
 * getCurrentUser's on-demand path, so whichever one wins the race to insert
 * the row is the one that welcomes the member. `created` comes from the
 * atomic upsert, so webhook retries and the losing racer never send a
 * second email. The send is awaited (Vercel may freeze a function after its
 * response) but fail-soft by contract: a Resend hiccup never fails
 * provisioning.
 */
export async function provisionUser(input: SyncUserInput): Promise<SyncUserResult> {
  const result = await syncUserFromClerk(input);
  if (result.created && result.user.email && !isUndeliverableEmail(result.user.email)) {
    await sendWelcomeEmail({ to: result.user.email, name: result.user.name ?? null });
  }
  return result;
}

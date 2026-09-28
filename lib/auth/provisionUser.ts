import { after } from 'next/server';
import { syncUserFromClerk, type SyncUserInput, type SyncUserResult } from './syncUser';
import { sendWelcomeEmail } from '@/lib/notifications/sendWelcomeEmail';
import { addResendContact } from '@/lib/notifications/resendContacts';
import { isUndeliverableEmail } from '@/lib/notifications/digest/recipients';

export interface ProvisionOptions {
  /**
   * When to run the one-time signup side effects (welcome email, Resend
   * contact). 'inline' (default): await them — right for the webhook, whose
   * function may be frozen after it responds. 'after': schedule them with
   * next/server's after() so they run once the response is done — right for
   * the on-demand path, which sits inside a member's first page render and
   * must not wait on Resend.
   */
  sideEffects?: 'inline' | 'after';
}

/**
 * Sync the app row for a Clerk user and, once per user, run the signup side
 * effects: the welcome email and the Resend contact (segment membership for
 * broadcasts).
 *
 * Shared by the Clerk webhook (user.created / user.updated) and
 * getCurrentUser's on-demand path, so whichever one wins the race to insert
 * the row is the one that welcomes the member. `created` comes from the
 * atomic upsert, so webhook retries and the losing racer never send a second
 * email or add a second contact. Both side effects are fail-soft by contract
 * (one attempt; a Resend hiccup is logged, never retried, and never fails
 * provisioning) and independent of each other.
 */
export async function provisionUser(
  input: SyncUserInput,
  opts: ProvisionOptions = {},
): Promise<SyncUserResult> {
  if (!input.email) throw new Error('provisionUser: email is required');
  const result = await syncUserFromClerk(input);
  if (result.created && result.user.email && !isUndeliverableEmail(result.user.email)) {
    const email = result.user.email;
    const name = result.user.name ?? null;
    const onboard = async () => {
      await Promise.all([sendWelcomeEmail({ to: email, name }), addResendContact({ email, name })]);
    };
    if (opts.sideEffects === 'after') after(onboard);
    else await onboard();
  }
  return result;
}

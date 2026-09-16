import { after } from 'next/server';
import { syncUserFromClerk, type SyncUserInput, type SyncUserResult } from './syncUser';
import { sendWelcomeEmail } from '@/lib/notifications/sendWelcomeEmail';
import { isUndeliverableEmail } from '@/lib/notifications/digest/recipients';

export interface ProvisionOptions {
  /**
   * 'inline' (default): await the welcome send — right for the webhook, whose
   * function may be frozen after it responds. 'after': schedule the send with
   * next/server's after() so it runs once the response is done — right for
   * the on-demand path, which sits inside a member's first page render and
   * must not wait on Resend.
   */
  welcome?: 'inline' | 'after';
}

/**
 * Sync the app row for a Clerk user and, once per user, send the welcome
 * email.
 *
 * Shared by the Clerk webhook (user.created / user.updated) and
 * getCurrentUser's on-demand path, so whichever one wins the race to insert
 * the row is the one that welcomes the member. `created` comes from the
 * atomic upsert, so webhook retries and the losing racer never send a second
 * email. The send is fail-soft by contract (one attempt; a Resend hiccup is
 * logged, never retried, and never fails provisioning).
 */
export async function provisionUser(
  input: SyncUserInput,
  opts: ProvisionOptions = {},
): Promise<SyncUserResult> {
  if (!input.email) throw new Error('provisionUser: email is required');
  const result = await syncUserFromClerk(input);
  if (result.created && result.user.email && !isUndeliverableEmail(result.user.email)) {
    const to = result.user.email;
    const name = result.user.name ?? null;
    const send = () => sendWelcomeEmail({ to, name });
    if (opts.welcome === 'after') after(send);
    else await send();
  }
  return result;
}

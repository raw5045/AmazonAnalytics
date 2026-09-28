// lib/notifications/resendContacts.ts
import { Resend } from 'resend';
import { isUndeliverableEmail } from './digest/recipients';
import { isSyntheticTestEmail } from '@/lib/auth/syntheticEmail';

/**
 * Keep Resend's contact list in step with the app's members, so a broadcast
 * (product news, beta announcements) reaches everyone without a hand-exported
 * CSV.
 *
 * Resend's model: contacts are account-level ("Global Contacts") and grouped
 * into Segments (formerly Audiences — the SDK's `audiences` is a deprecated
 * alias). A new member becomes a contact in the segment named by
 * RESEND_SEGMENT_ID; a deleted member's contact is removed altogether (every
 * segment), because the account is gone.
 *
 * CONTRACT — fail-soft, like sendWelcomeEmail and bumpUserActivity: these
 * never throw. A Resend hiccup is logged and reported in the return value;
 * it must never fail provisioning, 500 the Clerk webhook into a Svix retry
 * loop, or slow a member's first page render. The add is exactly-once by
 * construction (provisionUser calls it only when its upsert inserted the
 * row), so a repeat is an anomaly rather than a retry — "already exists" is
 * benign, and nothing here retries.
 *
 * Feature switch: RESEND_SEGMENT_ID unset → every call is a silent no-op
 * (local dev, unit tests, preview). Consent is NOT synced in either
 * direction: a Resend unsubscribe and weekly_digest_subscribed are separate.
 *
 * No `import 'server-only'` — keep this importable everywhere, like the
 * other senders in this directory.
 */

export type AddContactResult = 'added' | 'exists' | 'skipped' | 'failed';
export type RemoveContactResult = 'removed' | 'missing' | 'skipped' | 'failed';

const LOG = '[resend contacts]';

/**
 * Split the app's single `users.name` ("Jane Doe") into Resend's first/last
 * fields: the first whitespace-separated token, then the rest. Broadcast
 * templates greet with {{{FIRST_NAME|there}}}, so the first name is what
 * matters; a one-word name has no last name.
 */
export function splitName(name: string | null | undefined): { firstName?: string; lastName?: string } {
  const tokens = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};
  const [firstName, ...rest] = tokens;
  return rest.length > 0 ? { firstName, lastName: rest.join(' ') } : { firstName };
}

/** Read at call time (not module load) so tests can stub and Vercel env edits apply per deploy. */
function settings(): { apiKey: string; segmentId: string } | null {
  const segmentId = process.env.RESEND_SEGMENT_ID;
  if (!segmentId) return null;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`${LOG} RESEND_SEGMENT_ID is set but RESEND_API_KEY is not — skipping`);
    return null;
  }
  return { apiKey, segmentId };
}

/** Never a real member: reserved test domains and the integration harness's synthetic users. */
function isNotAMember(email: string): boolean {
  return isUndeliverableEmail(email) || isSyntheticTestEmail(email);
}

export async function addResendContact(input: { email: string; name: string | null }): Promise<AddContactResult> {
  const cfg = settings();
  if (!cfg) return 'skipped';
  if (isNotAMember(input.email)) return 'skipped';
  try {
    const resend = new Resend(cfg.apiKey);
    const { error } = await resend.contacts.create({
      email: input.email,
      ...splitName(input.name),
      segments: [{ id: cfg.segmentId }],
    });
    if (!error) return 'added';
    // Resend documents no dedicated duplicate-contact error; a conflict status
    // or an "already exists" message is the closest signal, and a duplicate is
    // harmless here (the contact is already on the list).
    if (error.statusCode === 409 || /already exist/i.test(error.message)) {
      console.warn(`${LOG} contact already exists for ${input.email} — left as is`);
      return 'exists';
    }
    console.error(`${LOG} could not add ${input.email}:`, error);
    return 'failed';
  } catch (e) {
    console.error(`${LOG} add threw for ${input.email}:`, e);
    return 'failed';
  }
}

export async function removeResendContact(email: string): Promise<RemoveContactResult> {
  const cfg = settings();
  if (!cfg) return 'skipped';
  if (isNotAMember(email)) return 'skipped';
  try {
    const resend = new Resend(cfg.apiKey);
    const { error } = await resend.contacts.remove({ email });
    if (!error) return 'removed';
    if (error.name === 'not_found' || error.statusCode === 404) {
      console.warn(`${LOG} no contact to remove for ${email}`);
      return 'missing';
    }
    console.error(`${LOG} could not remove ${email}:`, error);
    return 'failed';
  } catch (e) {
    console.error(`${LOG} remove threw for ${email}:`, e);
    return 'failed';
  }
}

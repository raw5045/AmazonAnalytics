import { Webhook } from 'svix';
import { env } from '@/lib/env';
import { syncUserFromClerk } from '@/lib/auth/syncUser';
import { sendWelcomeEmail } from '@/lib/notifications/sendWelcomeEmail';
import { isUndeliverableEmail } from '@/lib/notifications/digest/recipients';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

interface ClerkEmailAddress {
  id: string;
  email_address: string;
}

interface ClerkUserData {
  id: string;
  email_addresses: ClerkEmailAddress[];
  primary_email_address_id: string;
  first_name?: string | null;
  last_name?: string | null;
}

interface ClerkSessionData {
  id: string;
  user_id: string;
}

type ClerkEvent =
  | { type: 'user.created' | 'user.updated' | 'user.deleted'; data: ClerkUserData }
  | { type: 'session.created'; data: ClerkSessionData };

function extractEmail(data: ClerkUserData): string {
  const primary = data.email_addresses.find((e) => e.id === data.primary_email_address_id);
  return primary?.email_address ?? data.email_addresses[0]?.email_address ?? '';
}

function extractName(data: ClerkUserData): string | null {
  const parts = [data.first_name, data.last_name].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

export async function POST(req: Request): Promise<Response> {
  const svixId = req.headers.get('svix-id');
  const svixTimestamp = req.headers.get('svix-timestamp');
  const svixSignature = req.headers.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response('Missing svix headers', { status: 400 });
  }

  const body = await req.text();
  const wh = new Webhook(env.CLERK_WEBHOOK_SIGNING_SECRET);

  let event: ClerkEvent;
  try {
    event = wh.verify(body, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as ClerkEvent;
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }

  // Wrap the DB sync: a Neon blip here would otherwise throw an unhandled 500
  // AFTER the signature already verified, leaving the account half-provisioned
  // (can sign in via Clerk, but no app row → no digests). Returning 500 makes
  // Clerk retry the webhook; logging the id aids triage.
  try {
    if (event.type === 'session.created') {
      // Sign-in stamp for the abuse digest. UPDATE matching zero rows (a
      // session for a user we don't know) is a silent no-op by design — an
      // unknown user must not 500 into a Svix retry loop. (A genuine DB
      // error still throws → 500 → retry, which is what we want.)
      await db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.clerkUserId, event.data.user_id));
    } else if (event.type === 'user.created' || event.type === 'user.updated') {
      const { user, created } = await syncUserFromClerk({
        clerkUserId: event.data.id,
        email: extractEmail(event.data),
        name: extractName(event.data),
      });
      // One-time welcome email, exactly once: only on the genuine first
      // insert (a webhook retry or user.updated takes the update path and
      // skips it). Awaited — Vercel may freeze the function after the
      // response, killing floating promises — but sendWelcomeEmail is
      // fail-soft by contract, so an email failure can't 500 this webhook
      // into a Svix retry loop.
      if (event.type === 'user.created' && created && user.email && !isUndeliverableEmail(user.email)) {
        await sendWelcomeEmail({ to: user.email, name: user.name ?? null });
      }
    } else if (event.type === 'user.deleted') {
      // FK cleanup on user delete (verified Batch 4): saved_views,
      // watchlist_items, weekly_digest_sends, custom_categories CASCADE and
      // weekly_digest_runs.triggered_by SETs NULL — so a REGULAR user deletes
      // cleanly. The 5 admin-provenance refs (audit_log, app_settings,
      // fake_volume_rules, upload_batches, schema_versions) are ON DELETE
      // RESTRICT by design (preserve history), so deleting an ADMIN who owns
      // such rows throws 23503 → caught below → 500 → Clerk retries. Accepted:
      // admins aren't deleted via Clerk in practice. Follow-up if that changes:
      // a set-null migration on those refs (upload_batches.created_by_user_id
      // is NOT NULL, so that one also needs its NOT NULL dropped).
      await db.delete(users).where(eq(users.clerkUserId, event.data.id));
    }
  } catch (e) {
    console.error(
      `[clerk webhook] DB sync failed for ${event.type} ${
        event.type === 'session.created'
          ? `clerkUserId=${event.data.user_id} sessionId=${event.data.id}`
          : `clerkUserId=${event.data.id}`
      }:`,
      e,
    );
    return new Response('DB sync failed', { status: 500 });
  }

  return new Response('ok', { status: 200 });
}

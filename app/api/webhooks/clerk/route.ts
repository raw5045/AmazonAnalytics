import { Webhook } from 'svix';
import { env } from '@/lib/env';
import { syncUserFromClerk } from '@/lib/auth/syncUser';
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

interface ClerkEvent {
  type: 'user.created' | 'user.updated' | 'user.deleted';
  data: ClerkUserData;
}

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
    if (event.type === 'user.created' || event.type === 'user.updated') {
      await syncUserFromClerk({
        clerkUserId: event.data.id,
        email: extractEmail(event.data),
        name: extractName(event.data),
      });
    } else if (event.type === 'user.deleted') {
      await db.delete(users).where(eq(users.clerkUserId, event.data.id));
    }
  } catch (e) {
    console.error(
      `[clerk webhook] DB sync failed for ${event.type} clerkUserId=${event.data.id}:`,
      e,
    );
    return new Response('DB sync failed', { status: 500 });
  }

  return new Response('ok', { status: 200 });
}

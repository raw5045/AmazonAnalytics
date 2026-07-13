// app/admin/abuse-digest/page.tsx
/**
 * Non-sending browser preview of the daily abuse-digest email, for any ET
 * day (?day=YYYY-MM-DD, default yesterday), plus a Send-now button that
 * force-sends the displayed day to all admins. Admin-gating is enforced by
 * app/admin/layout.tsx (requireAdmin).
 */
import Link from 'next/link';
import { etDay, previousEtDay } from '@/lib/activity/etDay';
import { loadAbuseDigestData } from '@/lib/notifications/abuseDigest/loadAbuseDigestData';
import { evaluateFlags } from '@/lib/notifications/abuseDigest/evaluateFlags';
import { buildAbuseDigestEmail } from '@/lib/notifications/abuseDigest/buildAbuseDigestEmail';
import { SendNowButton } from './SendNowButton';

export const dynamic = 'force-dynamic';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AbuseDigestPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  const sp = await searchParams;
  const yesterday = previousEtDay(new Date());
  const today = etDay(new Date());
  const day = sp.day && DAY_RE.test(sp.day) ? sp.day : yesterday;

  const stats = await loadAbuseDigestData(day);
  const flags = evaluateFlags(stats);
  const built = buildAbuseDigestEmail(stats, flags);

  return (
    <div>
      <h1 className="mb-2 text-xl font-semibold">Abuse digest</h1>
      <p className="mb-4 text-sm text-gray-600">
        Preview for <strong>{day}</strong> (ET). No email sent by viewing this page. The cron sends
        yesterday&apos;s digest at 7:30am ET daily.
      </p>
      <div className="mb-4 flex items-center gap-4 text-sm">
        <Link href={`/admin/abuse-digest?day=${yesterday}`} className="text-blue-700 underline">
          Yesterday ({yesterday})
        </Link>
        <Link href={`/admin/abuse-digest?day=${today}`} className="text-blue-700 underline">
          Today so far ({today})
        </Link>
        <SendNowButton day={day} />
      </div>
      <p className="mb-2 text-sm text-gray-600">
        Subject: <strong>{built.subject}</strong>
      </p>
      <div className="rounded border border-gray-200 bg-white p-2">
        <div dangerouslySetInnerHTML={{ __html: built.html }} />
      </div>
    </div>
  );
}

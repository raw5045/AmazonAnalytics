// app/admin/digests/preview/page.tsx
/**
 * Non-sending browser preview of the digest email. Renders the actual
 * email HTML for the current week. ?variant=watchlist uses the admin's
 * own watched keywords (falling back to a sample set if they watch none);
 * ?variant=broadcast renders the broadcast variant.
 */
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { buildDigestEmail } from '@/lib/notifications/digest/buildDigestEmail';
import { signUnsubToken } from '@/lib/notifications/digest/unsubToken';
import { loadWatchlistRowsByUser, getCurrentDigestWeek } from '@/lib/notifications/digest/loadDigestData';
import type { DigestKeywordRow } from '@/lib/notifications/digest/types';

export const dynamic = 'force-dynamic';

const SAMPLE_ROWS: DigestKeywordRow[] = [
  { searchTermId: 'sample-1', searchTermRaw: 'wireless earbuds', currentRank: 1204, priorWeekRank: 1520, rank4wAgo: 2100, improvement1w: 316, estMonthlyVolume: 45000 },
  { searchTermId: 'sample-2', searchTermRaw: 'airpods case', currentRank: 8910, priorWeekRank: 7200, rank4wAgo: 6800, improvement1w: -1710, estMonthlyVolume: 12000 },
  { searchTermId: 'sample-3', searchTermRaw: 'usb c cable', currentRank: null, priorWeekRank: 4000, rank4wAgo: 3900, improvement1w: null, estMonthlyVolume: null },
];

export default async function DigestPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string }>;
}) {
  const { variant } = await searchParams;
  const user = await requireAuthenticatedUser();
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://amazon-analytics-beta.vercel.app';
  const weekEndDate = (await getCurrentDigestWeek()) ?? '2026-01-01';
  const unsubscribeUrl = `${appUrl}/api/notifications/unsubscribe?token=${signUnsubToken(user.id)}`;

  let html: string;
  if (variant === 'broadcast') {
    html = buildDigestEmail({ variant: 'broadcast', weekEndDate, appUrl, unsubscribeUrl }).html;
  } else {
    const rowsByUser = await loadWatchlistRowsByUser([user.id]);
    const rows = rowsByUser.get(user.id) ?? [];
    html = buildDigestEmail({
      variant: 'watchlist',
      weekEndDate,
      appUrl,
      unsubscribeUrl,
      rows: rows.length > 0 ? rows : SAMPLE_ROWS,
    }).html;
  }

  return (
    <div>
      <p style={{ fontFamily: 'sans-serif', fontSize: 12, color: '#666', marginBottom: 16 }}>
        Preview — variant: <strong>{variant === 'broadcast' ? 'broadcast' : 'watchlist'}</strong>, week: <strong>{weekEndDate}</strong>. No email sent.
      </p>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// app/admin/digests/page.tsx
import { loadDigestWeeks, countSubscribedRecipients } from '@/lib/notifications/digest/loadDigestData';
import { SendDigestButton } from './SendDigestButton';

export const dynamic = 'force-dynamic';

const STALE_SENDING_MS = 15 * 60 * 1000;

/**
 * Whether a 'sending' run is stale (crashed past the 15-min mark) and so
 * resumable. Kept as a module-level helper (not inline in JSX) so the
 * impure Date.now() read isn't flagged by react-hooks/purity during the
 * server component's render — same pattern as ResultsTable's relative-time
 * formatter. The page is dynamic='force-dynamic', so it's evaluated fresh
 * each request.
 */
function isStaleSending(runStatus: string | null, startedAt: string | null): boolean {
  return (
    runStatus === 'sending' &&
    startedAt != null &&
    Date.now() - Date.parse(startedAt) > STALE_SENDING_MS
  );
}

export default async function AdminDigestsPage() {
  const weeks = await loadDigestWeeks();
  const recipientCount = await countSubscribedRecipients();
  const currentWeek = weeks.find((w) => w.isCurrent)?.weekEndDate ?? null;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">Weekly digests</h1>
      <p className="mt-2 text-gray-600">
        Send the weekly digest email to all subscribed users. Only the{' '}
        <strong>current</strong> week is sendable — its data is what the
        explorer currently shows. Prior weeks are frozen history.
      </p>
      {currentWeek && (
        <p className="mt-1 text-sm text-gray-500">
          Current week: <strong>{currentWeek}</strong>
        </p>
      )}

      <div className="mt-3 flex gap-3 text-sm">
        <a className="text-blue-700 underline" href="/admin/digests/preview?variant=watchlist" target="_blank" rel="noreferrer">
          Preview watchlist variant ▸
        </a>
        <a className="text-blue-700 underline" href="/admin/digests/preview?variant=broadcast" target="_blank" rel="noreferrer">
          Preview broadcast variant ▸
        </a>
      </div>

      <div className="mt-6 overflow-x-auto border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
            <tr>
              <th className="p-2">Week</th>
              <th className="p-2">Refresh</th>
              <th className="p-2">Digest status</th>
              <th className="p-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {weeks.map((w) => (
              <tr key={w.weekEndDate} className={w.isCurrent ? 'bg-blue-50/40' : ''}>
                <td className="p-2 font-mono">{w.weekEndDate}</td>
                <td className="p-2 text-gray-600">{w.isCurrent ? '✓ current' : '✓ complete'}</td>
                <td className="p-2">{digestStatusLabel(w.runStatus, w.recipientsCount, w.sentCount, w.failedCount)}</td>
                <td className="p-2">
                  {w.isCurrent ? (
                    <SendDigestButton
                      weekEndDate={w.weekEndDate}
                      runStatus={w.runStatus}
                      recipientCount={recipientCount}
                      isStaleSending={isStaleSending(w.runStatus, w.startedAt)}
                    />
                  ) : (
                    <span className="text-xs text-gray-400">data not current</span>
                  )}
                </td>
              </tr>
            ))}
            {weeks.length === 0 && (
              <tr><td colSpan={4} className="p-3 text-center text-gray-500">No completed weeks yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function digestStatusLabel(
  status: string | null,
  recipients: number | null,
  sent: number | null,
  failed: number | null,
): React.ReactNode {
  if (!status) return <span className="text-gray-500">Not sent</span>;
  if (status === 'sending') return <span className="text-blue-700">Sending…</span>;
  if (status === 'sent') return <span className="text-green-700">Sent · {sent ?? recipients ?? 0} recipients</span>;
  if (status === 'sent_with_failures') return <span className="text-amber-700">Sent · {sent ?? 0} ({failed ?? 0} failed)</span>;
  if (status === 'failed') return <span className="text-red-700">Failed</span>;
  return <span className="text-gray-500">{status}</span>;
}

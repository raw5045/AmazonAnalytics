import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { redirect } from 'next/navigation';
import { db } from '@/db/client';
import { keywordCurrentSummaryMeta } from '@/db/schema';
import { loadKeepaServiceOverview, type KeepaServiceOverview } from '@/lib/admin/keepaServiceOverview';
import { errFields } from '@/lib/ask/logSafe';
import { ServiceStatusCard } from './ServiceStatusCard';

export const dynamic = 'force-dynamic';

/**
 * The Keepa service's admin page (spec 2026-10-15 §5): the status card and nothing else. The old
 * import-time job's full-refresh button and run list went with the job (arc 11); the service refreshes
 * every tier-1 product on its own 7-day cycle. The route path stays /admin/keepa-enrichment.
 */
export default async function KeepaServiceAdminPage() {
  // Page-level gate, mirroring app/admin/ask-ai/page.tsx: Next 16 renders layouts and pages in
  // parallel, and a client-sent Next-Router-State-Tree can claim the /admin layout already ran, so
  // app/admin/layout.tsx's requireAdmin() is not a guaranteed gate on its own (vendored docs,
  // 01-app/02-guides/authentication.md, "Layouts and auth checks"). Checked here before any data read.
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer');
    throw e;
  }
  const [meta] = await db.select().from(keywordCurrentSummaryMeta).limit(1);
  // The status card is best-effort: a failed read degrades to one line on the card instead of taking
  // the page down. Coded fields only in the log, never a message.
  let overview: KeepaServiceOverview | null = null;
  let overviewError: string | null = null;
  try {
    overview = await loadKeepaServiceOverview(meta?.currentWeekEndDate ?? null);
  } catch (e) {
    const { error, code } = errFields(e);
    console.error('[keepa-admin] overview failed', JSON.stringify({ error, code }));
    overviewError = code ?? error;
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">Keepa service</h1>
      <p className="mt-2 text-gray-600">
        Refreshes every tier-1 product on a 7-day cycle and fetches new products usually within a day of each
        weekly import; the watcher emails when the service is down or stalled.
      </p>
      <ServiceStatusCard overview={overview} error={overviewError} now={new Date()} />
    </div>
  );
}

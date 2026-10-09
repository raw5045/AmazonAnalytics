/**
 * /products/<asin>: the ASIN page (spec 2026-10-09 §6), admin only (§10). Modelled on the keyword
 * page (app/(app)/explorer/keyword/[id]/page.tsx):
 *   1. Admin gate, then validate the [asin] param (cheap 404 path).
 *   2. Await ONLY loadProduct (one primary-key read, plus a keyword-side title read for a catalog
 *      row without a title) so the title band and the facts card paint fast.
 *   3. Stream the snapshot history (charts in a lazy recharts chunk) and the keywords table behind
 *      <Suspense>, each failing soft on its own (StreamedProductSections.tsx).
 */
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { neon } from '@neondatabase/serverless';
import { ExternalLink } from 'lucide-react';
import { env } from '@/lib/env';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { isAsin } from '@/lib/products/asin';
import { loadProduct, type ProductFacts as ProductPageFacts } from '@/lib/products/loadProduct';
import { neonRunner } from '@/lib/products/searchProducts';
import { BackToProducts } from './BackToProducts';
import { FactsCard, STATUS_LABEL } from './FactsCard';
import { HistorySkeleton } from './LazyHistoryCharts';
import { HistorySection, KeywordsSection, KeywordsSkeleton } from './StreamedProductSections';

export const metadata: Metadata = {
  title: 'Product detail',
};

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ asin: string }>;
  searchParams?: Promise<{ from?: string | string[] }>;
}) {
  // Page-level gate, as app/admin/keepa-enrichment/page.tsx does it, before any data read.
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer');
    throw e;
  }

  const { asin } = await params;
  if (!isAsin(asin)) notFound();

  const run = neonRunner(neon(env.DATABASE_URL));
  const facts = await loadProduct(run, asin);
  if (!facts) notFound();

  const sp = searchParams ? await searchParams : {};
  const from = Array.isArray(sp.from) ? sp.from[0] : sp.from;
  const badge = bandBadge(facts);

  return (
    <>
      {/* Navy title band, as on the keyword page. */}
      <div className="bg-gradient-to-r from-[#0B1E3A] via-[#0D2447] to-[#123B73] px-6 py-5 text-white">
        <div className="mx-auto max-w-6xl">
          <BackToProducts from={from} />
          <header className="mt-3">
            <h1 className="text-xl font-semibold leading-snug tracking-tight">{facts.title ?? facts.asin}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              {facts.brand && <span className="text-slate-200">{facts.brand}</span>}
              <span className="font-mono text-slate-400">{facts.asin}</span>
              {badge && <span className={`rounded-full px-3 py-1 text-xs font-medium ${badge.tone}`}>{badge.label}</span>}
              <a
                href={`https://www.amazon.com/dp/${facts.asin}`}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1.5 rounded-full border border-white/20 px-3 py-1 text-sm text-slate-300 transition hover:border-white/40 hover:text-white"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                View on Amazon
              </a>
            </div>
          </header>
        </div>
      </div>

      <div className="mx-auto max-w-6xl p-6">
        <FactsCard facts={facts} now={new Date()} />
        {/* A stub (keyword rows, no catalog row: usually an excluded category) has no history to show. */}
        {facts.inCatalog && (
          <Suspense fallback={<HistorySkeleton />}>
            <HistorySection run={run} asin={asin} fetched={facts.fetched} />
          </Suspense>
        )}
        <Suspense fallback={<KeywordsSkeleton />}>
          <KeywordsSection run={run} asin={asin} />
        </Suspense>
      </div>
    </>
  );
}

const TONE = {
  red: 'bg-red-400/15 text-red-200',
  amber: 'bg-amber-300/15 text-amber-200',
  slate: 'bg-white/10 text-slate-300',
} as const;

/** The title band's status chip: only for a state that changes how to read the page (none when active). */
function bandBadge(facts: ProductPageFacts): { label: string; tone: string } | null {
  if (!facts.inCatalog) return { label: 'Not in catalog', tone: TONE.slate };
  if (!facts.fetched) return { label: 'Not fetched yet', tone: TONE.slate };
  switch (facts.enrichmentStatus) {
    case 'delisted':
      return { label: STATUS_LABEL.delisted, tone: TONE.red };
    case 'no_price':
      return { label: STATUS_LABEL.no_price, tone: TONE.amber };
    case 'error':
      return { label: STATUS_LABEL.error, tone: TONE.amber };
    default:
      return null;
  }
}

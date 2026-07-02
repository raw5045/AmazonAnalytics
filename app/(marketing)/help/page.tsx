import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'How it works',
  description:
    'How KeywordQuarry works: SFR data, the top-3-clicked competition lens, estimated volume, fake-volume flags, custom categories, and the watchlist.',
};

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">
        How KeywordQuarry works
      </h1>
      <p className="mt-3 text-gray-600">
        A quick tour of the data and the three tools — and answers to the most
        common questions.
      </p>

      <Section title="What is SFR (Search Frequency Rank)?">
        <p>
          Amazon ranks every search term by how often shoppers search it —
          that&apos;s the Search Frequency Rank. Rank 1 is the most-searched
          term on Amazon; rank 100,000 is searched far less. Lower rank = more
          demand. KeywordQuarry tracks SFR weekly, so you can see demand
          rising or falling in days instead of months.
        </p>
      </Section>

      <Section title="The Explorer">
        <p>
          The Explorer is the core tool: search and filter roughly a million
          keywords by rank, estimated monthly volume, week-over-week movement,
          category, and competition. Set a demand floor, sort by the top-3
          review average, and the least-competitive keywords with real volume
          rise to the top. Click any keyword for its full history.
        </p>
      </Section>

      <Section title="The competition lens (top 3 clicked products)">
        <p>
          For every keyword, Amazon reports the three products shoppers
          actually clicked most. KeywordQuarry averages the reviews of those
          three products — not every listing on the page — so the number
          reflects what you&apos;d really compete against. Other tools average
          the whole results page, where irrelevant products with tens of
          thousands of reviews make winnable keywords look impossible.
        </p>
        <p>
          The Explorer also flags keywords where none of the top 3 products
          use the term in their title — open lanes that are much easier to
          rank for.
        </p>
      </Section>

      <Section title="Estimated monthly volume">
        <p>
          SFR is a rank, not a count. KeywordQuarry calibrates rank against
          real search-volume data to estimate monthly searches for every
          keyword, so you can think in units and revenue instead of abstract
          ranks. Treat estimates as directional (±~30%).
        </p>
      </Section>

      <Section title="Fake-volume flags">
        <p>
          Some keywords are artificially inflated by search and click bots.
          KeywordQuarry analyzes click and conversion patterns and flags
          suspicious keywords as warning or critical, and filters them out of
          your results by default — so you never build a launch on demand that
          isn&apos;t real.
        </p>
      </Section>

      <Section title="Category Builder">
        <p>
          Every keyword is mapped to its exact leaf category — not just
          “Health &amp; Household” but “Magnesium Supplements.” The Category
          Builder lets you combine any leaf categories into custom buckets, so
          the Explorer returns only keywords from the niches you care about.
        </p>
      </Section>

      <Section title="Watchlist + weekly digest">
        <p>
          Star any keyword to your watchlist. Every week, after fresh data
          lands, you get one email digest showing how your keywords moved —
          so a spike never slips past you.
        </p>
      </Section>

      <Section title="FAQ">
        <Faq q="How fresh is the data?">
          New data lands weekly. Most tools update monthly — that&apos;s the
          difference between catching a trend in days versus months.
        </Faq>
        <Faq q="Where does the data come from?">
          Amazon&apos;s own search and click data (Brand Analytics), enriched
          with product data. KeywordQuarry is not affiliated with Amazon.
        </Faq>
        <Faq q="What does it cost?">
          It&apos;s free during beta — see <Link href="/pricing" className="text-blue-700 underline">pricing</Link>.
        </Faq>
        <Faq q="Do I need a big catalog for this to be useful?">
          No — it&apos;s built for your first product as much as your
          hundredth. Filter to keywords that can move 10 units a day, or
          several hundred.
        </Faq>
        <Faq q="I have a question that isn't answered here.">
          <Link href="/contact" className="text-blue-700 underline">Contact us</Link> — we read everything.
        </Faq>
      </Section>

      <div className="mt-12 rounded-xl bg-gray-50 px-6 py-8 text-center">
        <p className="text-lg font-medium text-gray-900">
          The fastest way to learn it is to use it.
        </p>
        <Link
          href="/sign-up"
          className="mt-4 inline-block rounded-md bg-blue-600 px-6 py-3 text-base font-medium text-white hover:bg-blue-700"
        >
          Get started free
        </Link>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-gray-600">
        {children}
      </div>
    </section>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <p className="font-medium text-gray-900">{q}</p>
      <p className="mt-1">{children}</p>
    </div>
  );
}

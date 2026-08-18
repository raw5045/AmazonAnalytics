import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'How it works',
  description:
    'Video tutorials and reference guide: SFR data, the top-3-clicked competition lens, estimated volume, fake-volume flags, custom categories, and the watchlist.',
};

interface HelpVideo {
  id: string;
  title: string;
  duration: string;
}

const STEP_1_VIDEOS: HelpVideo[] = [
  { id: '7T6tAuwzU94', title: 'How the Keyword Explorer works', duration: '1:48' },
  { id: 'U4Mczif5gBY', title: 'How to use the keyword filter tool', duration: '2:36' },
  { id: 'FntaTH1RdzE', title: 'Individual keyword pages and the watchlist', duration: '4:23' },
];
const STEP_2_VIDEOS: HelpVideo[] = [
  { id: 'vwMGln3f3XU', title: 'How to use the Category Builder', duration: '3:26' },
];
const STEP_3_VIDEOS: HelpVideo[] = [
  { id: 'cQukMIfK4TI', title: 'Filtering for the least competitive keywords on Amazon', duration: '6:24' },
  { id: 'c34PfFexVx0', title: 'Filtering for high-demand keywords with a set number of reviews', duration: '8:19' },
  { id: 'JxNAMz-knvg', title: 'Filtering for keywords exploding in popularity', duration: '7:04' },
];

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">
        How KeywordQuarry works
      </h1>
      <p className="mt-3 text-gray-600">
        Seven short videos take you from first login to finding launch-ready
        keywords — about half an hour end to end.
      </p>

      <VideoStep
        step="Step 1 — Understand the data and learn your way around"
        intro="These three videos cover what data is inside KeywordQuarry and how to navigate it — what Search Frequency Rank is, what every column and filter means, and how individual keyword pages and the watchlist work."
        videos={STEP_1_VIDEOS}
      />
      <VideoStep
        step="Step 2 — Focus on your market"
        intro="Once you know your way around, narrow every search to your niche: build a custom category from exact leaf categories, or pick a broad department."
        videos={STEP_2_VIDEOS}
      />
      <VideoStep
        step="Step 3 — Now the fun part: dig for winners"
        intro="Three proven filtering recipes for finding amazing keywords on Amazon."
        videos={STEP_3_VIDEOS}
      />

      <div className="mt-14 border-t border-gray-200 pt-10">
        <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
          Quick reference
        </h2>
      </div>

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
          ranks. Treat estimates as directional (±~20%).
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

function VideoStep({
  step,
  intro,
  videos,
}: {
  step: string;
  intro: string;
  videos: HelpVideo[];
}) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold text-gray-900">{step}</h2>
      <p className="mt-3 text-[15px] leading-relaxed text-gray-600">{intro}</p>
      <div className="mt-5 space-y-6">
        {videos.map((v) => (
          <figure key={v.id} className="rounded-2xl border border-gray-200 bg-gray-50 p-4 shadow-sm sm:p-5">
            <figcaption className="mb-3 text-lg font-semibold text-gray-900">
              {v.title} <span className="text-sm font-normal text-gray-500">· {v.duration}</span>
            </figcaption>
            <div className="aspect-video overflow-hidden rounded-lg">
              <iframe
                className="h-full w-full"
                src={`https://www.youtube-nocookie.com/embed/${v.id}`}
                title={v.title}
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            </div>
          </figure>
        ))}
      </div>
    </section>
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

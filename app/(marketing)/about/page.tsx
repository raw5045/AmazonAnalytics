import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'About',
  description:
    'KeywordQuarry was built by Reese Wood, co-founder of Double Wood Supplements — a decade of keyword-first Amazon product research, turned into a tool.',
};

/** Owner-authored copy (KeywordQuarry_About_Page_Final_Draft.md, 2026-08-31) — edit the words there first, then mirror here. */

const TIMELINE = [
  {
    year: '2013',
    title: 'I Co-Founded Double Wood Supplements',
    body: (
      <p>
        My twin brother Evan and I co-founded Double Wood Supplements in 2013.
        I went on to build and lead the company’s Amazon channel for more than
        a decade.
      </p>
    ),
  },
  {
    year: '2019–2025',
    title: 'Seven Consecutive Inc. 5000 Appearances',
    body: (
      <>
        <p>
          Double Wood earned a place on the Inc. 5000 list of America’s
          fastest-growing private companies for seven consecutive years.
        </p>
        <p className="mt-2 text-sm text-gray-500">
          <span className="font-medium text-gray-700">Annual rankings:</span>{' '}
          No. 397 in 2019 · No. 367 in 2020 · No. 627 in 2021 · No. 1,319 in
          2022 · No. 2,063 in 2023 · No. 2,132 in 2024 · No. 2,188 in 2025.
        </p>
      </>
    ),
  },
  {
    year: '2021',
    title: '$25 Million in Revenue and the First Majority Investment',
    body: (
      <p>
        By 2021, Double Wood had reached $25 million in revenue. That year, a
        Boyne Capital affiliate acquired a majority interest in the company.
      </p>
    ),
  },
  {
    year: '2024',
    title: '400% Growth and Philadelphia Business Journal 40 Under 40',
    body: (
      <>
        <p>
          Over the three years following Boyne’s investment, Double Wood grew
          400% and became one of the 100 largest supplement companies in the
          United States.
        </p>
        <p className="mt-2">
          In 2024, I was also named a Philadelphia Business Journal 40 Under
          40 honoree.
        </p>
      </>
    ),
  },
  {
    year: '2026',
    title: 'A Second Private-Equity Transaction',
    body: (
      <>
        <p>In 2026, Boyne Capital sold Double Wood to Gryphon Investors.</p>
        <p className="mt-2">
          During the Boyne partnership, Double Wood expanded from roughly 50
          products to more than 150 and grew from a small three-person company
          into a global supplement brand.
        </p>
        <p className="mt-2">
          Recognizing underserved supplement markets and moving quickly on
          emerging demand was a defining part of Double Wood’s growth—the same
          demand-first principle that shaped our product-research process.
        </p>
      </>
    ),
  },
];

const QUESTIONS = [
  'How is Amazon search demand changing from week to week?',
  'How competitive are the three products shoppers actually click most for a given keyword?',
  'Are irrelevant listings making a market look more competitive than it really is?',
  'Does sudden growth represent durable demand or suspicious activity?',
  'Which high-demand keywords are missing from the titles of the top-clicked listings?',
  'Which exact Amazon leaf category contains the opportunity?',
];

const SOURCES = [
  {
    label: 'Reese Wood — 2024 Philadelphia Business Journal 40 Under 40 profile',
    href: 'https://www.bizjournals.com/philadelphia/c/40-under-40-get-to-know-the-2024-honorees/23731/reese-wood.html',
  },
  {
    label: 'Double Wood — official Inc. company profile',
    href: 'https://www.inc.com/profile/double-wood',
  },
  {
    label: 'Boyne Capital — 2021 majority-investment announcement',
    href: 'https://boynecapital.com/2021/01/28/news-boyne-capital-makes-new-platform-investment-in-double-wood-supplements/',
  },
  {
    label: 'Boyne Capital — 2026 sale to Gryphon Investors',
    href: 'https://boynecapital.com/2026/01/15/news-boyne-capital-announces-the-sale-of-double-wood/',
  },
  {
    label: 'Double Wood Supplements — About page',
    href: 'https://doublewoodsupplements.com/pages/about',
  },
];

function Principle({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-6 rounded-xl border-l-4 border-amber-400 bg-amber-50 px-6 py-4">
      <p className="text-[15px] font-semibold leading-relaxed text-gray-900">{children}</p>
    </div>
  );
}

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">
        About KeywordQuarry
      </h1>
      <p className="mt-2 text-lg text-gray-500">
        Built from more than a decade of Amazon operating experience
      </p>

      <div className="mt-8 space-y-4 text-[15px] leading-relaxed text-gray-600">
        <p>
          I’m Reese Wood, co-founder of Double Wood Supplements and founder of
          KeywordQuarry.
        </p>
        <p>
          My twin brother Evan and I founded Double Wood in 2013. I spent more
          than a decade building and leading its Amazon channel. The core
          principle behind our early product strategy was simple:
        </p>
      </div>

      <Principle>
        Start with the keywords. Find strong demand with relatively weak
        competition. Then build the product.
      </Principle>

      <div className="space-y-4 text-[15px] leading-relaxed text-gray-600">
        <p>
          Most sellers choose a product and then search for keywords that
          might support it. We reversed that process. We studied what Amazon
          shoppers were already searching for, looked for meaningful demand
          that remained underserved, developed products around that search
          intent, executed a repeatable launch strategy, and repeated the
          process across the portfolio.
        </p>
        <p>
          Keyword research identified the opportunities. Our launch process
          captured the rankings. Product quality and execution retained the
          sales. Repetition created the scale.
        </p>
      </div>

      <h2 className="mt-12 text-2xl font-semibold tracking-tight text-gray-900">
        The Track Record Behind KeywordQuarry
      </h2>
      <p className="mt-3 text-[15px] leading-relaxed text-gray-600">
        The experience behind KeywordQuarry comes from more than a decade
        spent building Double Wood Supplements and leading its Amazon channel.
      </p>

      <div className="mt-8 space-y-8 border-l-2 border-gray-200 pl-6">
        {TIMELINE.map((t) => (
          <div key={t.year} className="relative">
            <span
              aria-hidden
              className="absolute -left-[31px] top-1.5 h-2.5 w-2.5 rounded-full bg-amber-400"
            />
            <p className="text-sm font-semibold uppercase tracking-wide text-amber-600">
              {t.year}
            </p>
            <h3 className="mt-1 text-lg font-semibold text-gray-900">{t.title}</h3>
            <div className="mt-2 text-[15px] leading-relaxed text-gray-600">{t.body}</div>
          </div>
        ))}
      </div>

      <h2 className="mt-12 text-2xl font-semibold tracking-tight text-gray-900">
        Why I Built KeywordQuarry
      </h2>
      <div className="mt-3 space-y-4 text-[15px] leading-relaxed text-gray-600">
        <p>
          After stepping back from Double Wood’s day-to-day operations, I
          wanted a better way to perform the first and most important part of
          that process: finding and validating demand.
        </p>
        <p>
          Existing keyword tools often made it difficult to answer the
          questions I cared about:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          {QUESTIONS.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
        <p>KeywordQuarry was built around those questions.</p>
        <p>
          It tracks weekly Amazon search movement, measures competition using
          the three products shoppers actually click most, maps keywords to
          exact leaf categories, identifies title gaps, and flags patterns
          that may indicate artificial or distorted demand.
        </p>
        <p>
          KeywordQuarry does not replace judgment, product quality, launch
          execution, or inventory management. It gives Amazon operators better
          evidence before they commit capital, inventory, and time to a new
          product.
        </p>
      </div>

      <h2 className="mt-12 text-2xl font-semibold tracking-tight text-gray-900">
        The Idea Behind KeywordQuarry
      </h2>
      <Principle>
        Start with demand. Study the products winning the clicks. Find the
        gap. Build around customer intent.
      </Principle>
      <p className="text-[15px] leading-relaxed text-gray-600">
        That is the research process I spent more than a decade applying
        manually. KeywordQuarry makes it faster, more systematic, and easier
        to repeat.
      </p>

      <div className="mt-10 flex flex-wrap gap-4">
        <Link
          href="/sign-up"
          className="inline-block rounded-md bg-blue-600 px-6 py-3 text-base font-medium text-white hover:bg-blue-700"
        >
          Explore KeywordQuarry
        </Link>
        <Link
          href="/help"
          className="inline-block rounded-md border border-gray-300 px-6 py-3 text-base font-medium text-gray-700 hover:border-gray-400 hover:text-gray-900"
        >
          See How KeywordQuarry Works
        </Link>
      </div>

      <h2 className="mt-12 text-xl font-semibold tracking-tight text-gray-900">
        Sources &amp; Recognition
      </h2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-[15px] leading-relaxed">
        {SOURCES.map((s) => (
          <li key={s.href}>
            <a
              href={s.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-700 underline hover:text-blue-800"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>

      <div className="mt-10 space-y-3 rounded-xl border border-gray-200 bg-gray-50 px-6 py-5 text-sm leading-relaxed text-gray-600">
        <p>
          KeywordQuarry is independently owned and is not sponsored, endorsed,
          or operated by Double Wood Supplements. Reese Wood does not speak on
          behalf of Double Wood Supplements.
        </p>
        <p>
          KeywordQuarry is not affiliated with, endorsed by, or sponsored by
          Amazon.com, Inc. or its affiliates.
        </p>
      </div>
    </div>
  );
}

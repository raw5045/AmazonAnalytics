import type { Metadata } from 'next';
import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import {
  Check,
  X,
  Trophy,
  SlidersHorizontal,
  Flag,
  Rocket,
  Bell,
} from 'lucide-react';

export const metadata: Metadata = {
  title: {
    absolute: 'KeywordQuarry — Find high-demand, low-competition Amazon keywords',
  },
  description:
    'Spot rising Amazon demand in days, filter out fake volume, and zero in on the keywords barely anyone is competing over.',
};

const OTHER_TOOLS = [
  'Average reviews across every product on the page — including irrelevant ones — distorting how competitive a keyword really is',
  'Data updates monthly, with no easy way to spot changes or trends',
  'Fake, bot-inflated demand slips through',
  'Stop at broad categories like “Health & Personal Care”',
];

const KEYWORDQUARRY = [
  'Averages reviews from the top 3 clicked products, so you know exactly how competitive a keyword is',
  'Fresh data every week, with filters built to catch demand spikes in days',
  'Flags fake, bot-driven demand',
  'Maps keywords to exact leaf categories — and lets you build custom buckets',
];

const BENEFITS = [
  {
    icon: SlidersHorizontal,
    title: 'Advanced filtering system to sort keywords',
    body: 'Set a minimum demand, then sort by review count — non-competitive keywords with real search volume rise straight to the top.',
  },
  {
    icon: Flag,
    title: 'Spot easy ranking wins',
    body: 'Surface keywords none of the top 3 products even use in their title — open lanes you can rank for fast.',
  },
  {
    icon: Rocket,
    title: 'Perfect for new or experienced sellers',
    body: 'Target keywords that can move 10 units a day or several hundred — dial the demand to fit your first product or your fiftieth.',
  },
  {
    icon: Bell,
    title: 'Track it, get alerted',
    body: 'Star keywords to a watchlist and get a weekly email digest the moment they move.',
  },
];

export default async function HomePage() {
  const { userId } = await auth();
  if (userId) {
    // Signed-in visitors skip the marketing splash. Keep this destination in
    // sync with NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL / _AFTER_SIGN_UP_URL (both
    // '/app'), which Clerk reads from the env to land users right after auth.
    redirect('/app');
  }

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      {/* Hero */}
      <section className="py-16 text-center sm:py-24">
        <span className="inline-block rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
          Free during beta
        </span>
        <h1 className="mx-auto mt-5 max-w-3xl text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
          Find the high-demand, low-competition Amazon keywords your next
          launch needs.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-gray-600">
          Spot rising demand in days, filter out fake volume, and zero in on
          the keywords barely anyone is competing over.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link
            href="/sign-up"
            className="rounded-md bg-blue-600 px-6 py-3 text-base font-medium text-white hover:bg-blue-700"
          >
            Get started free
          </Link>
          <Link
            href="/help"
            className="rounded-md border border-gray-300 px-6 py-3 text-base font-medium text-gray-700 hover:bg-gray-50"
          >
            See how it works
          </Link>
        </div>
        <p className="mt-4 text-sm text-gray-500">
          No credit card. Set up in 2 minutes.
        </p>
      </section>

      {/* Comparison */}
      <section className="pb-4">
        <h2 className="text-center text-2xl font-semibold text-gray-900">
          Built differently, on purpose
        </h2>
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-gray-200 p-6">
            <p className="text-sm font-semibold text-gray-500">
              Other keyword tools
            </p>
            <ul className="mt-4 space-y-3">
              {OTHER_TOOLS.map((item) => (
                <li key={item} className="flex gap-2.5">
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden />
                  <span className="text-sm leading-relaxed text-gray-600">{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border-2 border-blue-500 p-6">
            <p className="text-sm font-semibold text-blue-700">KeywordQuarry</p>
            <ul className="mt-4 space-y-3">
              {KEYWORDQUARRY.map((item) => (
                <li key={item} className="flex gap-2.5">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" aria-hidden />
                  <span className="text-sm leading-relaxed text-gray-800">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Founder strip */}
        <div className="mt-4 flex items-center gap-4 rounded-xl bg-gray-50 px-6 py-5">
          <Trophy className="h-7 w-7 shrink-0 text-blue-600" aria-hidden />
          <p className="text-[15px] leading-relaxed text-gray-800">
            Built by an Amazon operator who spent 12+ years scaling a brand to{' '}
            <span className="font-semibold">$75M+ in Amazon sales</span> — with
            keyword research as the growth engine. Not theory from a software
            team: the exact methods, in a tool.
          </p>
        </div>
      </section>

      {/* Benefit boxes */}
      <section className="py-14">
        <h2 className="text-center text-2xl font-semibold text-gray-900">
          And it doesn&apos;t stop at finding them
        </h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {BENEFITS.map((b) => (
            <div key={b.title} className="rounded-xl border border-gray-200 p-6">
              <b.icon className="h-6 w-6 text-blue-600" aria-hidden />
              <h3 className="mt-3 text-base font-semibold text-gray-900">
                {b.title}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-600">
                {b.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Closing CTA */}
      <section className="border-t border-gray-200 py-16 text-center">
        <h2 className="text-2xl font-semibold text-gray-900">
          Your first product or your hundredth — start here.
        </h2>
        <Link
          href="/sign-up"
          className="mt-6 inline-block rounded-md bg-blue-600 px-6 py-3 text-base font-medium text-white hover:bg-blue-700"
        >
          Get started free
        </Link>
      </section>
    </div>
  );
}

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
  Sparkles,
  TrendingUp,
  ShieldAlert,
} from 'lucide-react';

/**
 * Landing page. Copy is LOCKED (approved 2026-07-01) — visual shell follows
 * the moz.com/moz-pro-free-trial reference the owner picked (2026-07-07):
 * deep-navy data-textured hero with one gold accent word + gold pill CTA,
 * floating product-UI illustration (pure CSS/SVG — no screenshot asset),
 * white feature bands with tinted icon circles, big-quote founder card, and
 * a gradient closing band. Navy header/footer live in ../layout.tsx.
 */

export const metadata: Metadata = {
  title: {
    absolute: 'KeywordQuarry — Find high-demand, low-competition Amazon keywords',
  },
  description:
    'Spot rising Amazon demand in days, filter out fake volume, and zero in on the keywords barely anyone is competing over.',
  openGraph: {
    title: 'KeywordQuarry — Find high-demand, low-competition Amazon keywords',
    description:
      'Spot rising Amazon demand in days, filter out fake volume, and zero in on the keywords barely anyone is competing over.',
    siteName: 'KeywordQuarry',
    type: 'website',
  },
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
    iconClass: 'bg-blue-100 text-blue-700',
    title: 'Advanced filtering system to sort keywords',
    body: 'Set a minimum demand, then sort by review count — non-competitive keywords with real search volume rise straight to the top.',
  },
  {
    icon: Flag,
    iconClass: 'bg-emerald-100 text-emerald-700',
    title: 'Spot easy ranking wins',
    body: 'Surface keywords none of the top 3 products even use in their title — open lanes you can rank for fast.',
  },
  {
    icon: Rocket,
    iconClass: 'bg-violet-100 text-violet-700',
    title: 'Perfect for new or experienced sellers',
    body: 'Target keywords that can move 10 units a day or several hundred — dial the demand to fit your first product or your fiftieth.',
  },
  {
    icon: Bell,
    iconClass: 'bg-amber-100 text-amber-700',
    title: 'Track it, get alerted',
    body: 'Star keywords to a watchlist and get a weekly email digest the moment they move.',
  },
];

const HERO_STATS = [
  { value: '4M+', label: 'keywords tracked' },
  { value: '52 weeks', label: 'of trend history' },
  { value: 'Weekly', label: 'data refresh' },
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
    <>
      {/* ================= Hero (deep navy, full-bleed) ================= */}
      <section className="relative overflow-hidden bg-[#0B1E3A]">
        {/* Texture: dot grid + soft glows, all decorative */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(148,163,184,0.14)_1px,transparent_0)] bg-[size:26px_26px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 right-[-10%] h-[480px] w-[480px] rounded-full bg-blue-600/25 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-[-30%] left-[-5%] h-[420px] w-[420px] rounded-full bg-sky-500/15 blur-3xl"
        />
        {/* Faint rising trend line across the hero */}
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-64 w-full opacity-[0.14]"
          viewBox="0 0 1200 260"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M0 220 L120 208 L240 214 L360 190 L480 198 L600 170 L720 178 L840 140 L960 118 L1080 70 L1200 30"
            stroke="#7DD3FC"
            strokeWidth="2.5"
            strokeDasharray="6 8"
          />
        </svg>

        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-14 sm:px-6 sm:pb-20 sm:pt-20">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
            {/* Left: locked hero copy */}
            <div className="text-center lg:text-left">
              <span className="inline-block rounded-full border border-amber-300/40 bg-amber-300/10 px-3.5 py-1 text-xs font-semibold tracking-wide text-amber-300">
                Free during beta
              </span>
              <h1 className="mt-6 text-balance text-4xl font-bold leading-[1.12] tracking-tight text-white sm:text-5xl">
                Find the <span className="whitespace-nowrap">high-demand,</span>{' '}
                <span className="whitespace-nowrap text-amber-300">low-competition</span>{' '}
                Amazon keywords your next launch needs.
              </h1>
              <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-slate-300 lg:mx-0">
                Spot rising demand in days, filter out fake volume, and zero in
                on the keywords barely anyone is competing over.
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-4 lg:justify-start">
                <Link
                  href="/sign-up"
                  className="rounded-full bg-amber-300 px-8 py-3.5 text-base font-semibold text-[#0B1E3A] shadow-lg shadow-amber-300/20 transition hover:bg-amber-200"
                >
                  Get started free
                </Link>
                <Link
                  href="/help"
                  className="rounded-full border border-slate-500/60 px-7 py-3.5 text-base font-medium text-slate-200 transition hover:border-slate-300 hover:text-white"
                >
                  See how it works
                </Link>
              </div>
              <p className="mt-5 text-sm text-slate-400">
                No credit card. Set up in 2 minutes.
              </p>
            </div>

            {/* Right: floating product-UI illustration (decorative) */}
            <div aria-hidden className="relative mx-auto hidden w-full max-w-md select-none lg:block">
              <Sparkles className="absolute -top-8 right-2 h-6 w-6 text-sky-300/80" />
              <Sparkles className="absolute -left-6 top-24 h-4 w-4 text-amber-300/70" />

              {/* Main card: mini keyword explorer */}
              <div className="rounded-2xl bg-white p-5 shadow-2xl shadow-blue-950/50">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-900">
                    Keyword Explorer
                  </p>
                  <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-[11px] font-medium text-blue-700">
                    This week
                  </span>
                </div>
                <div className="mt-4 space-y-2.5">
                  {[
                    { kw: 'collapsible ice bath tub', vol: '74,000', up: '+312%', reviews: '38 avg reviews' },
                    { kw: 'dog paw balm unscented', vol: '21,500', up: '+64%', reviews: '112 avg reviews' },
                    { kw: 'magnetic spice tins', vol: '9,800', up: '+41%', reviews: '57 avg reviews' },
                  ].map((r) => (
                    <div
                      key={r.kw}
                      className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50/70 px-3.5 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-gray-900">{r.kw}</p>
                        <p className="text-[11px] text-gray-500">{r.reviews}</p>
                      </div>
                      <div className="ml-3 shrink-0 text-right">
                        <p className="text-[13px] font-semibold tabular-nums text-gray-900">{r.vol}<span className="text-[10px] font-normal text-gray-500"> /mo</span></p>
                        <p className="text-[11px] font-medium text-emerald-600">{r.up}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Overlapping card: mini trend chart */}
              <div className="absolute -bottom-12 -left-10 w-56 rounded-2xl bg-white p-4 shadow-2xl shadow-blue-950/50">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 text-emerald-600" />
                  <p className="text-xs font-semibold text-gray-900">Demand pop</p>
                  <span className="ml-auto text-[10px] text-gray-400">52w</span>
                </div>
                <svg viewBox="0 0 200 64" className="mt-2 w-full" fill="none">
                  <path
                    d="M0 52 L18 50 L36 53 L54 47 L72 49 L90 44 L108 46 L126 38 L144 30 L162 20 L180 12 L200 6"
                    stroke="#16a34a"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M0 52 L18 50 L36 53 L54 47 L72 49 L90 44 L108 46 L126 38 L144 30 L162 20 L180 12 L200 6 L200 64 L0 64 Z"
                    fill="url(#heroChartFill)"
                  />
                  <defs>
                    <linearGradient id="heroChartFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#16a34a" stopOpacity="0.18" />
                      <stop offset="100%" stopColor="#16a34a" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>

              {/* Floating badge: fake volume flagged — hangs off the card's
                  bottom-right corner so it never covers the row numbers. */}
              <div className="absolute -bottom-5 -right-7 flex items-center gap-2 rounded-full bg-white px-3.5 py-2 shadow-xl shadow-blue-950/40">
                <ShieldAlert className="h-4 w-4 text-red-500" />
                <p className="text-xs font-semibold text-gray-800">
                  Fake volume <span className="text-red-500">flagged</span>
                </p>
              </div>
            </div>
          </div>

          {/* Stats strip */}
          <div className="mt-16 grid grid-cols-1 gap-6 border-t border-white/10 pt-8 sm:grid-cols-3 lg:mt-20">
            {HERO_STATS.map((s) => (
              <div key={s.label} className="text-center">
                <p className="text-2xl font-bold text-white">{s.value}</p>
                <p className="mt-1 text-sm text-slate-400">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= Comparison (white band) ================= */}
      <section className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <h2 className="text-center text-3xl font-bold tracking-tight text-gray-900">
            Built differently, on purpose
          </h2>
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-gray-200 bg-gray-50/60 p-7">
              <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                Other keyword tools
              </p>
              <ul className="mt-5 space-y-4">
                {OTHER_TOOLS.map((item) => (
                  <li key={item} className="flex gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-200">
                      <X className="h-3 w-3 text-gray-500" aria-hidden />
                    </span>
                    <span className="text-sm leading-relaxed text-gray-600">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="relative rounded-2xl bg-white p-7 shadow-xl shadow-blue-900/10 ring-2 ring-blue-600">
              <p className="text-sm font-semibold uppercase tracking-wide text-blue-700">
                KeywordQuarry
              </p>
              <ul className="mt-5 space-y-4">
                {KEYWORDQUARRY.map((item) => (
                  <li key={item} className="flex gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100">
                      <Check className="h-3 w-3 text-blue-700" aria-hidden />
                    </span>
                    <span className="text-sm leading-relaxed text-gray-800">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ================= Founder quote (tinted band) ================= */}
      <section className="bg-slate-50">
        <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
          <div className="relative rounded-3xl bg-white px-8 py-10 shadow-xl shadow-slate-200 sm:px-12">
            <span
              aria-hidden
              className="absolute -top-5 left-8 font-serif text-7xl leading-none text-amber-400"
            >
              &ldquo;
            </span>
            <p className="text-lg leading-relaxed text-gray-800 sm:text-xl">
              Built by an Amazon operator who spent 12+ years scaling a brand to{' '}
              <span className="font-semibold text-gray-900">$75M+ in Amazon sales</span>{' '}
              — with keyword research as the growth engine. Not theory from a
              software team: the exact methods, in a tool.
            </p>
            <div className="mt-6 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100">
                <Trophy className="h-5 w-5 text-amber-600" aria-hidden />
              </span>
              <p className="text-sm font-medium text-gray-500">
                Founder, KeywordQuarry
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ================= Benefits (white band) ================= */}
      <section className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <h2 className="text-center text-3xl font-bold tracking-tight text-gray-900">
            And it doesn&apos;t stop at finding them
          </h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            {BENEFITS.map((b) => (
              <div
                key={b.title}
                className="rounded-2xl border border-gray-100 bg-white p-7 shadow-lg shadow-slate-100 transition hover:-translate-y-0.5 hover:shadow-xl"
              >
                <span
                  className={`flex h-12 w-12 items-center justify-center rounded-full ${b.iconClass}`}
                >
                  <b.icon className="h-6 w-6" aria-hidden />
                </span>
                <h3 className="mt-4 text-lg font-semibold text-gray-900">
                  {b.title}
                </h3>
                <p className="mt-2 text-[15px] leading-relaxed text-gray-600">
                  {b.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= Closing CTA (gradient band) ================= */}
      <section className="bg-white">
        <div className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#123B73] via-[#1D4ED8] to-[#3B82F6] px-8 py-14 text-center shadow-2xl shadow-blue-900/30 sm:px-12">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.14)_1px,transparent_0)] bg-[size:24px_24px]"
            />
            <Sparkles aria-hidden className="absolute right-10 top-8 h-6 w-6 text-amber-300/80" />
            <h2 className="relative text-3xl font-bold tracking-tight text-white">
              Your first product or your hundredth — start here.
            </h2>
            <Link
              href="/sign-up"
              className="relative mt-8 inline-block rounded-full bg-amber-300 px-8 py-3.5 text-base font-semibold text-[#0B1E3A] shadow-lg shadow-blue-950/30 transition hover:bg-amber-200"
            >
              Get started free
            </Link>
            <p className="relative mt-4 text-sm text-blue-100">
              No credit card. Set up in 2 minutes.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}

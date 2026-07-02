# KeywordQuarry Marketing Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare `app/(marketing)/` splash with KeywordQuarry's 7-page public marketing/support/legal surface (Home, Help, Contact, About, Pricing, Terms, Privacy) per the approved spec `docs/superpowers/specs/2026-07-01-marketing-site-design.md`.

**Architecture:** All pages are server components in the existing `app/(marketing)/` route group, wrapped by a new shared marketing layout (nav + footer). Only `/` redirects signed-in users to `/app`; every other page is public for everyone. The contact form is the one interactive piece: a small client component posting to a new `/api/contact` route that emails all admin users via the existing Resend pattern. No DB changes, no migrations.

**Tech Stack:** Next.js App Router (THIS PROJECT'S VERSION — read `node_modules/next/dist/docs/01-app/` guides before writing code, per AGENTS.md), Tailwind, Clerk (`auth()` server-side), Resend, lucide-react (new dep, icons only).

**Conventions for every task:**
- Commit trailer (exact): `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Verify with `pnpm typecheck` before every commit. Full `pnpm lint` has 4 pre-existing `react-hooks/purity` errors in `app/(app)/explorer/page.tsx` (Date.now perf timing) — those are NOT yours; lint only the files you touched.
- Blue accent = the app's existing Tailwind blue (`blue-600`/`blue-700`); font = Geist (already global).
- Do NOT modify `middleware.ts` — it protects an explicit list (`/admin`, `/app`, `/explorer`, `/watchlist`, `/category-builder`); everything else is already public. Do NOT put a signed-in redirect in the marketing layout.

---

### Task 1: Rebrand root metadata + shared marketing layout

**Files:**
- Modify: `app/layout.tsx:16-22`
- Create: `app/(marketing)/layout.tsx`
- Modify: `package.json` (via `pnpm add lucide-react`)

- [ ] **Step 1: Add the icon dependency**

Run: `pnpm add lucide-react`
Expected: `+ lucide-react` in dependencies, lockfile updated.

- [ ] **Step 2: Rebrand root metadata**

In `app/layout.tsx`, replace the `metadata` export:

```tsx
export const metadata: Metadata = {
  title: {
    default: "KeywordQuarry",
    template: "%s · KeywordQuarry",
  },
  description:
    "Find high-demand, low-competition Amazon keywords. Weekly-fresh search data, fake-volume detection, and exact leaf-category mapping.",
};
```

- [ ] **Step 3: Create the marketing layout (nav + footer)**

Create `app/(marketing)/layout.tsx`:

```tsx
/**
 * Shared chrome for the public marketing/support/legal pages.
 *
 * Auth-aware CTA only — signed-in users see "Go to app", signed-out see
 * Sign in + Get started free. NO redirect here: /help, /terms, etc. must
 * render for everyone. The signed-in → /app redirect lives only in the
 * landing page (app/(marketing)/page.tsx).
 *
 * Mobile: the center nav links are hidden below `sm` (the footer carries
 * every link, so nothing is unreachable). A hamburger menu is deliberately
 * deferred to the Workstream D design pass.
 */
import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';

const NAV_LINKS = [
  { href: '/help', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
];

export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-gray-200">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="text-lg font-semibold tracking-tight text-gray-900">
            Keyword<span className="text-blue-600">Quarry</span>
          </Link>
          <div className="hidden items-center gap-6 sm:flex">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-sm text-gray-600 hover:text-gray-900"
              >
                {l.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {userId ? (
              <Link
                href="/app"
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Go to app
              </Link>
            ) : (
              <>
                <Link
                  href="/sign-in"
                  className="text-sm font-medium text-gray-700 hover:text-gray-900"
                >
                  Sign in
                </Link>
                <Link
                  href="/sign-up"
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Get started free
                </Link>
              </>
            )}
          </div>
        </nav>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-gray-200 bg-gray-50">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-4 sm:px-6">
          <div>
            <p className="text-base font-semibold text-gray-900">
              Keyword<span className="text-blue-600">Quarry</span>
            </p>
            <p className="mt-2 text-sm text-gray-600">
              Find the high-demand, low-competition Amazon keywords your next
              launch needs.
            </p>
          </div>
          <FooterCol
            title="Product"
            links={[
              { href: '/help', label: 'How it works' },
              { href: '/pricing', label: 'Pricing' },
            ]}
          />
          <FooterCol
            title="Company"
            links={[
              { href: '/about', label: 'About' },
              { href: '/contact', label: 'Contact' },
            ]}
          />
          <FooterCol
            title="Legal"
            links={[
              { href: '/terms', label: 'Terms of Service' },
              { href: '/privacy', label: 'Privacy Policy' },
            ]}
          />
        </div>
        <div className="border-t border-gray-200">
          <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6">
            <p className="text-xs text-gray-500">
              © {new Date().getFullYear()} KeywordQuarry. All rights reserved.
              KeywordQuarry is not affiliated with, endorsed by, or sponsored by
              Amazon.com, Inc. or its affiliates.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: { href: string; label: string }[];
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-gray-900">{title}</p>
      <ul className="mt-2 space-y-2">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="text-sm text-gray-600 hover:text-gray-900">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck`
Expected: clean (no output beyond the script banner).

- [ ] **Step 5: Commit**

```bash
git add app/layout.tsx "app/(marketing)/layout.tsx" package.json pnpm-lock.yaml
git commit -m "feat(marketing): rebrand to KeywordQuarry + shared marketing layout (nav/footer)"
```

---

### Task 2: Landing page (locked design + copy)

**Files:**
- Modify (full rewrite): `app/(marketing)/page.tsx`

Copy is LOCKED from the spec — do not editorialize. Keep the signed-in redirect exactly as-is.

- [ ] **Step 1: Rewrite the landing page**

Replace the entire contents of `app/(marketing)/page.tsx` with:

```tsx
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
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "app/(marketing)/page.tsx"
git commit -m "feat(marketing): KeywordQuarry landing page — hero, comparison, founder strip, benefits"
```

---

### Task 3: Help / How it works page

**Files:**
- Create: `app/(marketing)/help/page.tsx`

- [ ] **Step 1: Create the page**

```tsx
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
```

Note: when video walkthroughs exist (owner follow-up), this page gains an embedded video section and the landing's "See how it works" may deep-link to it.

- [ ] **Step 2: Verify + commit**

Run: `pnpm typecheck` → clean.

```bash
git add "app/(marketing)/help/page.tsx"
git commit -m "feat(marketing): Help / How it works page (tools guide + FAQ)"
```

---

### Task 4: About + Pricing pages

**Files:**
- Create: `app/(marketing)/about/page.tsx`
- Create: `app/(marketing)/pricing/page.tsx`

- [ ] **Step 1: Create About**

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'About',
  description:
    'KeywordQuarry was built by an Amazon operator who spent 12+ years scaling a brand to $75M+ in Amazon sales.',
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">
        About KeywordQuarry
      </h1>
      <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-gray-600">
        <p>
          KeywordQuarry was built by an Amazon operator who spent 12+ years
          scaling a brand to <span className="font-semibold text-gray-900">$75M+ in Amazon sales</span> —
          with keyword research as the growth engine behind every launch.
        </p>
        <p>
          Along the way, the same problems kept coming up with every keyword
          tool on the market: competition numbers distorted by irrelevant
          products, data that updates once a month, bot-inflated keywords that
          look like gold rushes, and categories too broad to be useful.
        </p>
        <p>
          KeywordQuarry is the tool that should have existed: weekly-fresh
          demand data, competition measured from the top 3 products shoppers
          actually click, fake volume flagged and filtered, and every keyword
          mapped to its exact leaf category. Not theory from a software team —
          the exact methods that built a real brand, in a tool.
        </p>
      </div>
      <div className="mt-10 rounded-xl border border-gray-200 bg-gray-50 px-6 py-5">
        <p className="text-sm leading-relaxed text-gray-600">
          KeywordQuarry is an independent product. It is not affiliated with,
          endorsed by, or sponsored by Amazon.com, Inc. or its affiliates.
          “Amazon” is a trademark of Amazon.com, Inc.
        </p>
      </div>
      <div className="mt-10">
        <Link
          href="/sign-up"
          className="inline-block rounded-md bg-blue-600 px-6 py-3 text-base font-medium text-white hover:bg-blue-700"
        >
          Get started free
        </Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create Pricing**

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { Check } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'KeywordQuarry is free during beta. Full access, no credit card.',
};

const INCLUDED = [
  'Full Keyword Explorer — every keyword, every filter',
  'Weekly-fresh data + 52 weeks of history',
  'Top-3-clicked competition lens + title-gap flags',
  'Fake-volume detection and filtering',
  'Exact leaf categories + custom category buckets',
  'Watchlist with weekly email digest',
];

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 text-center sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Pricing</h1>
      <p className="mt-3 text-gray-600">Simple, for now: everything is free while we're in beta.</p>

      <div className="mx-auto mt-10 max-w-md rounded-xl border-2 border-blue-500 p-8 text-left">
        <p className="text-sm font-semibold text-blue-700">Beta</p>
        <p className="mt-2 text-4xl font-semibold text-gray-900">
          Free
          <span className="ml-2 text-base font-normal text-gray-500">during beta</span>
        </p>
        <ul className="mt-6 space-y-3">
          {INCLUDED.map((item) => (
            <li key={item} className="flex gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" aria-hidden />
              <span className="text-sm leading-relaxed text-gray-700">{item}</span>
            </li>
          ))}
        </ul>
        <Link
          href="/sign-up"
          className="mt-8 block rounded-md bg-blue-600 px-6 py-3 text-center text-base font-medium text-white hover:bg-blue-700"
        >
          Get started free
        </Link>
        <p className="mt-3 text-center text-xs text-gray-500">No credit card required.</p>
      </div>

      <p className="mx-auto mt-8 max-w-md text-sm text-gray-500">
        Paid plans will arrive after beta. Beta users will always get clear
        notice before anything changes.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck` → clean.

```bash
git add "app/(marketing)/about/page.tsx" "app/(marketing)/pricing/page.tsx"
git commit -m "feat(marketing): About (founder story + Amazon disclaimer) and Pricing (beta stub) pages"
```

---

### Task 5: Terms of Service + Privacy Policy (scaffold)

**Files:**
- Create: `app/(marketing)/terms/page.tsx`
- Create: `app/(marketing)/privacy/page.tsx`

**LEGAL CAVEAT (put this comment at the top of BOTH files):** these are launch scaffolds with standard SaaS content and bracketed `[PLACEHOLDER]` markers for the legal entity/jurisdiction/contact. They are NOT legal advice; before real users the owner finalizes wording via a generator (Termly/iubenda/Termsfeed) or a lawyer. Keep the `[PLACEHOLDER]` markers visually obvious so they can't ship unnoticed.

Shared page shell for both: `max-w-3xl` prose-style layout, `Last updated: July 1, 2026`, numbered `<Section>` helper identical in shape to Task 3's.

- [ ] **Step 1: Create Terms** — `h1 "Terms of Service"` + sections (2–4 sentences each, plain language):
  1. **Acceptance** — using KeywordQuarry means agreeing to these terms; operated by `[COMPANY LEGAL NAME]`.
  2. **The service** — keyword research analytics derived from Amazon public/report data; provided as-is during beta; features may change.
  3. **Accounts** — accurate info, keep credentials safe, one person per account, 18+.
  4. **Acceptable use** — no scraping/bulk export/resale of the data, no reverse engineering, no abusive load, no unlawful use; we may suspend accounts that break this.
  5. **Intellectual property** — the service, software, and compiled datasets are ours or our licensors'; your own inputs (watchlists, custom categories) remain yours.
  6. **Third-party data & Amazon** — data derives from third-party sources including Amazon reports; **KeywordQuarry is not affiliated with, endorsed by, or sponsored by Amazon.com, Inc.**; accuracy not guaranteed.
  7. **Disclaimers** — no warranty; estimates (volume, competition) are directional; not business/financial advice; you make your own decisions.
  8. **Limitation of liability** — to the maximum extent permitted by law, no indirect/consequential damages; total liability capped at the greater of $100 or fees paid in the last 12 months.
  9. **Termination** — you may stop anytime; we may suspend/terminate for breach; some sections survive.
  10. **Changes** — we may update these terms; material changes notified via the service or email.
  11. **Governing law** — `[JURISDICTION]`.
  12. **Contact** — via the <Link href="/contact">contact page</Link>.

- [ ] **Step 2: Create Privacy** — `h1 "Privacy Policy"` + sections:
  1. **What we collect** — account info via Clerk (name, email); your in-app data (watchlists, saved views, custom categories); usage/logs; no payment data during beta.
  2. **How we use it** — provide/improve the service, send the emails you opt into (weekly digest), respond to support.
  3. **Processors we rely on** — bullet list: Clerk (authentication), Neon (database), Vercel (hosting), Railway (background jobs), Resend (email), Keepa (product data enrichment — no personal data shared).
  4. **Cookies** — auth/session cookies via Clerk; no advertising cookies.
  5. **Email** — weekly digest is opt-in/out; every email has one-click unsubscribe.
  6. **Retention & deletion** — kept while your account exists; deleting your account removes your personal data and your in-app data.
  7. **Your rights** — access/correct/delete via the <Link href="/contact">contact page</Link>; `[JURISDICTION-SPECIFIC RIGHTS — GDPR/CCPA AS APPLICABLE]`.
  8. **Children** — not directed at children under 16.
  9. **Changes** — material changes announced in-service or by email.
  10. **Controller / contact** — `[COMPANY LEGAL NAME]`, `[MAILING ADDRESS]`; via the contact page until a support address exists.

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck` → clean.

```bash
git add "app/(marketing)/terms/page.tsx" "app/(marketing)/privacy/page.tsx"
git commit -m "feat(marketing): Terms + Privacy scaffolds with placeholder markers (legal review pending)"
```

---

### Task 6: Contact page + form + /api/contact

**Files:**
- Create: `lib/contact/validate.ts` + `lib/contact/validate.test.ts`
- Create: `lib/notifications/sendContactEmail.ts`
- Create: `app/api/contact/route.ts`
- Create: `app/(marketing)/contact/page.tsx` + `app/(marketing)/contact/ContactForm.tsx`

Recipient = **all admin users** (same DB lookup as `lib/notifications/sendImportEmail.ts`) — no new env needed; sidesteps the not-yet-chosen support address. `replyTo` = the submitter, so admins reply directly.

- [ ] **Step 1: Write the failing validator test** — `lib/contact/validate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateContact } from './validate';

describe('validateContact', () => {
  const good = { name: 'Jane', email: 'jane@example.com', message: 'Hello, I have a question about the explorer.' };
  it('accepts a normal submission (trimmed)', () => {
    const r = validateContact({ ...good, name: '  Jane ' });
    expect(r).toEqual({ ok: true, input: { ...good, name: 'Jane' } });
  });
  it('rejects non-object', () => expect(validateContact(null).ok).toBe(false));
  it('rejects missing/empty name', () => expect(validateContact({ ...good, name: ' ' }).ok).toBe(false));
  it('rejects name > 100 chars', () => expect(validateContact({ ...good, name: 'x'.repeat(101) }).ok).toBe(false));
  it('rejects a malformed email', () => expect(validateContact({ ...good, email: 'not-an-email' }).ok).toBe(false));
  it('rejects message < 10 chars', () => expect(validateContact({ ...good, message: 'hi' }).ok).toBe(false));
  it('rejects message > 5000 chars', () => expect(validateContact({ ...good, message: 'x'.repeat(5001) }).ok).toBe(false));
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm exec vitest run lib/contact/validate.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `lib/contact/validate.ts`:

```ts
export interface ContactInput {
  name: string;
  email: string;
  message: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateContact(
  raw: unknown,
): { ok: true; input: ContactInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid payload' };
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  const email = typeof r.email === 'string' ? r.email.trim() : '';
  const message = typeof r.message === 'string' ? r.message.trim() : '';
  if (name.length === 0 || name.length > 100) return { ok: false, error: 'name must be 1–100 characters' };
  if (!EMAIL_RE.test(email) || email.length > 200) return { ok: false, error: 'enter a valid email address' };
  if (message.length < 10 || message.length > 5000) return { ok: false, error: 'message must be 10–5,000 characters' };
  return { ok: true, input: { name, email, message } };
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm exec vitest run lib/contact/validate.test.ts` → 7 passed.

- [ ] **Step 5: Sender** — `lib/notifications/sendContactEmail.ts` (mirrors `sendImportEmail.ts`'s resilience + admin lookup):

```ts
/**
 * Email a contact-form submission to all admin users via Resend.
 * Mirrors sendImportEmail's pattern: admin recipients from the DB, fail-soft
 * logging — but RETURNS success/failure so the API route can tell the
 * submitter whether their message actually went through.
 */
import { Resend } from 'resend';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { ContactInput } from '@/lib/contact/validate';

export async function sendContactEmail(input: ContactInput): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'onboarding@resend.dev';
  if (!apiKey) {
    console.warn('[sendContactEmail] RESEND_API_KEY not set — cannot deliver contact form.');
    return { sent: false, reason: 'email not configured' };
  }

  let recipients: string[] = [];
  try {
    const adminRows = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNotNull(users.email)));
    recipients = adminRows.map((r) => r.email).filter((e): e is string => !!e);
  } catch (e) {
    console.error('[sendContactEmail] admin lookup failed:', e);
    return { sent: false, reason: 'lookup failed' };
  }
  if (recipients.length === 0) return { sent: false, reason: 'no admin recipients' };

  const subject = `📨 Contact form: ${input.name}`;
  const text = `From: ${input.name} <${input.email}>\n\n${input.message}`;
  const html = `<p><strong>From:</strong> ${escapeHtml(input.name)} &lt;${escapeHtml(input.email)}&gt;</p><p style="white-space:pre-wrap">${escapeHtml(input.message)}</p>`;

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: recipients,
      replyTo: input.email,
      subject,
      text,
      html,
    });
    if (result.error) {
      console.error('[sendContactEmail] Resend error:', result.error);
      return { sent: false, reason: 'send failed' };
    }
    return { sent: true };
  } catch (e) {
    console.error('[sendContactEmail] send threw:', e);
    return { sent: false, reason: 'send failed' };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

Note: if this Resend SDK version types the reply field as `reply_to` instead of `replyTo`, typecheck will say so — use whichever compiles; the submitter's email is in the body either way.

- [ ] **Step 6: API route** — `app/api/contact/route.ts`:

```ts
/**
 * POST /api/contact — public contact form → email to all admins.
 * Spam guard: honeypot field `company` (hidden in the UI; bots fill it) →
 * pretend success without sending. Real rate-limiting is deferred with the
 * rest of the app's limiter work (see pre-launch roadmap).
 */
import { NextResponse } from 'next/server';
import { validateContact } from '@/lib/contact/validate';
import { sendContactEmail } from '@/lib/notifications/sendContactEmail';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (typeof body.company === 'string' && body.company.trim().length > 0) {
    return NextResponse.json({ ok: true }); // honeypot tripped — swallow silently
  }

  const v = validateContact(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const result = await sendContactEmail(v.input);
  if (!result.sent) {
    return NextResponse.json(
      { error: "Couldn't send your message right now — please try again later." },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 7: Contact page + form.** `app/(marketing)/contact/page.tsx` (server: `metadata` title `'Contact'`, h1 "Contact us", blurb "Questions, feedback, or a bug to report — send it over and we'll get back to you.", then `<ContactForm />`). `app/(marketing)/contact/ContactForm.tsx` (client):

```tsx
'use client';

import { useState } from 'react';

type Status = 'idle' | 'sending' | 'sent' | 'error';

export function ContactForm() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    setStatus('sending');
    setError(null);
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        setStatus('error');
        return;
      }
      setStatus('sent');
    } catch {
      setError('Network error — please check your connection and try again.');
      setStatus('error');
    }
  }

  if (status === 'sent') {
    return (
      <div className="rounded-xl bg-green-50 px-6 py-5 text-sm text-green-800">
        Message sent — we&apos;ll get back to you by email.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <input type="text" name="company" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
      <Field label="Your name">
        <input name="name" type="text" required maxLength={100} className="input" />
      </Field>
      <Field label="Email">
        <input name="email" type="email" required maxLength={200} className="input" />
      </Field>
      <Field label="Message">
        <textarea name="message" required minLength={10} maxLength={5000} rows={6} className="input" />
      </Field>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button
        type="submit"
        disabled={status === 'sending'}
        className="rounded-md bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
      >
        {status === 'sending' ? 'Sending…' : 'Send message'}
      </button>
      <style jsx>{`
        .input {
          width: 100%;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          padding: 8px 12px;
          font-size: 14px;
        }
        .input:focus {
          outline: 2px solid #3b82f6;
          outline-offset: -1px;
        }
      `}</style>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}
```

- [ ] **Step 8: Verify + commit**

Run: `pnpm typecheck` → clean. `pnpm exec vitest run lib/contact/validate.test.ts` → 7 passed.

```bash
git add lib/contact "app/(marketing)/contact" app/api/contact lib/notifications/sendContactEmail.ts
git commit -m "feat(marketing): contact page + form + /api/contact → Resend to admins (honeypot, replyTo)"
```

---

### Task 7: SEO — sitemap, robots

**Files:**
- Create: `app/sitemap.ts`
- Create: `app/robots.ts`

Before coding, skim `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/{sitemap,robots}.md` (per AGENTS.md). Base URL = `APP_PUBLIC_URL` with the same fallback string the email senders use.

- [ ] **Step 1: sitemap** — `app/sitemap.ts`:

```ts
import type { MetadataRoute } from 'next';

const BASE = process.env.APP_PUBLIC_URL ?? 'https://amazon-analytics-beta.vercel.app';

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ['', '/help', '/pricing', '/about', '/contact', '/terms', '/privacy'];
  return routes.map((path) => ({
    url: `${BASE}${path}`,
    lastModified: new Date(),
    changeFrequency: path === '' ? 'weekly' : 'monthly',
    priority: path === '' ? 1 : 0.6,
  }));
}
```

- [ ] **Step 2: robots** — `app/robots.ts`:

```ts
import type { MetadataRoute } from 'next';

const BASE = process.env.APP_PUBLIC_URL ?? 'https://amazon-analytics-beta.vercel.app';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/app', '/explorer', '/watchlist', '/category-builder', '/api'],
    },
    sitemap: `${BASE}/sitemap.xml`,
  };
}
```

- [ ] **Step 3: OpenGraph on the landing** — extend Task 2's `metadata` in `app/(marketing)/page.tsx` with:

```ts
  openGraph: {
    title: 'KeywordQuarry — Find high-demand, low-competition Amazon keywords',
    description:
      'Spot rising Amazon demand in days, filter out fake volume, and zero in on the keywords barely anyone is competing over.',
    siteName: 'KeywordQuarry',
    type: 'website',
  },
```

(OG image deferred — a branded card image lands with Workstream D.)

- [ ] **Step 4: Verify + commit**

Run: `pnpm typecheck` → clean. Then `pnpm build` → compiles, `/sitemap.xml` + `/robots.txt` appear in the route list.

```bash
git add app/sitemap.ts app/robots.ts "app/(marketing)/page.tsx"
git commit -m "feat(marketing): sitemap + robots + landing OpenGraph metadata"
```

---

### Task 8: Full verification + live browser pass

**Files:** none (verification only).

- [ ] **Step 1:** `pnpm typecheck` → clean. `pnpm test` → only the pre-existing `importFile.test.ts` DB-dependent failure (see Batch 4 notes); everything else green. `pnpm build` → succeeds; all 7 marketing routes listed.
- [ ] **Step 2:** `pnpm exec eslint` on every file created in Tasks 1–7 → 0 errors.
- [ ] **Step 3 (after deploy or on `pnpm dev`), walk the live pages:**
  - Signed OUT: `/` renders full landing (hero → comparison → founder → benefits → CTA); nav shows Sign in + Get started free; every nav/footer link resolves (help/pricing/about/contact/terms/privacy — all 200, no auth redirect).
  - Signed IN: `/` redirects to `/app`; `/help` etc. still render with "Go to app" in the nav.
  - Contact form: submit a real message → success state → email arrives to admin inbox (replyTo = submitter). Submit a 2-char message → inline error. (Honeypot can't be tested by hand — covered by code review.)
  - `/sitemap.xml` and `/robots.txt` respond correctly.
  - CTAs: "Get started free" → `/sign-up`; "See how it works" → `/help`.
- [ ] **Step 4:** Responsive spot-check on a real phone or DevTools device-mode (the session's Chrome tooling can't reflow — known limitation): nav collapses (links hidden, CTA visible), hero/comparison/benefits stack single-column.
- [ ] **Step 5:** No commit (or `docs:` notes commit if issues were found and fixed).

---

### Task 9 (asset-gated — do ONLY when the screenshot exists): Explorer proof section

**Files:**
- Add asset: `public/marketing/explorer.png` (owner-assisted capture: signed-in Explorer showing Avg reviews + IN #1/2/3 + Leaf category columns; crop the browser chrome; PNG ≥1400px wide)
- Modify: `app/(marketing)/page.tsx`

- [ ] **Step 1:** Place the asset at `public/marketing/explorer.png`.
- [ ] **Step 2:** In `app/(marketing)/page.tsx`, add below the founder strip:

```tsx
      {/* Product proof */}
      <section className="py-14">
        <h2 className="text-center text-2xl font-semibold text-gray-900">
          See the competition lens in action
        </h2>
        <p className="mx-auto mt-2 max-w-2xl text-center text-gray-600">
          Real keywords, weekly-fresh — with average reviews of the top 3
          clicked products and title-gap flags on every row.
        </p>
        <div className="mt-8 overflow-hidden rounded-xl border border-gray-200 shadow-sm">
          <Image
            src="/marketing/explorer.png"
            alt="KeywordQuarry Explorer showing keywords with top-3 review averages, title-gap checks, and leaf categories"
            width={1400}
            height={700}
            className="w-full"
          />
        </div>
      </section>
```

with `import Image from 'next/image';` added to the imports.

- [ ] **Step 3:** `pnpm typecheck` + visual check, then:

```bash
git add public/marketing/explorer.png "app/(marketing)/page.tsx"
git commit -m "feat(marketing): Explorer screenshot proof section on the landing page"
```

---

## Out of scope (tracked in the spec's Deferred list)

Custom domain wiring · ToS/Privacy legal finalization (placeholders MUST be resolved before real users) · video walkthroughs for "See how it works" · daily admin abuse-digest (separate feature, own brainstorm) · OG image + full brand system (Workstream D) · renaming `inngest/client.ts`'s internal app label (optional, dashboard-only).

## Self-review notes

- Spec coverage: 7 pages ✓, layout/nav/footer ✓, only-`/`-redirects ✓ (layout has none), middleware untouched-by-design ✓, contact→admins ✓, SEO ✓, locked landing copy carried verbatim ✓, legal caveat + placeholders ✓, screenshot + videos deferred per spec ✓.
- Type/name consistency: `validateContact`/`ContactInput` used identically in test, lib, route; `sendContactEmail` returns `{sent, reason}` and the route checks `.sent`; `Section`/`Faq`/`Field`/`FooterCol` are file-local (no cross-file imports).
- Known judgment calls baked in: lucide-react added (first icon dep — marketing needs non-emoji icons; tree-shakes small); founder strip includes "12+ years"; Resend `replyTo` field name may vary by SDK version (typecheck will catch; fallback documented).

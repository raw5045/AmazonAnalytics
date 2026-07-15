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
import { BrandMark } from '@/app/BrandMark';

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
      {/* Navy header — matches the landing hero canvas (Moz-style, 2026-07-07)
          and frames the white content pages consistently. */}
      <header className="bg-[#0B1E3A]">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight text-white">
            <BrandMark size={26} />
            <span>Keyword<span className="text-sky-400">Quarry</span></span>
          </Link>
          <div className="hidden items-center gap-6 sm:flex">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-sm text-slate-300 transition hover:text-white"
              >
                {l.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-4">
            {userId ? (
              <Link
                href="/app"
                className="rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-[#0B1E3A] transition hover:bg-amber-200"
              >
                Go to app
              </Link>
            ) : (
              <>
                <Link
                  href="/sign-in"
                  className="text-sm font-medium text-slate-200 transition hover:text-white"
                >
                  Sign in
                </Link>
                <Link
                  href="/sign-up"
                  className="rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-[#0B1E3A] transition hover:bg-amber-200"
                >
                  Get started free
                </Link>
              </>
            )}
          </div>
        </nav>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="bg-[#0B1E3A]">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-4 sm:px-6">
          <div>
            <p className="flex items-center gap-2 text-base font-semibold text-white">
              <BrandMark size={22} />
              <span>Keyword<span className="text-sky-400">Quarry</span></span>
            </p>
            <p className="mt-2 text-sm text-slate-400">
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
        <div className="border-t border-white/10">
          <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6">
            <p className="text-xs text-slate-500">
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
      <p className="text-sm font-semibold text-white">{title}</p>
      <ul className="mt-2 space-y-2">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="text-sm text-slate-400 transition hover:text-white">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

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

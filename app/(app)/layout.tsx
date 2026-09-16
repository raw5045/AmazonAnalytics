import { redirect } from 'next/navigation';
import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/AuthError';
import { watchlistCountForUser } from '@/lib/watchlist/loadServer';
import { TabNav } from './TabNav';
import { TutorialsBanner } from './_components/TutorialsBanner';
import { FeedbackButton } from './_components/FeedbackButton';
import { BrandMark } from '@/app/BrandMark';
import { AccountProblem } from '@/app/AccountProblem';

/**
 * Layout shared by /explorer/* and /watchlist/*.
 *
 * Owns: auth gate, top tab nav (Explorer | Watchlist), user info.
 * Inner explorer-only chrome (saved-views dropdown, save button) lives
 * in app/(app)/explorer/layout.tsx, one level deeper.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    if (e instanceof AuthError) {
      // A signed-in session with no resolvable app user must NOT go to
      // /sign-in — Clerk's widget bounces signed-in visitors back, and the
      // redirect loop that produced (2026-09-16) is exactly what this guards.
      if (e.code === 'UNPROVISIONABLE') return <AccountProblem message={e.message} />;
      redirect('/sign-in');
    }
    throw e;
  }

  // Kick off the badge COUNT(*) without awaiting — it streams into the nav
  // via <Suspense>, so it never blocks the page shell behind it. A failed
  // count just hides the badge instead of crashing the authed layout.
  const watchlistCountPromise = watchlistCountForUser(user.id).catch(() => 0);

  return (
    <div className="flex min-h-screen flex-col bg-[#F4F6FA]">
      {/* Navy brand bar (2026-07 reskin) — mirrors the marketing header so
          landing → app feels like one product. Active tab = amber underline. */}
      <header className="sticky top-0 z-30 flex h-[52px] items-center justify-between gap-4 bg-[#0B1E3A] px-6">
        <div className="flex h-full items-center gap-7">
          <Link href="/explorer" className="flex items-center gap-2 whitespace-nowrap text-[15px] font-bold tracking-tight text-white">
            <BrandMark size={24} />
            <span>Keyword<span className="text-sky-400">Quarry</span></span>
          </Link>
          <TabNav watchlistCountPromise={watchlistCountPromise} />
        </div>
        <div className="flex items-center gap-4 whitespace-nowrap text-sm text-slate-300">
          {user.role === 'admin' && (
            <Link href="/admin" className="text-sky-300 hover:text-sky-200">Admin</Link>
          )}
          {/* One-box feedback modal → support@ with the account email as
              reply-to and the current page attached (2026-09-15 spec). */}
          <FeedbackButton />
          {/* Contact-a-human path (form → support@ loop); learning lives in
              the Tutorials tab — deliberately distinct jobs. */}
          <Link href="/contact" className="text-slate-300 hover:text-white">Support</Link>
          <span className="hidden sm:inline text-xs text-slate-400">{user.email}</span>
          {/* Clerk avatar menu: Manage account + Sign out (sign-out lands on
              the marketing homepage via ClerkProvider afterSignOutUrl). */}
          <UserButton appearance={{ elements: { avatarBox: 'h-7 w-7' } }} />
        </div>
      </header>
      <TutorialsBanner />
      <main className="flex-1">{children}</main>
    </div>
  );
}

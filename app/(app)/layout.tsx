import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { watchlistCountForUser } from '@/lib/watchlist/loadServer';
import { TabNav } from './TabNav';

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
    if (e instanceof AuthError) redirect('/sign-in');
    throw e;
  }

  // One cheap COUNT(*) for the badge — page-level loaders will still
  // fetch the full list for per-row star state.
  const watchlistCount = await watchlistCountForUser(user.id);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 h-12 bg-white border-b px-6 flex items-center justify-between gap-4">
        <TabNav watchlistCount={watchlistCount} />
        <div className="text-sm text-gray-600 flex items-center gap-4 whitespace-nowrap">
          <span>{user.email}</span>
          {user.role === 'admin' && (
            <Link href="/admin" className="underline">Admin</Link>
          )}
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

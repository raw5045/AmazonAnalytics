import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { listSavedViewsForUser } from '@/lib/savedViews/loadServer';
import type { SavedView } from '@/lib/savedViews/types';
import { SavedViewsDropdown } from './SavedViewsDropdown';
import { SaveViewButton } from './SaveViewButton';

/**
 * Layout for /explorer and /explorer/keyword/*.
 *
 * Renders one unified sticky header containing:
 *   - "Keyword Explorer" home link (left)
 *   - SavedViewsDropdown + SaveViewButton (center)
 *   - user email + Admin link (right)
 *
 * Saved-views controls live here (rather than in page.tsx) so the
 * page title and the picker share a single bar instead of stacking
 * two redundant rows. The dropdown + save button are client
 * components that read `?view=` and current filters from URL via
 * useSearchParams — neither needs server-side searchParams access,
 * which layouts don't have.
 *
 * SaveViewButton hides itself on the detail page (where saving
 * filters has no meaning); the dropdown stays visible everywhere
 * so users can switch views from the detail page too.
 */
export default async function ExplorerLayout({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    if (e instanceof AuthError) redirect('/sign-in');
    throw e;
  }

  // Load saved views once at the layout level — passed to both the
  // dropdown (for the picker) and the save button (for the at-limit
  // tooltip). One DB query per request instead of two.
  const savedViews: SavedView[] = await listSavedViewsForUser(user.id);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 h-12 bg-white border-b px-6 flex items-center justify-between gap-4">
        <Link href="/explorer" className="text-lg font-semibold whitespace-nowrap">
          Keyword Explorer
        </Link>
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-72">
            <SavedViewsDropdown views={savedViews} />
          </div>
          <SaveViewButton savedViewsCount={savedViews.length} />
        </div>
        <div className="text-sm text-gray-600 flex items-center gap-4 whitespace-nowrap">
          <span>{user.email}</span>
          {user.role === 'admin' && (
            <Link href="/admin" className="underline">
              Admin
            </Link>
          )}
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

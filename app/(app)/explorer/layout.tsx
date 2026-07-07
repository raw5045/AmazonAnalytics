import { listSavedViewsForUser } from '@/lib/savedViews/loadServer';
import type { SavedView } from '@/lib/savedViews/types';
import { SavedViewsDropdown } from './SavedViewsDropdown';
import { SaveViewButton } from './SaveViewButton';
import { SavedViewsBar } from './SavedViewsBar';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';

/**
 * Inner layout for /explorer/*. The outer (app)/layout.tsx handles
 * auth + top-level tab nav; this layout owns the saved-views row.
 */
export default async function ExplorerLayout({ children }: { children: React.ReactNode }) {
  // Auth is already enforced by the parent (app) layout — we just need
  // the user to load saved views.
  const user = await requireAuthenticatedUser();
  const savedViews: SavedView[] = await listSavedViewsForUser(user.id);

  return (
    <>
      <SavedViewsBar>
        <div className="w-72">
          <SavedViewsDropdown views={savedViews} />
        </div>
        <SaveViewButton savedViewsCount={savedViews.length} />
      </SavedViewsBar>
      {children}
    </>
  );
}

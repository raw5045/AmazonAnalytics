import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db/client';
import { searchTerms } from '@/db/schema';
import { createCustomCategory, deleteCustomCategory, updateCustomCategory } from '@/lib/customCategories/commands';
import { loadCustomCategoryForUser } from '@/lib/customCategories/loadServer';
import { defaultCategoryDeps, resolveScope } from '@/lib/research/categories';
import { createSavedView, deleteSavedView, updateSavedView } from '@/lib/savedViews/commands';
import { addToWatchlist, removeFromWatchlist } from '@/lib/watchlist/commands';
import { listWatchlistWithKeywords } from '@/lib/watchlist/loadServer';
import { createTestUser, deleteTestUser } from './helpers';

// Run: RUN_INTEGRATION=1 pnpm vitest run tests/integration/workspaceCommands.test.ts
// Real tables, one synthetic itest user, every row removed in afterAll (users cascade to
// saved_views, custom_categories and watchlist_items). Spec 2026-09-30 §11.9 / plan Task 13.
describe('workspace commands (integration, real Postgres)', () => {
  let userId: string | undefined;
  beforeAll(async () => {
    userId = (await createTestUser('itest')).id;
  });
  afterAll(async () => {
    await deleteTestUser(userId);
  });

  it('saved views: create, duplicate, rename, delete, delete again', async () => {
    const created = await createSavedView(userId!, { name: 'itest view', filters: { q: 'lamp' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.view.filters.q).toBe('lamp');
    expect(await createSavedView(userId!, { name: 'itest view', filters: {} })).toMatchObject({ ok: false, code: 'duplicate_name' });
    expect(await updateSavedView(userId!, created.view.id, { name: 'itest view 2' })).toMatchObject({ ok: true, view: { name: 'itest view 2' } });
    expect(await deleteSavedView(userId!, created.view.id)).toEqual({ ok: true, deleted: { id: created.view.id, name: 'itest view 2' } });
    expect(await deleteSavedView(userId!, created.view.id)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('custom categories: create from a real catalog expansion, load, update, delete', async () => {
    const catalog = await defaultCategoryDeps.loadCatalog();
    const leaf = catalog.entries.find((e) => e.terminal)!;
    const scope = await resolveScope(userId!, { selections: [{ kind: 'taxonomy', path: leaf.path, includeDescendants: false }], leafPaths: [] }, 12000, defaultCategoryDeps);
    const created = await createCustomCategory(userId!, { name: 'itest category', leafPaths: scope.leaves });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.category.leafPaths).toEqual([leaf.path]);
    // The only real-database check of the lower(name) unique index → 23505 → duplicate_name chain (case-insensitive).
    expect(await createCustomCategory(userId!, { name: 'ITEST Category', leafPaths: [leaf.path] })).toMatchObject({ ok: false, code: 'duplicate_name' });
    expect(await loadCustomCategoryForUser(userId!, created.category.id)).toMatchObject({ name: 'itest category' });
    expect(await updateCustomCategory(userId!, created.category.id, { leafPaths: [leaf.path, 'Zed › Extra'] })).toMatchObject({ ok: true, category: { leafPaths: [leaf.path, 'Zed › Extra'] } });
    expect(await deleteCustomCategory(userId!, created.category.id)).toEqual({ ok: true, deleted: { id: created.category.id, name: 'itest category', leafCount: 2 } });
  });

  it('watchlist: add by text and id, list with keyword text, remove', async () => {
    const [kw] = await db.select({ id: searchTerms.id, raw: searchTerms.searchTermRaw }).from(searchTerms).limit(1);
    const added = await addToWatchlist(userId!, { keywords: [kw.raw, 'zzz no such keyword itest'], searchTermIds: [kw.id] });
    expect(added).toEqual({ added: 1, alreadyWatching: 0, unmatched: ['zzz no such keyword itest'], skippedAtCap: 0 });
    expect(await listWatchlistWithKeywords(userId!)).toEqual([{ keywordId: kw.id, keyword: kw.raw, addedAt: expect.any(String) }]);
    expect(await removeFromWatchlist(userId!, { keywords: [], searchTermIds: [kw.id] })).toEqual({ removed: 1, notWatching: 0, unmatched: [] });
    expect(await listWatchlistWithKeywords(userId!)).toEqual([]);
  });
});

# Category Builder Lazy-Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop shipping the entire 808 KB category tree to the browser on every `/category-builder` load. Send only the ~30 top departments (~3 KB), and fetch each drill-down level (and "Add all" leaf lists) on demand from small API routes backed by the already-cached server-side tree.

**Architecture:** The full tree stays server-side (`loadCategoryTree()`, `unstable_cache`). Two pure helpers expose one level (`childrenAtPath`) or all leaves under a path (`leavesAtPath`). Two GET routes wrap them. The page passes only the root level; `CategoryBuilderClient` fetches deeper levels on drill-down and caches them client-side, and routes "Add" through the leaves endpoint.

**Tech Stack:** Next 16 App Router (route handlers + server/client components), Vitest. Measured: 12,029 leaves, 14,739 nodes, 30 departments, depth 9, **808 KB** payload today.

---

## API shapes (eyeball these)

Path param encoding: the drill path is the node's ancestor names joined by ` › ` (the existing `PATH_SEP`), URL-encoded. Empty/missing → root.

- **`GET /api/category-builder/tree?path=<names joined by " › ">`**
  → `200 { "children": [ { "name": string, "hasChildren": boolean, "terminal": boolean }, … ] }`
  (the immediate children of the node at `path`; root departments when `path` is empty; `{ "children": [] }` if the path doesn't resolve)

- **`GET /api/category-builder/leaves?path=<names joined by " › ">`**
  → `200 { "leaves": string[] }`
  (all terminal leaf names under `path`, deduped + locale-sorted — for "Add" / "Add all of X")

`LightNode = { name: string; hasChildren: boolean; terminal: boolean }` is the only tree data the client ever holds per level.

---

## File Structure

**Created:**
- `lib/categoryBuilder/treeNav.ts` — `LightNode`, `childrenAtPath`, `leavesAtPath`, `parsePathParam`.
- `lib/categoryBuilder/treeNav.test.ts` — unit tests.
- `app/api/category-builder/tree/route.ts` — drill-down level endpoint.
- `app/api/category-builder/leaves/route.ts` — leaves-under-path endpoint.

**Modified:**
- `app/(app)/category-builder/page.tsx` — pass `rootLevel` (LightNodes) instead of the full `tree`.
- `app/(app)/category-builder/CategoryBuilderClient.tsx` — fetch-on-drill + per-level client cache; async "Add".

---

## Task 1: Pure tree-nav helpers (TDD)

**Files:** Create `lib/categoryBuilder/treeNav.ts`, `lib/categoryBuilder/treeNav.test.ts`.

- [ ] **Step 1: Write failing tests** in `lib/categoryBuilder/treeNav.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildTree } from './buildTree';
import { childrenAtPath, leavesAtPath, parsePathParam } from './treeNav';

const tree = buildTree([
  'Books › Fiction',
  'Books › Nonfiction › History',
  'Books › Nonfiction', // makes "Nonfiction" terminal AND a parent
  'Electronics',
]);

describe('parsePathParam', () => {
  it('null/empty → []', () => {
    expect(parsePathParam(null)).toEqual([]);
    expect(parsePathParam('')).toEqual([]);
  });
  it('splits on the " › " separator and trims blanks', () => {
    expect(parsePathParam('Books › Nonfiction')).toEqual(['Books', 'Nonfiction']);
  });
});

describe('childrenAtPath', () => {
  it('empty path → root departments as LightNodes', () => {
    expect(childrenAtPath(tree, [])).toEqual([
      { name: 'Books', hasChildren: true, terminal: false },
      { name: 'Electronics', hasChildren: false, terminal: true },
    ]);
  });
  it('drills one level', () => {
    expect(childrenAtPath(tree, ['Books'])).toEqual([
      { name: 'Fiction', hasChildren: false, terminal: true },
      { name: 'Nonfiction', hasChildren: true, terminal: true },
    ]);
  });
  it('unresolved path → []', () => {
    expect(childrenAtPath(tree, ['Nope'])).toEqual([]);
  });
});

describe('leavesAtPath', () => {
  it('collects terminal names under a path (incl. self if terminal)', () => {
    expect(leavesAtPath(tree, ['Books', 'Nonfiction'])).toEqual(['History', 'Nonfiction']);
  });
  it('leaf node → just itself', () => {
    expect(leavesAtPath(tree, ['Electronics'])).toEqual(['Electronics']);
  });
  it('unresolved path → []', () => {
    expect(leavesAtPath(tree, ['Nope'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail.** `pnpm vitest run lib/categoryBuilder/treeNav.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `lib/categoryBuilder/treeNav.ts`:

```ts
import { type CategoryNode, collectDescendantLeaves, PATH_SEP } from './buildTree';

/** One drill-down level sent to the client — no nested children. */
export interface LightNode {
  name: string;
  hasChildren: boolean;
  terminal: boolean;
}

/** `path` query param (names joined by PATH_SEP) → trimmed segment array. */
export function parsePathParam(param: string | null): string[] {
  if (!param) return [];
  return param.split(PATH_SEP).map((s) => s.trim()).filter(Boolean);
}

/** Walk to the node at `path`; return undefined if any segment is missing. */
function nodeAtPath(tree: CategoryNode[], path: string[]): CategoryNode | 'root' | undefined {
  if (path.length === 0) return 'root';
  let level = tree;
  let node: CategoryNode | undefined;
  for (const name of path) {
    node = level.find((n) => n.name === name);
    if (!node) return undefined;
    level = node.children;
  }
  return node;
}

/** Children of the node at `path` as LightNodes. Empty path → root departments. */
export function childrenAtPath(tree: CategoryNode[], path: string[]): LightNode[] {
  const target = nodeAtPath(tree, path);
  if (target === undefined) return [];
  const level = target === 'root' ? tree : target.children;
  return level.map((n) => ({ name: n.name, hasChildren: n.children.length > 0, terminal: n.terminal }));
}

/** All terminal leaf names under `path` (deduped, locale-sorted). */
export function leavesAtPath(tree: CategoryNode[], path: string[]): string[] {
  const target = nodeAtPath(tree, path);
  if (target === undefined) return [];
  if (target === 'root') {
    return Array.from(new Set(tree.flatMap((n) => collectDescendantLeaves(n)))).sort((a, b) => a.localeCompare(b));
  }
  return collectDescendantLeaves(target);
}
```

- [ ] **Step 4: Run, verify pass.** `pnpm vitest run lib/categoryBuilder/treeNav.test.ts` → PASS.

- [ ] **Step 5: Commit.**
```bash
git add lib/categoryBuilder/treeNav.ts lib/categoryBuilder/treeNav.test.ts
git commit -m "feat(category-builder): pure tree-nav helpers (childrenAtPath, leavesAtPath)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: API routes

**Files:** Create `app/api/category-builder/tree/route.ts`, `app/api/category-builder/leaves/route.ts`.

**Context:** Mirror the conventions (imports, auth, response style) of the EXISTING `app/api/category-builder/custom/route.ts` — read it first. This is Next 16; if the route-handler signature is unfamiliar, check `node_modules/next/dist/docs/`. The tree is non-sensitive public taxonomy, but match whatever auth gate `custom/route.ts` uses (the page is behind the app shell).

- [ ] **Step 1: `tree/route.ts`:**
```ts
import { NextRequest, NextResponse } from 'next/server';
import { loadCategoryTree } from '@/lib/categoryBuilder/loadTree';
import { childrenAtPath, parsePathParam } from '@/lib/categoryBuilder/treeNav';

export async function GET(req: NextRequest) {
  const path = parsePathParam(req.nextUrl.searchParams.get('path'));
  const { tree } = await loadCategoryTree();
  return NextResponse.json({ children: childrenAtPath(tree, path) });
}
```

- [ ] **Step 2: `leaves/route.ts`:**
```ts
import { NextRequest, NextResponse } from 'next/server';
import { loadCategoryTree } from '@/lib/categoryBuilder/loadTree';
import { leavesAtPath, parsePathParam } from '@/lib/categoryBuilder/treeNav';

export async function GET(req: NextRequest) {
  const path = parsePathParam(req.nextUrl.searchParams.get('path'));
  const { tree } = await loadCategoryTree();
  return NextResponse.json({ leaves: leavesAtPath(tree, path) });
}
```
(Add the same auth check `custom/route.ts` uses, returning its 401 shape, if it has one.)

- [ ] **Step 3: Typecheck.** `pnpm typecheck` → expect errors only in `page.tsx`/`CategoryBuilderClient.tsx` (still on the old `tree` prop), fixed in T3/T4. No errors in the route files.

- [ ] **Step 4: Commit.**
```bash
git add "app/api/category-builder/tree/route.ts" "app/api/category-builder/leaves/route.ts"
git commit -m "feat(category-builder): lazy tree + leaves API routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: page.tsx sends only the root level

**Files:** Modify `app/(app)/category-builder/page.tsx`.

- [ ] **Step 1:** Replace the `CategoryBuilderClient` call so it passes the root level (LightNodes) instead of the whole tree:
```tsx
import { childrenAtPath } from '@/lib/categoryBuilder/treeNav';
// …
  const [{ tree }, categories] = await Promise.all([
    loadCategoryTree(),
    user ? listCustomCategoriesForUser(user.id) : Promise.resolve([]),
  ]);
  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-gray-900 mb-4">Category Builder</h1>
      <CategoryBuilderClient
        rootLevel={childrenAtPath(tree, [])}
        initialCategories={categories}
        signedIn={Boolean(user)}
      />
    </div>
  );
```
The full `tree` is still built/cached server-side (cheap) — only the root level is serialized into the payload.

- [ ] **Step 2: Typecheck.** Errors now only in `CategoryBuilderClient.tsx` (T4). Commit with T4 (it won't typecheck alone) — or `--no-verify` is NOT allowed; instead, do T3 + T4 in sequence and commit after T4 typechecks. (Implementer: stage page.tsx now, commit together with T4.)

---

## Task 4: CategoryBuilderClient — fetch-on-drill + level cache + async Add

**Files:** Modify `app/(app)/category-builder/CategoryBuilderClient.tsx`. Read the current file first — it holds the full tree in a prop and renders only the current drill level; the save/edit/delete + cart logic stays unchanged.

- [ ] **Step 1: Swap the tree prop for lazy levels.**
  - Import `LightNode` from `@/lib/categoryBuilder/treeNav` and `PATH_SEP` from `@/lib/categoryBuilder/buildTree`.
  - Props: replace `tree: CategoryNode[]` with `rootLevel: LightNode[]`.
  - Replace the `path: CategoryNode[]` drill state with `path: string[]` (segment names) and a level cache:
```tsx
  const [path, setPath] = useState<string[]>([]);
  const [levels, setLevels] = useState<Map<string, LightNode[]>>(
    () => new Map([['', rootLevel]]),
  );
  const [levelLoading, setLevelLoading] = useState(false);
  const [addLoading, setAddLoading] = useState(false);

  const pathKey = path.join(PATH_SEP);
  const currentLevel: LightNode[] = levels.get(pathKey) ?? [];
```

- [ ] **Step 2: Fetch a level on drill (cache it).**
```tsx
  async function drillInto(name: string) {
    const nextPath = [...path, name];
    const key = nextPath.join(PATH_SEP);
    setPath(nextPath);
    if (levels.has(key)) return;
    setLevelLoading(true);
    try {
      const res = await fetch(`/api/category-builder/tree?path=${encodeURIComponent(key)}`);
      const json = (await res.json()) as { children: LightNode[] };
      setLevels((prev) => new Map(prev).set(key, json.children));
    } catch {
      setLevels((prev) => new Map(prev).set(key, []));
    } finally {
      setLevelLoading(false);
    }
  }
```
Breadcrumb jumps call `setPath(path.slice(0, i + 1))` (those levels are already cached from the way down).

- [ ] **Step 3: Route "Add" through the leaves endpoint.** Replace `collectDescendantLeaves(node)` calls with a fetch:
```tsx
  async function addUnderPath(segments: string[]) {
    setAddLoading(true);
    try {
      const res = await fetch(`/api/category-builder/leaves?path=${encodeURIComponent(segments.join(PATH_SEP))}`);
      const json = (await res.json()) as { leaves: string[] };
      addLeaves(json.leaves); // existing cart helper, unchanged
    } catch {
      addLeaves([]);
    } finally {
      setAddLoading(false);
    }
  }
```
  - A row's **Add** button → `addUnderPath([...path, node.name])`.
  - **"Add all of {current}"** → `addUnderPath(path)`.
  - Drill chevron / name click (when `hasChildren`) → `drillInto(node.name)`.
  - Disable Add buttons while `addLoading`; show a small "Loading…" row while `levelLoading`.

- [ ] **Step 4: Render the current level from `currentLevel` (LightNodes).** The list maps `currentLevel`; `hasChildren` comes from `node.hasChildren` (not `node.children.length`). Breadcrumb renders from `path` (the names). The build panel / saved-categories / save+delete handlers are unchanged.

- [ ] **Step 5: Typecheck + build.** `pnpm typecheck && pnpm build` → clean.

- [ ] **Step 6: Commit (page.tsx + client together).**
```bash
git add "app/(app)/category-builder/page.tsx" "app/(app)/category-builder/CategoryBuilderClient.tsx"
git commit -m "feat(category-builder): lazy-load tree levels on drill-down

Ship only the 30 root departments (~3 KB) instead of the full 808 KB tree;
fetch each level + 'Add' leaf list on demand from the cached server tree.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Verify

- [ ] **Step 1:** `pnpm typecheck && pnpm vitest run lib/categoryBuilder/treeNav.test.ts && pnpm build` → all clean.
- [ ] **Step 2 (manual, post-deploy):** open `/category-builder`. Network tab: the document/RSC payload no longer contains the full tree (initial ~KB, not ~800 KB). Drill into a department → a small `tree?path=` fetch fills the next level; re-drilling is instant (cached). "Add" / "Add all of X" populates the cart with the right leaves. Save/edit/delete a custom category still works.

---

## Self-Review
- **Spec coverage:** helpers (T1), routes (T2), root-only payload (T3), lazy client (T4), verify (T5). All of "send only departments, fetch levels + leaves on demand" is covered.
- **Type consistency:** `LightNode` defined in T1, consumed in T2/T3/T4; `childrenAtPath`/`leavesAtPath`/`parsePathParam` signatures stable across tasks.
- **Risk:** T4 is the real refactor (async drill + Add). The cart/save/delete logic is untouched. `collectDescendantLeaves` moves server-side (leaves endpoint), so the client no longer imports it.
- **Out of scope:** prefetching levels on hover; persisting the level cache across navigations; the count/filter perf (separate, user-parked).

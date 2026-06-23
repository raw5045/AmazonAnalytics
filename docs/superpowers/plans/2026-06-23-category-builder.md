# Category Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Spec: `docs/superpowers/specs/2026-06-23-category-builder-design.md`. Branch: `feat/category-builder`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Do NOT push. Do NOT apply DDL to Neon without explicit user go-ahead.**

**Goal:** A "Category Builder" tab to browse the Amazon category tree (drill-down), assemble per-user **custom categories** (named sets of leaf-category names), and reuse them as a by-reference filter in the Explorer + saved views.

**Architecture:** The tree is reconstructed from the ` › `-delimited `asin_weekly_data.category_path` strings we already store (cached per snapshot). A custom category is a deduped set of leaf **names** stored per-user; selecting it in the filter expands (by ID, at request time) into the existing `top_clicked_leaf_category IN (...)` predicate — so `buildQuery` is untouched.

**Tech Stack:** Next.js 16 App Router (server + client components), Drizzle + Neon Postgres, `unstable_cache`, vitest.

---

## File map

- **Create** `db/schema/customCategories.ts` — drizzle table (mirrors `savedViews.ts`).
- **Create** `db/migrations/0038_custom_categories.sql` — hand-numbered DDL.
- **Modify** `db/schema/index.ts` — export the new table.
- **Create** `lib/categoryBuilder/buildTree.ts` (+ `.test.ts`) — pure tree builder.
- **Create** `lib/categoryBuilder/loadTree.ts` — server loader (cached per snapshot).
- **Create** `lib/customCategories/validation.ts` (+ `.test.ts`) — name/leaf/cap validation.
- **Create** `lib/customCategories/loadServer.ts` — list a user's categories (server).
- **Create** `lib/customCategories/expand.ts` (+ `.test.ts`) — IDs → leaf names.
- **Create** `app/api/category-builder/custom/route.ts` — GET list / POST create.
- **Create** `app/api/category-builder/custom/[id]/route.ts` — PATCH / DELETE.
- **Create** `app/(app)/category-builder/page.tsx` — server page.
- **Create** `app/(app)/category-builder/CategoryBuilderClient.tsx` — drill-down browser + build panel (client).
- **Modify** `app/(app)/TabNav.tsx` — add the Category Builder tab.
- **Modify** `lib/explorer/types.ts` — add `customCategoryIds`.
- **Modify** `lib/explorer/parseFilters.ts` (+ `.test.ts`) — parse `custom` param.
- **Modify** `app/(app)/explorer/page.tsx` — expand custom IDs → leaf names before query.
- **Modify** `app/(app)/explorer/FilterSidebar.tsx` — Leaf | Custom toggle.
- **Modify** `lib/savedViews/validation.ts` (+ `.test.ts`) — serialize/restore `customCategoryIds`.
- **Create** `tests/integration/customCategories.test.ts` — CRUD route integration.

---

## Task A: Schema + migration 0038

**Files:** Create `db/schema/customCategories.ts`, `db/migrations/0038_custom_categories.sql`; Modify `db/schema/index.ts`.

- [ ] **A1. Write the drizzle schema** — `db/schema/customCategories.ts`:

```ts
import { pgTable, uuid, varchar, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

/**
 * Per-user named sets of Keepa leaf-category names, built in the Category
 * Builder tab and reused as an Explorer filter. See migration 0038 +
 * docs/superpowers/specs/2026-06-23-category-builder-design.md.
 *
 * 25-per-user limit is enforced at the API layer. Name uniqueness (per user,
 * case-insensitive) is a DB unique index. `leaf_names` is a deduped string[]
 * of leaf-category names that drops straight into the existing
 * top_clicked_leaf_category IN (...) filter.
 */
export const customCategories = pgTable(
  'custom_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    leafNames: jsonb('leaf_names').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('custom_categories_user_created_idx').on(t.userId, t.createdAt.desc()),
    userNameUniq: uniqueIndex('custom_categories_user_name_uniq').on(t.userId, sql`lower(${t.name})`),
  }),
);

export type CustomCategoryRow = typeof customCategories.$inferSelect;
```

- [ ] **A2. Write the migration** — `db/migrations/0038_custom_categories.sql` (hand-numbered; the drizzle journal is frozen at 0026 — see `memory/hand-numbered-migrations.md`. Do NOT run `db:generate`):

```sql
-- 0038_custom_categories
-- Per-user named sets of leaf-category names for the Category Builder tab.
CREATE TABLE IF NOT EXISTS "custom_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" varchar(80) NOT NULL,
  "leaf_names" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_categories_user_created_idx" ON "custom_categories" ("user_id", "created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_categories_user_name_uniq" ON "custom_categories" ("user_id", lower("name"));
```

- [ ] **A3. Export the table** — in `db/schema/index.ts`, add: `export * from './customCategories';` (match the existing export style in that file).

- [ ] **A4. Verify + commit:** `pnpm typecheck`. Expected: clean. Do **not** run `db:migrate` (migration is applied to Neon later, at the prod gate).

```bash
git add db/schema/customCategories.ts db/migrations/0038_custom_categories.sql db/schema/index.ts
git commit -m "feat(category-builder): custom_categories schema + migration 0038"
```

---

## Task B: Pure tree builder (TDD)

**Files:** Create `lib/categoryBuilder/buildTree.ts`, `lib/categoryBuilder/buildTree.test.ts`.

The tree's hard part: a node can be **terminal** (a product's path ends there) AND a **parent** (another product's path goes deeper). `collectDescendantLeaves` must return every terminal node name in a subtree — including the node's own name when it is itself terminal.

- [ ] **B1. Write the failing test** — `lib/categoryBuilder/buildTree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildTree, collectDescendantLeaves, type CategoryNode } from './buildTree';

const SEP = ' › ';

describe('buildTree', () => {
  it('builds a nested tree, roots sorted, merging shared prefixes', () => {
    const tree = buildTree([
      `Health & Household${SEP}Vitamins${SEP}Collagen`,
      `Health & Household${SEP}Vitamins${SEP}Iron`,
      `Beauty${SEP}Skin Care`,
    ]);
    expect(tree.map((n) => n.name)).toEqual(['Beauty', 'Health & Household']);
    const hh = tree.find((n) => n.name === 'Health & Household')!;
    expect(hh.children.map((n) => n.name)).toEqual(['Vitamins']);
    expect(hh.children[0].children.map((n) => n.name)).toEqual(['Collagen', 'Iron']);
  });

  it('marks a node terminal when a path ends exactly there (even if it also has children)', () => {
    const tree = buildTree([
      `Health & Household${SEP}Vitamins`,            // Vitamins is terminal here
      `Health & Household${SEP}Vitamins${SEP}Collagen`, // …and a parent here
    ]);
    const vit = tree[0].children[0];
    expect(vit.name).toBe('Vitamins');
    expect(vit.terminal).toBe(true);
    expect(vit.children.map((n) => n.name)).toEqual(['Collagen']);
  });

  it('ignores empty/blank paths', () => {
    expect(buildTree(['', '   '])).toEqual([]);
  });
});

describe('collectDescendantLeaves', () => {
  it('returns every terminal name in the subtree, including the node itself, deduped + sorted', () => {
    const [hh] = buildTree([
      `Health & Household${SEP}Vitamins`,
      `Health & Household${SEP}Vitamins${SEP}Collagen`,
      `Health & Household${SEP}Vitamins${SEP}Iron`,
    ]);
    expect(collectDescendantLeaves(hh)).toEqual(['Collagen', 'Iron', 'Vitamins']);
  });

  it('a pure leaf returns just itself', () => {
    const node: CategoryNode = { name: 'Collagen', children: [], terminal: true };
    expect(collectDescendantLeaves(node)).toEqual(['Collagen']);
  });

  it('a non-terminal parent excludes its own name', () => {
    const [root] = buildTree([`Dept${SEP}Sub${SEP}Leaf`]); // Dept, Sub are non-terminal
    expect(collectDescendantLeaves(root)).toEqual(['Leaf']);
  });
});
```

- [ ] **B2. Run to verify it fails:** `pnpm test buildTree` → FAIL (module not found).

- [ ] **B3. Implement** — `lib/categoryBuilder/buildTree.ts`:

```ts
/**
 * Reconstructs the Amazon category tree from Keepa breadcrumb strings
 * (asin_weekly_data.category_path, ' › '-delimited). Pure + unit-tested.
 *
 * A node is `terminal` when some input path ends exactly at it — that node's
 * name is a value that can appear in keyword_current_summary.top_clicked_leaf_category.
 * Because Keepa paths vary in depth, the same node can be terminal for one
 * product and a parent for another.
 */
export const PATH_SEP = ' › ';

export interface CategoryNode {
  name: string;
  children: CategoryNode[];
  /** True when some path ends exactly at this node (a filterable leaf). */
  terminal: boolean;
}

export function buildTree(paths: string[]): CategoryNode[] {
  const roots = new Map<string, CategoryNode>();
  for (const raw of paths) {
    if (!raw || !raw.trim()) continue;
    const segments = raw.split(PATH_SEP).map((s) => s.trim()).filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    let level = roots;
    let node: CategoryNode | undefined;
    for (const seg of segments) {
      node = level.get(seg);
      if (!node) {
        node = { name: seg, children: [], terminal: false };
        level.set(seg, node);
      }
      level = childMap(node);
    }
    if (node) node.terminal = true; // last segment
  }
  return sortTree([...roots.values()]);
}

// We build children via a Map for O(1) merge, then materialize sorted arrays.
const CHILD_MAP = new WeakMap<CategoryNode, Map<string, CategoryNode>>();
function childMap(node: CategoryNode): Map<string, CategoryNode> {
  let m = CHILD_MAP.get(node);
  if (!m) {
    m = new Map();
    CHILD_MAP.set(node, m);
    // keep node.children in sync lazily via sortTree at the end
  }
  return m;
}

function sortTree(nodes: CategoryNode[]): CategoryNode[] {
  for (const n of nodes) {
    const m = CHILD_MAP.get(n);
    n.children = m ? sortTree([...m.values()]) : [];
  }
  return nodes.sort((a, b) => a.name.localeCompare(b.name));
}

/** Every distinct terminal node name in this node's subtree (incl. itself), sorted. */
export function collectDescendantLeaves(node: CategoryNode): string[] {
  const out = new Set<string>();
  const walk = (n: CategoryNode) => {
    if (n.terminal) out.add(n.name);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return [...out].sort((a, b) => a.localeCompare(b));
}
```

- [ ] **B4. Run to verify it passes:** `pnpm test buildTree` → PASS. Then `pnpm typecheck`.

- [ ] **B5. Commit:**

```bash
git add lib/categoryBuilder/buildTree.ts lib/categoryBuilder/buildTree.test.ts
git commit -m "feat(category-builder): pure tree builder + descendant-leaf collector (TDD)"
```

---

## Task C: Server tree loader (cached per snapshot)

**Files:** Create `lib/categoryBuilder/loadTree.ts`.

Mirrors `lib/explorer/listLeafCategories.ts` (neon-http + `unstable_cache`), but keyed by `snapshot_version` so the tree rebuilds automatically each weekly refresh.

- [ ] **C1. Implement** — `lib/categoryBuilder/loadTree.ts`:

```ts
/**
 * Builds + caches the Category Builder tree from asin_weekly_data.category_path
 * for the current snapshot's week. Cached by snapshot_version, so a weekly
 * refresh (which mints a new snapshot_version) transparently rebuilds it.
 */
import { unstable_cache } from 'next/cache';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { buildTree, type CategoryNode } from './buildTree';

async function fetchTree(): Promise<{ snapshotVersion: string | null; tree: CategoryNode[] }> {
  const sql = neon(env.DATABASE_URL);
  const meta = (await sql`
    SELECT snapshot_version::text AS sv, current_week_end_date::text AS wk
    FROM keyword_current_summary_meta WHERE singleton = true
  `) as Array<{ sv: string | null; wk: string | null }>;
  const sv = meta[0]?.sv ?? null;
  const wk = meta[0]?.wk ?? null;
  if (!wk) return { snapshotVersion: sv, tree: [] };
  return buildCachedTree(sv ?? 'no-snapshot', wk);
}

// Keyed by (sv, wk) — unstable_cache varies its entry by the args, so a new
// snapshot_version rebuilds immediately; revalidate is a backstop.
const buildCachedTree = unstable_cache(
  async (_sv: string, wk: string): Promise<{ snapshotVersion: string | null; tree: CategoryNode[] }> => {
    const sql = neon(env.DATABASE_URL);
    const rows = (await sql`
      SELECT DISTINCT category_path
      FROM asin_weekly_data
      WHERE week_end_date = ${wk}::date
        AND category_path IS NOT NULL AND category_path <> ''
    `) as Array<{ category_path: string }>;
    return { snapshotVersion: _sv === 'no-snapshot' ? null : _sv, tree: buildTree(rows.map((r) => r.category_path)) };
  },
  ['category-builder-tree'],
  { revalidate: 60 * 60 * 24, tags: ['category-builder-tree'] },
);

export async function loadCategoryTree(): Promise<{ snapshotVersion: string | null; tree: CategoryNode[] }> {
  return fetchTree();
}
```

- [ ] **C2. Verify + commit:** `pnpm typecheck` → clean.

```bash
git add lib/categoryBuilder/loadTree.ts
git commit -m "feat(category-builder): cached server tree loader (per snapshot)"
```

---

## Task D: Custom-categories validation + CRUD API (TDD for validation)

**Files:** Create `lib/customCategories/validation.ts` (+ `.test.ts`), `lib/customCategories/loadServer.ts`, `app/api/category-builder/custom/route.ts`, `app/api/category-builder/custom/[id]/route.ts`.

- [ ] **D1. Write the failing validation test** — `lib/customCategories/validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateName, normalizeLeafNames, MAX_CUSTOM_CATEGORIES } from './validation';

describe('validateName', () => {
  it('trims and accepts a normal name', () => {
    expect(validateName('  Supplements ')).toEqual({ ok: true, name: 'Supplements' });
  });
  it('rejects empty', () => {
    expect(validateName('   ').ok).toBe(false);
  });
  it('rejects > 80 chars', () => {
    expect(validateName('x'.repeat(81)).ok).toBe(false);
  });
  it('rejects non-strings', () => {
    expect(validateName(42).ok).toBe(false);
  });
});

describe('normalizeLeafNames', () => {
  it('dedupes, drops blanks, keeps order of first occurrence', () => {
    expect(normalizeLeafNames(['Collagen', 'Iron', 'Collagen', '', '  '])).toEqual(['Collagen', 'Iron']);
  });
  it('returns [] for non-arrays', () => {
    expect(normalizeLeafNames('nope')).toEqual([]);
  });
  it('drops non-string members', () => {
    expect(normalizeLeafNames(['Collagen', 5, null])).toEqual(['Collagen']);
  });
});

describe('limits', () => {
  it('cap is 25', () => expect(MAX_CUSTOM_CATEGORIES).toBe(25));
});
```

- [ ] **D2. Run → FAIL:** `pnpm test customCategories/validation`.

- [ ] **D3. Implement** — `lib/customCategories/validation.ts`:

```ts
export const MAX_CUSTOM_CATEGORIES = 25;
export const MAX_NAME_LENGTH = 80;

export function validateName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string' };
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: 'name cannot be empty' };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `name cannot exceed ${MAX_NAME_LENGTH} characters` };
  return { ok: true, name };
}

/** Coerce an incoming leaf_names blob into a deduped string[] (first-occurrence order). */
export function normalizeLeafNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s.length === 0 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
```

- [ ] **D4. Run → PASS:** `pnpm test customCategories/validation`.

- [ ] **D5. Implement the server list helper** — `lib/customCategories/loadServer.ts`:

```ts
import 'server-only';
import { eq, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';

export interface CustomCategoryDTO {
  id: string;
  name: string;
  leafNames: string[];
  createdAt: string;
  updatedAt: string;
}

export async function listCustomCategoriesForUser(userId: string): Promise<CustomCategoryDTO[]> {
  const rows = await db
    .select()
    .from(customCategories)
    .where(eq(customCategories.userId, userId))
    .orderBy(desc(customCategories.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    leafNames: (r.leafNames as string[]) ?? [],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}
```

- [ ] **D6. Implement GET/POST route** — `app/api/category-builder/custom/route.ts` (mirrors `app/api/explorer/saved-views/route.ts` — auth, cap, 23505 → 409):

```ts
/**
 * GET  /api/category-builder/custom → list current user's custom categories
 * POST /api/category-builder/custom → create one { name, leafNames }
 */
import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';
import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';
import { validateName, normalizeLeafNames, MAX_CUSTOM_CATEGORIES } from '@/lib/customCategories/validation';

export const runtime = 'nodejs';

export async function GET() {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  return NextResponse.json({ categories: await listCustomCategoriesForUser(user.id) });
}

export async function POST(req: Request) {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }

  const body = (await req.json().catch(() => ({}))) as { name?: unknown; leafNames?: unknown };
  const nameResult = validateName(body.name);
  if (!nameResult.ok) return NextResponse.json({ error: nameResult.error }, { status: 400 });
  const leafNames = normalizeLeafNames(body.leafNames);
  if (leafNames.length === 0) return NextResponse.json({ error: 'Add at least one leaf category before saving.' }, { status: 400 });

  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(customCategories)
    .where(eq(customCategories.userId, user.id));
  if (n >= MAX_CUSTOM_CATEGORIES) {
    return NextResponse.json({ error: `You've reached the ${MAX_CUSTOM_CATEGORIES}-category limit. Delete one to add another.` }, { status: 400 });
  }

  try {
    const [created] = await db
      .insert(customCategories)
      .values({ userId: user.id, name: nameResult.name, leafNames })
      .returning();
    return NextResponse.json({ category: toDTO(created) });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: `You already have a category named "${nameResult.name}".` }, { status: 409 });
    }
    throw e;
  }
}

function toDTO(r: typeof customCategories.$inferSelect) {
  return { id: r.id, name: r.name, leafNames: (r.leafNames as string[]) ?? [], createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}
function handleAuthError(e: unknown): NextResponse {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
  throw e;
}
function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === '23505');
}
```

- [ ] **D7. Implement PATCH/DELETE route** — `app/api/category-builder/custom/[id]/route.ts` (scope every query to the authed user so users can only touch their own rows):

```ts
/**
 * PATCH  /api/category-builder/custom/[id] → rename / replace leafNames
 * DELETE /api/category-builder/custom/[id] → delete
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';
import { validateName, normalizeLeafNames } from '@/lib/customCategories/validation';

export const runtime = 'nodejs';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; leafNames?: unknown };
  const nameResult = validateName(body.name);
  if (!nameResult.ok) return NextResponse.json({ error: nameResult.error }, { status: 400 });
  const leafNames = normalizeLeafNames(body.leafNames);
  if (leafNames.length === 0) return NextResponse.json({ error: 'A category needs at least one leaf.' }, { status: 400 });

  try {
    const [updated] = await db
      .update(customCategories)
      .set({ name: nameResult.name, leafNames, updatedAt: new Date() })
      .where(and(eq(customCategories.id, id), eq(customCategories.userId, user.id)))
      .returning();
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ category: { id: updated.id, name: updated.name, leafNames: updated.leafNames, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() } });
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === '23505') {
      return NextResponse.json({ error: `You already have a category named "${nameResult.name}".` }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireAuthenticatedUser(); } catch (e) { return handleAuthError(e); }
  const { id } = await params;
  const deleted = await db
    .delete(customCategories)
    .where(and(eq(customCategories.id, id), eq(customCategories.userId, user.id)))
    .returning({ id: customCategories.id });
  if (deleted.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

function handleAuthError(e: unknown): NextResponse {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
  throw e;
}
```

> **Note:** confirm the App-Router param signature against this Next version — read `node_modules/next/dist/docs/01-app/.../route.md` (route handlers). In Next 16 `params` is a `Promise`; the code above awaits it. If a sibling route (e.g. `app/api/explorer/saved-views/[id]/route.ts`) uses a different signature, match that.

- [ ] **D8. Verify + commit:** `pnpm test customCategories/validation && pnpm typecheck`.

```bash
git add lib/customCategories app/api/category-builder
git commit -m "feat(category-builder): custom-categories validation + CRUD API (TDD)"
```

---

## Task E: Category Builder page + client + nav tab

**Files:** Create `app/(app)/category-builder/page.tsx`, `app/(app)/category-builder/CategoryBuilderClient.tsx`; Modify `app/(app)/TabNav.tsx`.

> **Read first (AGENTS.md):** before writing the page, read `node_modules/next/dist/docs/` for the App-Router server-component + `'use client'` conventions in this Next version. Mirror `app/(app)/watchlist/page.tsx` (server page → client table) and `app/(app)/explorer/FilterSidebar.tsx` (client state + Tailwind idiom) for style.

- [ ] **E1. Server page** — `app/(app)/category-builder/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { loadCategoryTree } from '@/lib/categoryBuilder/loadTree';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';
import { CategoryBuilderClient } from './CategoryBuilderClient';

export const metadata: Metadata = { title: 'Category Builder' };

export default async function CategoryBuilderPage() {
  const user = await getCurrentUser();
  const [{ tree }, categories] = await Promise.all([
    loadCategoryTree(),
    user ? listCustomCategoriesForUser(user.id) : Promise.resolve([]),
  ]);
  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-gray-900 mb-4">Category Builder</h1>
      <CategoryBuilderClient tree={tree} initialCategories={categories} signedIn={Boolean(user)} />
    </div>
  );
}
```

- [ ] **E2. Client component** — `app/(app)/category-builder/CategoryBuilderClient.tsx`. A `'use client'` component implementing the **drill-down browser + build panel**. It receives the full `tree` and works entirely client-side for navigation/Add; CRUD goes through the API routes from Task D. Required behavior (implement with `useState`/`useTransition`, Tailwind to match FilterSidebar):

  - **State:** `path: CategoryNode[]` (drill-down stack, root = `[]` meaning the department list); `cart: string[]` (deduped leaf names being assembled); `name: string`; `categories: CustomCategoryDTO[]` (seeded from `initialCategories`); `editingId: string | null`.
  - **Breadcrumb:** `Departments` + each node in `path`; clicking a crumb truncates `path` to that depth. Root shows the departments (tree roots).
  - **Current level rows:** the children of the last node in `path` (or the roots when empty). Each row: name · **Add** button (calls `addLeaves(collectDescendantLeaves(node))`) · a **›** affordance when `node.children.length > 0` (click pushes the node onto `path`). A node that is `terminal` with no children shows only **Add**.
  - **"＋ Add all of \<current>"** at the top of a drilled-in level → `addLeaves(collectDescendantLeaves(currentNode))`.
  - **`addLeaves(names)`:** union into `cart` (dedup via `Set`); show a transient "Added N leaves" line (count of newly-added).
  - **Build panel:** name input; the `cart` list, each with ✕ (`removeLeaf`); live count; **Save Custom Category** (POST when `editingId` is null, else PATCH `/[id]`); **Clear** (resets cart + name + editingId). On success, refresh `categories` from the POST/PATCH response and clear the cart.
  - **Your custom categories:** list `categories` (name · `leafNames.length` · **Edit** · **Delete**). **Edit** loads `{name, cart: leafNames, editingId: id}`. **Delete** calls DELETE `/[id]` and drops it from `categories`.
  - **Errors:** surface the API `error` string inline (e.g. cap/duplicate-name) near the Save button.
  - **Signed-out:** if `!signedIn`, render a short "Sign in to build custom categories" notice instead of the build panel (the tree can still browse). 

  Keep it one focused file. Pull `collectDescendantLeaves` + `CategoryNode` from `@/lib/categoryBuilder/buildTree`, `CustomCategoryDTO` from `@/lib/customCategories/loadServer`.

- [ ] **E3. Add the nav tab** — modify `app/(app)/TabNav.tsx`. After the Watchlist `<Link>` (around line 77), add a Category Builder link mirroring the existing pattern:

```tsx
      <Link
        href="/category-builder"
        className={`text-base font-semibold whitespace-nowrap ${
          isCategoryBuilder ? 'text-gray-900' : 'text-gray-500 hover:text-gray-900'
        }`}
      >
        Category Builder
      </Link>
```

  And add near the other `is*` flags (around line 28): `const isCategoryBuilder = pathname === '/category-builder' || pathname.startsWith('/category-builder/');`

- [ ] **E4. Verify + commit:** `pnpm typecheck && pnpm lint`. Manually load `/category-builder` (`pnpm dev`): drill in, Add at a parent and a leaf, see the cart dedup, Save (needs the migration applied locally OR test after the prod gate — note: the page renders without the table; Save will 500 until the table exists, which is fine pre-migration). Commit:

```bash
git add "app/(app)/category-builder" "app/(app)/TabNav.tsx"
git commit -m "feat(category-builder): builder page (drill-down + cart) + nav tab"
```

---

## Task F: Filter integration — parse, expand, saved views (TDD)

**Files:** Modify `lib/explorer/types.ts`, `lib/explorer/parseFilters.ts` (+ `.test.ts`), `lib/savedViews/validation.ts` (+ `.test.ts`); Create `lib/customCategories/expand.ts` (+ `.test.ts`); Modify `app/(app)/explorer/page.tsx`.

- [ ] **F1. Add the type** — `lib/explorer/types.ts`, in `ExplorerFilters` (after `leafCategories`):

```ts
  /** IDs of the user's custom categories selected in the filter (by reference).
   *  The page loader expands these to leaf names and unions into the leaf filter. */
  customCategoryIds: string[];
```

- [ ] **F2. parseFilters test** — add to `lib/explorer/parseFilters.test.ts`:

```ts
  it('parses the custom param into customCategoryIds', () => {
    const f = parseExplorerFilters({ custom: 'id-1,id-2' });
    expect(f.customCategoryIds).toEqual(['id-1', 'id-2']);
  });
  it('defaults customCategoryIds to []', () => {
    expect(parseExplorerFilters({}).customCategoryIds).toEqual([]);
  });
```

- [ ] **F3. parseFilters impl** — `lib/explorer/parseFilters.ts`: add `customCategoryIds: []` to `EXPLORER_DEFAULTS`; reuse `parseLeafCategories` (same comma-split shape) for the `custom` param; add to the return object:

```ts
    customCategoryIds: parseLeafCategories(getOne(searchParams.custom)),
```

- [ ] **F4. Run → PASS:** `pnpm test parseFilters`.

- [ ] **F5. expand test** — `lib/customCategories/expand.test.ts` (pure merge logic; DB lookup is injected):

```ts
import { describe, it, expect } from 'vitest';
import { mergeCustomLeaves } from './expand';

describe('mergeCustomLeaves', () => {
  it('unions selected categories leaves into the base set, deduped + sorted', () => {
    const rows = [
      { id: 'a', leafNames: ['Collagen', 'Iron'] },
      { id: 'b', leafNames: ['Iron', 'Zinc'] },
    ];
    expect(mergeCustomLeaves(['Magnesium'], rows)).toEqual(['Collagen', 'Iron', 'Magnesium', 'Zinc']);
  });
  it('returns the base unchanged when no rows', () => {
    expect(mergeCustomLeaves(['Collagen'], [])).toEqual(['Collagen']);
  });
});
```

- [ ] **F6. expand impl** — `lib/customCategories/expand.ts`:

```ts
import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';

/** Pure: union base leaf names with each row's leafNames, deduped + sorted. */
export function mergeCustomLeaves(base: string[], rows: Array<{ leafNames: string[] }>): string[] {
  const set = new Set(base);
  for (const r of rows) for (const n of r.leafNames) set.add(n);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Expand selected custom-category IDs (for one user) into leaf names and union
 * with `baseLeaves`. Unknown/deleted IDs are silently skipped (graceful).
 */
export async function expandCustomCategories(
  userId: string,
  ids: string[],
  baseLeaves: string[],
): Promise<string[]> {
  if (ids.length === 0) return baseLeaves;
  const rows = await db
    .select({ leafNames: customCategories.leafNames })
    .from(customCategories)
    .where(and(eq(customCategories.userId, userId), inArray(customCategories.id, ids)));
  return mergeCustomLeaves(baseLeaves, rows.map((r) => ({ leafNames: (r.leafNames as string[]) ?? [] })));
}
```

- [ ] **F7. Run → PASS:** `pnpm test customCategories/expand`.

- [ ] **F8. Wire expansion into the explorer page** — `app/(app)/explorer/page.tsx`. After `filters` is resolved and `user` is known (the page already calls `getCurrentUser`), expand before the query:

```ts
  // Expand any by-reference custom categories into the leaf-name filter — but
  // only for the QUERY. Keep the original `filters` (with customCategoryIds, not
  // the expanded leaves) for the sidebar/backUrl so the UI shows the user's
  // selection, not the expanded leaf set.
  let queryFilters = filters;
  if (user && filters.customCategoryIds.length > 0) {
    const merged = await expandCustomCategories(user.id, filters.customCategoryIds, filters.leafCategories);
    queryFilters = { ...filters, leafCategories: merged };
  }
```

  Add `import { expandCustomCategories } from '@/lib/customCategories/expand';`. Place this block **before** the query call, then change `runExplorerQuery(filters)` → `runExplorerQuery(queryFilters)`. Leave the `filters` passed to `<FilterSidebar>` / `backUrl` untouched. `buildQuery` is unchanged — it just sees more `leafCategories`.

- [ ] **F9. Saved-views round-trip test** — add to `lib/savedViews/validation.test.ts`:

```ts
  it('round-trips customCategoryIds through the blob', () => {
    const blob = { customCategoryIds: ['id-1', 'id-2'] };
    expect(normalizeFiltersBlob(blob).customCategoryIds).toEqual(['id-1', 'id-2']);
  });
  it('serializes customCategoryIds to the custom param', () => {
    const p = filtersToSearchParams({ customCategoryIds: ['id-1', 'id-2'] });
    expect(p.custom).toBe('id-1,id-2');
  });
```

  (If `filtersToSearchParams` isn't exported, test via the public `normalizeFilters` path the same way the existing tests do.)

- [ ] **F10. Saved-views impl** — `lib/savedViews/validation.ts`:
  - In `normalizeFiltersBlob`, add to the returned object: `customCategoryIds: Array.isArray(f.customCategoryIds) ? (f.customCategoryIds as string[]) : [],`.
  - In `filtersToSearchParams`, after the `leaf` handling, add: `if (Array.isArray(f.customCategoryIds) && f.customCategoryIds.length > 0) p.custom = (f.customCategoryIds as string[]).join(',');`.

- [ ] **F11. Verify + commit:** `pnpm test parseFilters customCategories savedViews && pnpm typecheck`.

```bash
git add lib/explorer/types.ts lib/explorer/parseFilters.ts lib/explorer/parseFilters.test.ts lib/customCategories/expand.ts lib/customCategories/expand.test.ts "app/(app)/explorer/page.tsx" lib/savedViews/validation.ts lib/savedViews/validation.test.ts
git commit -m "feat(category-builder): by-reference custom filter — parse, expand, saved-views (TDD)"
```

---

## Task G: FilterSidebar — Leaf | Custom toggle

**Files:** Modify `app/(app)/explorer/FilterSidebar.tsx`, `app/(app)/explorer/page.tsx` (pass the user's categories down).

- [ ] **G1. Pass categories to the sidebar** — in `app/(app)/explorer/page.tsx`, load the user's custom categories (reuse `listCustomCategoriesForUser(user.id)` — fold it into the existing `Promise.all`) and pass `customCategories={...}` to `<FilterSidebar />`.

- [ ] **G2. Sidebar toggle** — in `app/(app)/explorer/FilterSidebar.tsx`:
  - Add prop `customCategories: { id: string; name: string; leafNames: string[] }[]` (default `[]`).
  - Add to `PendingFilters`: `leafMode: 'leaf' | 'custom'` and `customCategoryIds: string[]`; seed in `filtersToPending` (`leafMode: f.customCategoryIds.length > 0 ? 'custom' : 'leaf'`, `customCategoryIds: f.customCategoryIds`).
  - In `pendingToParams`: emit `custom` instead of `leaf` when in custom mode:

```ts
  if (p.leafMode === 'custom') {
    if (p.customCategoryIds.length > 0) params.set('custom', p.customCategoryIds.join(','));
  } else if (p.leafCategories.length > 0) {
    params.set('leaf', p.leafCategories.join(','));
  }
```

   (Remove the old unconditional `leaf` set in `pendingToParams` and replace with the branch above.)
  - In the "Leaf categories" `FieldGroup`, add a **Leaf | Custom** segmented toggle (copy the exact markup of the Whole-word/Broad toggle added in the explorer-filter-perf work). In **Leaf** mode render the existing `LeafCategoryTypeahead`; in **Custom** mode render a checkbox list of `customCategories` (toggle IDs into `pending.customCategoryIds`) with a hint: `"<selected> categories → <total deduped leaves> leaves"`. If `customCategories.length === 0`, show "No custom categories yet — build one in the Category Builder tab."

- [ ] **G3. Verify + commit:** `pnpm typecheck && pnpm lint`. Manual: in Custom mode select a category → Apply → URL gets `?custom=<id>` → results filter. Commit:

```bash
git add "app/(app)/explorer/FilterSidebar.tsx" "app/(app)/explorer/page.tsx"
git commit -m "feat(category-builder): Leaf | Custom toggle in the explorer filter"
```

---

## Task H: Integration test, full verify, prod gate

**Files:** Create `tests/integration/customCategories.test.ts`.

- [ ] **H1. Integration test** (gated by `RUN_INTEGRATION=1`, mirrors `tests/integration/chartSeriesMaintenance.test.ts` setup — dummy user, scope all writes to it, clean up in `afterAll`). Cover: POST create → GET list contains it → PATCH rename → cap (26th create → 400) → duplicate name (409) → DELETE → GET empty. Requires migration 0038 applied to the test DB.

- [ ] **H2. Full suite + lint + typecheck:** `pnpm test && pnpm typecheck && pnpm lint`. Expected: all green except the pre-existing `importFile.test.ts` failure and the pre-existing `react-hooks` lint errors (both unrelated — see prior work). Fix anything this feature introduced.

- [ ] **H3. Commit the test:**

```bash
git add tests/integration/customCategories.test.ts
git commit -m "test(category-builder): CRUD route integration"
```

- [ ] **H4. PROD GATE — apply migration 0038 to Neon** (ask the user first; this is the only DDL). Apply the raw SQL from `db/migrations/0038_custom_categories.sql` via a one-off `pg` script (drizzle-kit won't pick it up — journal frozen at 0026). New empty table, instant, **no backfill**.

- [ ] **H5. Verify live + hand back for push:** with the table applied, exercise the full loop locally against prod data — build a category in `/category-builder`, save, switch to Explorer → Custom mode → select it → confirm results filter, save a view, edit the category, reload the view → results shift. Then hand back for the push/deploy (Vercel Production has the env vars; **Preview builds will fail on the pre-existing missing-env-var issue — that's expected and unrelated**, see `memory/deploy-and-env-model.md`).

---

## Notes

- **No `kcs` migration** — name-based v1 reuses `top_clicked_leaf_category IN (...)` verbatim.
- **Cache:** the tree is cached by `snapshot_version`; a weekly refresh rebuilds it automatically. No cron.
- **Graceful deletes:** a saved view referencing a deleted custom category simply expands to fewer leaves (the unknown ID is skipped in `expandCustomCategories`).
- **Leave pre-existing WIP and failures alone** (uncommitted integration-test edits, `importFile.test.ts`, `react-hooks` lint) — unrelated to this feature.

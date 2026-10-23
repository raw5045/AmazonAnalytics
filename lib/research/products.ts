// lib/research/products.ts
/**
 * The two products tools (spec 2026-10-09 §9): search_products and get_product_details, for every
 * account since spec 2026-10-23 §3 (admin or not, as the keyword tools are; the per-account rate
 * limits cover them), over the Products page's own loaders (lib/products/*), so the page and the
 * tools share one query each. Order of operations, for both: validate → reserve → resolve the
 * category scope (the search only) → read → build → record. `reserve` and `record` are the
 * service's own (createResearchService binds them), so a products call is metered exactly as the
 * keyword tools are: search_keywords reserves its page size up front and records the rows it
 * delivered; get_keyword_details reserves and records one row.
 */
import { neon } from '@neondatabase/serverless';
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';
import { env } from '@/lib/env';
import { EMPTY_CATEGORY_SCOPE, type ProductCategoryScope } from '@/lib/products/categoryPredicate';
import { PRODUCT_PAGE_SIZE, type ProductFilters } from '@/lib/products/filters';
import { listProductBroadCategories, listProductCategoryPaths, listProductDepartments } from '@/lib/products/listCategories';
import { loadProduct, type ProductFacts as CatalogProductFacts } from '@/lib/products/loadProduct';
import { loadProductHistory } from '@/lib/products/loadProductHistory';
import { loadProductKeywords, type ProductKeywordsResult } from '@/lib/products/loadProductKeywords';
import { neonRunner, searchProducts, type ProductSearchResult } from '@/lib/products/searchProducts';
import { loadCustomRows, type CustomRow } from './categories';
import {
  invalid, productDetailsInputSchema, productSearchInputSchema, SCHEMA_VERSION, toProductFilters,
  type ProductDetailsResponse, type ProductHistoryPoint, type ProductSearchInput, type ProductSearchResponse,
} from './contracts';
import { ResearchError } from './errors';
import { keywordUrlFor, productUrlFor } from './links';
import { PRODUCT_TOOL_HISTORY_POINTS, PRODUCT_TOOL_KEYWORDS_CAP } from './productCaps';
import type { ResearchActor } from './service';

/** The answer caps live in the import-free ./productCaps.ts (the tool descriptions quote them); re-exported here, where they apply. */
export { PRODUCT_TOOL_HISTORY_POINTS, PRODUCT_TOOL_KEYWORDS_CAP };
/** Usage rows a details call reserves and records: one product, as get_keyword_details counts one keyword. */
const DETAILS_ROWS = 1;

/**
 * The data side of the products tools: the four Products page loaders, plus the three a search's
 * category scope is checked against, plus the crosswalk's code list the broad category is checked
 * against. `defaultProductsDeps` wires production; tests inject stubs.
 */
export interface ProductLoaders {
  search: (filters: ProductFilters, scope: ProductCategoryScope) => Promise<ProductSearchResult>;
  /** The facts, a stub (`inCatalog: false`) for an ASIN only the keyword tables know, or null when neither has it. */
  facts: (asin: string) => Promise<CatalogProductFacts | null>;
  history: (asin: string) => Promise<ProductHistoryPoint[]>;
  keywords: (asin: string, limit: number) => Promise<ProductKeywordsResult>;
  /**
   * The departments of the facets (product_category_facets, rebuilt weekly by every import's
   * category_facets_build phase, daily by the worker's 14:00 ET cron and by hand; lib/products/listCategories,
   * cached an hour): a search's department must be one of them. A department first seen after a build is
   * offered within about a day.
   */
  departments: () => Promise<string[]>;
  /**
   * The category paths of the facets (product_category_facets, rebuilt weekly by every import's
   * category_facets_build phase, daily by the worker's 14:00 ET cron and by hand; lib/products/listCategories,
   * cached an hour): a search's taxonomy and leaf paths are checked against them. A path first seen after a
   * build is offered within about a day.
   */
  categoryPaths: () => Promise<string[]>;
  /** The Brand Analytics codes of the crosswalk (lib/products/listCategories, cached an hour): a search's broadCategory must be one of them. */
  broadCategories: () => Promise<string[]>;
  /** The actor's own custom categories by id; unknown and foreign ids are absent (lib/research/categories.ts loadCustomRows). */
  customRows: (userId: string, ids: string[]) => Promise<CustomRow[]>;
}

/** What the two tool functions run on: the loaders plus the app's base URL and the service's usage hooks, bound to its own reserve and digest counters. */
export interface ProductsDeps extends ProductLoaders {
  /** The base URL of the links (ASIN pages, Explorer): the service's own `appUrl`, as the keyword tools use. The loaders carry none. */
  appUrl: string;
  /** The per-minute rate limit, before any read: rows asked for up front (resolves, or rejects with RATE_LIMITED). */
  reserve: (actor: ResearchActor, rows: number) => Promise<unknown>;
  /** The daily-digest counters, after a successful call only: rows delivered. */
  record: (actor: ResearchActor, rows: number) => void;
}

/**
 * Production loaders over Neon's HTTP driver: each call creates its own neon() client lazily (as
 * details.ts's loaders do), so building the default service never touches DATABASE_URL. The scope
 * loaders are the Products page's cached option lists and the keyword tools' own custom-row read
 * (over the research pool, which is created on first use).
 */
export function defaultProductsDeps(): ProductLoaders {
  const run = () => neonRunner(neon(env.DATABASE_URL));
  return {
    search: (filters, scope) => searchProducts(run(), filters, scope),
    facts: (asin) => loadProduct(run(), asin),
    history: (asin) => loadProductHistory(run(), asin),
    keywords: (asin, limit) => loadProductKeywords(run(), asin, limit),
    departments: () => listProductDepartments(),
    categoryPaths: () => listProductCategoryPaths(),
    broadCategories: () => listProductBroadCategories(),
    customRows: (userId, ids) => loadCustomRows(userId, ids),
  };
}

function productNotFoundError(): ResearchError {
  return new ResearchError('NOT_FOUND', 'No data for that ASIN: it is not in the product catalog and is not a top-3 clicked product of any current keyword.');
}

type ProductSearchFilters = NonNullable<ProductSearchInput['filters']>;
type ScopeDeps = Pick<ProductLoaders, 'departments' | 'categoryPaths' | 'broadCategories' | 'customRows'>;
const PATH_NOT_AVAILABLE = 'not a category path of the product catalog';

function pathNotAvailable(path: string, at: string): ResearchError {
  return new ResearchError(
    'CATEGORY_NOT_AVAILABLE',
    `"${path}" is not a category path of the product catalog (paths from resolve_categories almost always are; check the spelling and the '${PATH_SEP}' separators).`,
    { details: [{ path: at, message: PATH_NOT_AVAILABLE }] },
  );
}

/**
 * The search's category scope (spec 2026-10-12 §6; the broad category: spec 2026-10-14 §7, §10 (arc 9 §9's mechanics)): the department and the broad category checked
 * against the catalog's department list and the crosswalk's code list (the code travels on the page
 * filters, not the scope);
 * every taxonomy selection as a subtree, whatever includeDescendants says (resolve_categories marks
 * keyword-side leaves as having no descendants, but the product catalog files products deeper); custom
 * selections as the account's stored paths, exactly; leafPaths exactly. Every taxonomy and leaf path is
 * checked against the catalog's path list — a leaf path must be an entry, a taxonomy path an entry or a
 * proper prefix of one at a PATH_SEP boundary — and every custom id must be the actor's own. Any miss is
 * CATEGORY_NOT_AVAILABLE naming the field: never a silent skip, never an empty page for a typo. A custom
 * category whose stored paths are absent from the catalog (or empty) scopes to nothing rather than
 * erroring; only unknown paths and ids error. An absent or empty categories object scopes nothing.
 */
export async function resolveProductCategoryScope(deps: ScopeDeps, actor: ResearchActor, filters: ProductSearchFilters): Promise<ProductCategoryScope> {
  const dept = filters.department ?? null;
  if (dept !== null) {
    const departments = await deps.departments();
    if (!departments.includes(dept)) {
      const message = departments.length === 0
        ? 'The product catalog has no departments yet.'
        : `"${dept}" is not a department of the product catalog. Pass one of: ${departments.join('; ')}.`;
      throw new ResearchError('CATEGORY_NOT_AVAILABLE', message, { details: [{ path: 'filters.department', message: 'unknown department' }] });
    }
  }
  const broad = filters.broadCategory ?? null;
  if (broad !== null) {
    const codes = await deps.broadCategories();
    if (!codes.includes(broad)) {
      const message = codes.length === 0
        ? 'No broad categories are available yet: the Keepa-to-Brand-Analytics crosswalk has not been built.'
        : `"${broad}" is not a broad category of the product catalog. Pass one of: ${codes.join('; ')}.`;
      throw new ResearchError('CATEGORY_NOT_AVAILABLE', message, { details: [{ path: 'filters.broadCategory', message: 'unknown broad category' }] });
    }
  }
  const categories = filters.categories;
  if (!categories || (categories.selections.length === 0 && categories.leafPaths.length === 0)) return { ...EMPTY_CATEGORY_SCOPE, dept };

  const subtree: Array<{ path: string; at: string }> = [];
  const exact: Array<{ path: string; at: string }> = [];
  const customIds: Array<{ id: string; at: string }> = [];
  categories.selections.forEach((sel, i) => {
    const at = `filters.categories.selections[${i}]`;
    // A taxonomy selection is always a subtree on products: includeDescendants is ignored (see above).
    if (sel.kind === 'custom') customIds.push({ id: sel.id, at: `${at}.id` });
    else subtree.push({ path: sel.path, at: `${at}.path` });
  });
  categories.leafPaths.forEach((path, i) => exact.push({ path, at: `filters.categories.leafPaths[${i}]` }));

  if (subtree.length > 0 || exact.length > 0) {
    const catalog = await deps.categoryPaths();
    const known = new Set(catalog);
    for (const { path, at } of exact) if (!known.has(path)) throw pathNotAvailable(path, at);
    for (const { path, at } of subtree) {
      const prefix = path + PATH_SEP;
      if (!known.has(path) && !catalog.some((entry) => entry.startsWith(prefix))) throw pathNotAvailable(path, at);
    }
  }
  const exactPaths = exact.map((e) => e.path);
  if (customIds.length > 0) {
    const rows = await deps.customRows(actor.localUserId, [...new Set(customIds.map((c) => c.id))]);
    const found = new Map(rows.map((r) => [r.id, r.leafPaths]));
    for (const { id, at } of customIds) {
      const paths = found.get(id);
      if (!paths) {
        throw new ResearchError('CATEGORY_NOT_AVAILABLE', 'That custom category does not exist for this account. List yours with resolve_categories and pick from its custom candidates.', {
          details: [{ path: at, message: 'unknown custom category id' }],
        });
      }
      exactPaths.push(...paths);
    }
  }
  return { dept, subtreePaths: [...new Set(subtree.map((s) => s.path))], exactPaths: [...new Set(exactPaths)], scoped: true };
}

/**
 * `search_products`: one page (PRODUCT_PAGE_SIZE rows) of the Products page's search, with each
 * row's ASIN page link. The total is exact up to the page's count cap, then `at_least` that cap.
 * The department and the categories object become the search's category scope
 * (resolveProductCategoryScope), resolved after the reserve as the keyword tools resolve theirs.
 * The broad category is checked there too and travels on the page filters, not in the scope.
 */
export async function searchProductsForTool(deps: ProductsDeps, actor: ResearchActor, input: unknown): Promise<ProductSearchResponse> {
  const parsed = productSearchInputSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  const filters = toProductFilters(parsed.data);
  await deps.reserve(actor, PRODUCT_PAGE_SIZE);
  const scope = await resolveProductCategoryScope(deps, actor, parsed.data.filters ?? {});
  const result = await deps.search(filters, scope);
  const response: ProductSearchResponse = {
    schemaVersion: SCHEMA_VERSION,
    products: result.rows.map((row) => ({ ...row, url: productUrlFor(deps.appUrl, row.asin) })),
    total: { kind: result.totalIsCapped ? 'at_least' : 'exact', value: result.total },
    page: result.page,
    pageSize: result.pageSize,
    // Spec 2026-10-23 §3: the tools are no longer restricted; the field stays so the answer's shape does not change.
    adminOnly: false,
  };
  deps.record(actor, response.products.length);
  return response;
}

/**
 * `get_product_details`: the ASIN page's three blocks for one ASIN — the facts (with the ASIN page
 * link), the newest PRODUCT_TOOL_HISTORY_POINTS Keepa snapshots (oldest first, with the oldest and
 * newest of the loader's whole window and its count), and the keywords it is a top-3 clicked
 * product for (best rank first, capped at PRODUCT_TOOL_KEYWORDS_CAP, each with its Explorer link).
 * The facts are read first: null (neither the catalog nor the keyword tables know the ASIN) is
 * NOT_FOUND with no further reads; a stub (`inCatalog: false`) or a catalog row the service has
 * never fetched is answered normally without the history read, since neither has any snapshots.
 */
export async function productDetailsForTool(deps: ProductsDeps, actor: ResearchActor, input: unknown): Promise<ProductDetailsResponse> {
  const parsed = productDetailsInputSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  const { asin } = parsed.data;
  await deps.reserve(actor, DETAILS_ROWS);
  const facts = await deps.facts(asin);
  if (!facts) throw productNotFoundError();
  const [loaded, keywords] = await Promise.all([
    facts.inCatalog && facts.fetched ? deps.history(asin) : Promise.resolve<ProductHistoryPoint[]>([]),
    deps.keywords(asin, PRODUCT_TOOL_KEYWORDS_CAP),
  ]);
  const response: ProductDetailsResponse = {
    schemaVersion: SCHEMA_VERSION,
    product: { ...facts, url: productUrlFor(deps.appUrl, asin) },
    // The loader's window is oldest first, so the newest points are its tail; first, last and the count span the whole window.
    history: {
      points: loaded.slice(-PRODUCT_TOOL_HISTORY_POINTS),
      first: loaded[0] ?? null,
      last: loaded.at(-1) ?? null,
      pointsTotal: loaded.length,
    },
    keywords: keywords.rows.map((row) => ({ ...row, keywordUrl: keywordUrlFor(deps.appUrl, row.searchTermId) })),
    keywordsTotal: keywords.total,
  };
  deps.record(actor, DETAILS_ROWS);
  return response;
}

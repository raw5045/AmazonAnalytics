// lib/research/products.ts
/**
 * The two admin-only products tools (spec 2026-10-09 §9): search_products and get_product_details,
 * over the Products page's own loaders (lib/products/*), so the page and the tools share one query
 * each. Order of operations, for both: refuse a non-admin actor (FORBIDDEN, before anything else:
 * no read, no usage reserve, no record) → validate → reserve → read → build → record. `reserve`
 * and `record` are the service's own (createResearchService binds them), so a products call is
 * metered exactly as the keyword tools are: search_keywords reserves its page size up front and
 * records the rows it delivered; get_keyword_details reserves and records one row.
 */
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { PRODUCT_PAGE_SIZE, type ProductFilters } from '@/lib/products/filters';
import { loadProduct, type ProductFacts as CatalogProductFacts } from '@/lib/products/loadProduct';
import { loadProductHistory } from '@/lib/products/loadProductHistory';
import { loadProductKeywords, type ProductKeywordsResult } from '@/lib/products/loadProductKeywords';
import { neonRunner, searchProducts, type ProductSearchResult } from '@/lib/products/searchProducts';
import {
  invalid, productDetailsInputSchema, productSearchInputSchema, SCHEMA_VERSION, toProductFilters,
  type ProductDetailsResponse, type ProductHistoryPoint, type ProductSearchResponse,
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
 * The data side of the products tools: the app's base URL (for the links) and the four Products
 * page loaders. `defaultProductsDeps` wires production; tests inject stubs.
 */
export interface ProductLoaders {
  appUrl: string;
  search: (filters: ProductFilters) => Promise<ProductSearchResult>;
  /** The facts, a stub (`inCatalog: false`) for an ASIN only the keyword tables know, or null when neither has it. */
  facts: (asin: string) => Promise<CatalogProductFacts | null>;
  history: (asin: string) => Promise<ProductHistoryPoint[]>;
  keywords: (asin: string, limit: number) => Promise<ProductKeywordsResult>;
}

/** What the two tool functions run on: the loaders plus the service's usage hooks, bound to its own reserve and digest counters. */
export interface ProductsDeps extends ProductLoaders {
  /** The per-minute rate limit, before any read: rows asked for up front (resolves, or rejects with RATE_LIMITED). */
  reserve: (actor: ResearchActor, rows: number) => Promise<unknown>;
  /** The daily-digest counters, after a successful call only: rows delivered. */
  record: (actor: ResearchActor, rows: number) => void;
}

/**
 * Production loaders over Neon's HTTP driver: each call creates its own neon() client lazily (as
 * details.ts's loaders do), so building the default service never touches DATABASE_URL.
 */
export function defaultProductsDeps(appUrl: string): ProductLoaders {
  const run = () => neonRunner(neon(env.DATABASE_URL));
  return {
    appUrl,
    search: (filters) => searchProducts(run(), filters),
    facts: (asin) => loadProduct(run(), asin),
    history: (asin) => loadProductHistory(run(), asin),
    keywords: (asin, limit) => loadProductKeywords(run(), asin, limit),
  };
}

/** Spec 2026-10-09 §10: the products tools answer admin accounts only for now. Not retryable. */
export function productsForbiddenError(): ResearchError {
  return new ResearchError('FORBIDDEN', 'Products tools are admin-only for now.');
}

function productNotFoundError(): ResearchError {
  return new ResearchError('NOT_FOUND', 'No data for that ASIN: it is not in the product catalog and is not a top-3 clicked product of any current keyword.');
}

function assertAdmin(actor: ResearchActor): void {
  if (!actor.isAdmin) throw productsForbiddenError();
}

/**
 * `search_products`: one page (PRODUCT_PAGE_SIZE rows) of the Products page's search, with each
 * row's ASIN page link. The total is exact up to the page's count cap, then `at_least` that cap.
 */
export async function searchProductsForTool(deps: ProductsDeps, actor: ResearchActor, input: unknown): Promise<ProductSearchResponse> {
  assertAdmin(actor);
  const parsed = productSearchInputSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  const filters = toProductFilters(parsed.data);
  await deps.reserve(actor, PRODUCT_PAGE_SIZE);
  const result = await deps.search(filters);
  const response: ProductSearchResponse = {
    schemaVersion: SCHEMA_VERSION,
    products: result.rows.map((row) => ({ ...row, url: productUrlFor(deps.appUrl, row.asin) })),
    total: { kind: result.totalIsCapped ? 'at_least' : 'exact', value: result.total },
    page: result.page,
    pageSize: result.pageSize,
    adminOnly: true,
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
  assertAdmin(actor);
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

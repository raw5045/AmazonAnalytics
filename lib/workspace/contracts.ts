/**
 * Input schemas, response types and the service interface for the eleven workspace tools
 * (spec 2026-09-30 §3). Every input is a `z.strictObject` so a hallucinated key is rejected by
 * the MCP SDK before the tool runs. The `WorkspaceService` interface lives here (types only) so
 * lib/workspace/tools.ts and lib/workspace/service.ts both depend on this module and never on
 * each other's runtime.
 */
import { z } from 'zod';
import type { ExplorerFilters } from '@/lib/explorer/types';
import { categoriesSchema, searchToolInputSchema } from '@/lib/research/contracts';
import type { ResearchActor } from '@/lib/research/service';
import { MAX_NAME_LENGTH } from '@/lib/savedViews/validation';

export const WORKSPACE_TOOL_NAMES = [
  'list_saved_views',
  'list_custom_categories',
  'list_watchlist',
  'create_saved_view',
  'update_saved_view',
  'delete_saved_view',
  'create_custom_category',
  'update_custom_category',
  'delete_custom_category',
  'add_to_watchlist',
  'remove_from_watchlist',
] as const;
export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export const MAX_WATCHLIST_ITEMS_PER_CALL = 100;
/** How many stored leaf paths a category summary shows (same count as search's previewPaths). */
export const PREVIEW_LEAF_PATHS = 20;
export const LEAF_MODES = ['replace', 'add', 'remove'] as const;
export type LeafMode = (typeof LEAF_MODES)[number];

const nameSchema = z
  .string()
  .trim()
  .min(1, 'name cannot be empty')
  .max(MAX_NAME_LENGTH, `name cannot exceed ${MAX_NAME_LENGTH} characters`)
  .describe(`Up to ${MAX_NAME_LENGTH} characters; unique among this account's saved views (exactly) or custom categories (ignoring case). On DUPLICATE_NAME ask the person for another name; never invent one.`);
// Ids are lowercased here: clients may send uppercase, Postgres returns lowercase, and the owner-scoped
// lookups compare exactly. toLowerCase() is idempotent, so a service's own re-parse changes nothing.
const idSchema = z.uuid().toLowerCase().describe('The id from a list tool or a create result.');

/** search_keywords' input minus cursor and pageSize — what the AI searched with. A fresh strict object, so a `cursor` key is rejected. */
export const searchSpecSchema = z
  .strictObject(searchToolInputSchema.omit({ cursor: true, pageSize: true }).shape)
  .describe('The exact criteria you searched with: presetIds, filters, sort, comparisonWindow. Never a cursor.');
export type SearchSpec = z.infer<typeof searchSpecSchema>;

const categoriesInputSchema = categoriesSchema
  .refine((c) => c.selections.length > 0 || c.leafPaths.length > 0, { message: 'pass at least one selection or leaf path' })
  .describe('Selections from resolve_categories (taxonomy paths with or without descendants, custom category ids) and/or exact leaf paths; the server expands them to leaves.');

export { emptyInputSchema } from '@/lib/research/contracts';
export const createSavedViewInputSchema = z.strictObject({ name: nameSchema, search: searchSpecSchema });
export const updateSavedViewInputSchema = z
  .strictObject({ id: idSchema, name: nameSchema.optional(), search: searchSpecSchema.optional() })
  .refine((v) => v.name !== undefined || v.search !== undefined, { message: 'pass a new name, a new search, or both' });
export const deleteSavedViewInputSchema = z.strictObject({ id: idSchema });
export const createCustomCategoryInputSchema = z.strictObject({ name: nameSchema, categories: categoriesInputSchema });
export const updateCustomCategoryInputSchema = z
  .strictObject({
    id: idSchema,
    name: nameSchema.optional(),
    categories: categoriesInputSchema.optional(),
    leafMode: z.enum(LEAF_MODES).default('replace').describe('replace = the category becomes exactly these leaves; add = union with the stored leaves; remove = subtract them.'),
  })
  .refine((v) => v.name !== undefined || v.categories !== undefined, { message: 'pass a new name, categories, or both' });
export const deleteCustomCategoryInputSchema = z.strictObject({ id: idSchema });
const keywordText = z.string().trim().min(1).max(512);
export const watchlistSelectionInputSchema = z
  .strictObject({
    keywords: z.array(keywordText).max(MAX_WATCHLIST_ITEMS_PER_CALL).default([]).describe('Keyword text as shown in search rows. Matching ignores case, punctuation and extra spaces but is otherwise exact (no partial matches); text that matches nothing comes back in unmatched.'),
    searchTermIds: z.array(z.uuid().toLowerCase()).max(MAX_WATCHLIST_ITEMS_PER_CALL).default([]).describe('searchTermId values from search rows or list_watchlist.'),
  })
  .refine((v) => v.keywords.length + v.searchTermIds.length >= 1, { message: 'pass at least one keyword or searchTermId' })
  .refine((v) => v.keywords.length + v.searchTermIds.length <= MAX_WATCHLIST_ITEMS_PER_CALL, { message: `at most ${MAX_WATCHLIST_ITEMS_PER_CALL} items per call` });

// ---- responses (§3) ----
export interface SavedViewSummary {
  id: string;
  name: string;
  explorerUrl: string;
  /** The stored Explorer filters with defaults stripped (§5.5); {} is the default Explorer. `leafPaths`, when present, is a preview: the first 20 of leafCount, in stored order. */
  filters: Partial<ExplorerFilters>;
  /** How many leaf categories the stored filters name; 0 when none. */
  leafCount: number;
  /** True when filters.leafPaths holds every one of them. */
  previewComplete: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ListSavedViewsResponse { views: SavedViewSummary[]; count: number; limit: number }
export interface SavedViewWriteResponse { view: SavedViewSummary; notes: string[] }
export interface DeleteSavedViewResponse { deleted: { id: string; name: string } }

export interface CustomCategorySummary {
  id: string;
  name: string;
  leafCount: number;
  previewPaths: string[];
  previewComplete: boolean;
  explorerUrl: string;
  createdAt: string;
  updatedAt: string;
}
export interface ListCustomCategoriesResponse { categories: CustomCategorySummary[]; count: number; limit: number }
export interface CustomCategoryWriteResponse { category: CustomCategorySummary; notes: string[] }
export interface DeleteCustomCategoryResponse { deleted: { id: string; name: string; leafCount: number } }

export interface WatchlistEntry { searchTermId: string; keyword: string; keywordUrl: string; addedAt: string }
export interface ListWatchlistResponse { items: WatchlistEntry[]; count: number; limit: number }
export interface AddToWatchlistResponse { added: number; alreadyWatching: number; unmatched: string[]; skippedAtCap: number; watching: number; limit: number }
export interface RemoveFromWatchlistResponse { removed: number; notWatching: number; unmatched: string[]; watching: number; limit: number }

/**
 * One method per tool. Both callers (the MCP SDK today, the AI SDK if the chat ever gets writes)
 * validate args against the same schema before calling, so each method's own safeParse of `input`
 * is defence in depth; that makes every schema's parse idempotent by contract — no type-changing
 * `.transform()`. Expected failures reject with a ResearchError.
 */
export interface WorkspaceService {
  listSavedViews(actor: ResearchActor, input: unknown): Promise<ListSavedViewsResponse>;
  listCustomCategories(actor: ResearchActor, input: unknown): Promise<ListCustomCategoriesResponse>;
  listWatchlist(actor: ResearchActor, input: unknown): Promise<ListWatchlistResponse>;
  createSavedView(actor: ResearchActor, input: unknown): Promise<SavedViewWriteResponse>;
  updateSavedView(actor: ResearchActor, input: unknown): Promise<SavedViewWriteResponse>;
  deleteSavedView(actor: ResearchActor, input: unknown): Promise<DeleteSavedViewResponse>;
  createCustomCategory(actor: ResearchActor, input: unknown): Promise<CustomCategoryWriteResponse>;
  updateCustomCategory(actor: ResearchActor, input: unknown): Promise<CustomCategoryWriteResponse>;
  deleteCustomCategory(actor: ResearchActor, input: unknown): Promise<DeleteCustomCategoryResponse>;
  addToWatchlist(actor: ResearchActor, input: unknown): Promise<AddToWatchlistResponse>;
  removeFromWatchlist(actor: ResearchActor, input: unknown): Promise<RemoveFromWatchlistResponse>;
}

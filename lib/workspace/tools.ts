/**
 * The eleven workspace tools (spec 2026-09-30 §3), the same frozen-definition shape as
 * lib/research/tools.ts. Registered on the MCP server only while MCP_WRITE_ENABLED is "1"
 * (lib/mcp/handler.ts); never handed to Ask AI (lib/ask/tools.ts builds from RESEARCH_TOOLS).
 * Descriptions are what Claude and ChatGPT show in their approval prompt, so they stay plain.
 */
import { MAX_CUSTOM_CATEGORIES, MAX_LEAF_PATHS_PER_CATEGORY } from '@/lib/customCategories/validation';
import { READ_ONLY_ANNOTATIONS, type ToolDefinition } from '@/lib/research/tools';
import { MAX_VIEWS_PER_USER } from '@/lib/savedViews/validation';
import { MAX_WATCHED_KEYWORDS } from '@/lib/watchlist/validation';
import {
  createCustomCategoryInputSchema, createSavedViewInputSchema, deleteCustomCategoryInputSchema, deleteSavedViewInputSchema, emptyInputSchema,
  MAX_WATCHLIST_ITEMS_PER_CALL, PREVIEW_LEAF_PATHS, updateCustomCategoryInputSchema, updateSavedViewInputSchema, watchlistSelectionInputSchema,
  type WorkspaceService, type WorkspaceToolName,
} from './contracts';

export type WorkspaceToolDefinition = ToolDefinition<WorkspaceService, WorkspaceToolName>;

/** Not idempotent: a repeat with the same name fails with DUPLICATE_NAME instead of returning the existing item, so clients must not retry it blindly. */
export const CREATE_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const);
/** Additive, idempotent writes (watchlist adds): repeating them changes nothing more. */
export const ADDITIVE_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const);
/** Deletes, removals and the two updates (which replace or drop stored data — MCP defines destructiveHint:false as additive-only): clients flag these as destructive in their prompts. */
export const DESTRUCTIVE_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const);

// "normally": a member can choose Always allow, and some clients auto-run.
const ASKS = 'Clients normally ask the person before this runs.';

// Same reason as lib/research/tools.ts's frozenTool: Object.freeze on the literal itself would lose the contextual type.
function frozenTool(def: WorkspaceToolDefinition): WorkspaceToolDefinition {
  return Object.freeze(def);
}

export const WORKSPACE_TOOLS: ReadonlyArray<WorkspaceToolDefinition> = Object.freeze([
  frozenTool({
    name: 'list_saved_views',
    title: 'List saved views',
    description: () => `This account's saved Explorer views (up to ${MAX_VIEWS_PER_USER}): id, name, Explorer link and the stored filters in compact form (leaf categories are previewed: the first ${PREVIEW_LEAF_PATHS} of leafCount). Use the id for update_saved_view and delete_saved_view.`,
    inputSchema: emptyInputSchema,
    run: (service, actor, args) => service.listSavedViews(actor, args),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
  }),
  frozenTool({
    name: 'list_custom_categories',
    title: 'List custom categories',
    description: () => `This account's custom categories (up to ${MAX_CUSTOM_CATEGORIES}): id, name, leaf count, the first ${PREVIEW_LEAF_PATHS} leaf paths and an Explorer link. Use the id for update_custom_category, delete_custom_category, or as a custom selection in search_keywords.`,
    inputSchema: emptyInputSchema,
    run: (service, actor, args) => service.listCustomCategories(actor, args),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
  }),
  frozenTool({
    name: 'list_watchlist',
    title: 'List watchlist',
    description: () => `The keywords this account watches (up to ${MAX_WATCHED_KEYWORDS}), newest first, with their ids, links and the date added. The weekly digest email reports movement on them.`,
    inputSchema: emptyInputSchema,
    run: (service, actor, args) => service.listWatchlist(actor, args),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
  }),
  frozenTool({
    name: 'create_saved_view',
    title: 'Create saved view',
    description: () => `Saves the exact criteria you searched with as a named Explorer view: pass the same presetIds, filters, sort and comparisonWindow (never a cursor). Returns the view with its link, its compact filters (leaf categories previewed, with leafCount), and notes for anything the Explorer could not carry over; relay the notes to the person. ${ASKS}`,
    inputSchema: createSavedViewInputSchema,
    run: (service, actor, args) => service.createSavedView(actor, args),
    annotations: CREATE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'update_saved_view',
    title: 'Update saved view',
    description: () => `Renames a saved view and/or replaces its filters with a new search (no merge). Takes the id from list_saved_views. Returns the view with its link, its compact filters (leaf categories previewed, with leafCount), and notes. ${ASKS}`,
    inputSchema: updateSavedViewInputSchema,
    run: (service, actor, args) => service.updateSavedView(actor, args),
    annotations: DESTRUCTIVE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'delete_saved_view',
    title: 'Delete saved view',
    description: () => `Deletes one saved view by id, permanently. Confirm the view's name with the person first; list_saved_views has the ids. Returns the deleted view's id and name. ${ASKS}`,
    inputSchema: deleteSavedViewInputSchema,
    run: (service, actor, args) => service.deleteSavedView(actor, args),
    annotations: DESTRUCTIVE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'create_custom_category',
    title: 'Create custom category',
    description: () => `Creates a custom category from category selections (from resolve_categories) and/or exact leaf paths; the server expands selections to their leaves, up to ${MAX_LEAF_PATHS_PER_CATEGORY.toLocaleString('en-US')}. Returns id, leaf count, preview paths and an Explorer link. ${ASKS}`,
    inputSchema: createCustomCategoryInputSchema,
    run: (service, actor, args) => service.createCustomCategory(actor, args),
    annotations: CREATE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'update_custom_category',
    title: 'Update custom category',
    description: () => `Renames a custom category and/or changes its leaves, using the same categories object create_custom_category takes. leafMode replace (the default) makes the category exactly these leaves and drops the rest; add and remove change only the leaves given. Takes the id from list_custom_categories. Returns the category with its leaf count, preview paths and link. ${ASKS}`,
    inputSchema: updateCustomCategoryInputSchema,
    run: (service, actor, args) => service.updateCustomCategory(actor, args),
    annotations: DESTRUCTIVE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'delete_custom_category',
    title: 'Delete custom category',
    description: () => `Deletes one custom category by id, permanently. A saved view that filters on it loses that category filter; if it was the view's only category filter, the view then shows every category. Confirm the category's name with the person first; list_custom_categories has the ids. Returns the deleted category's id, name and leaf count. ${ASKS}`,
    inputSchema: deleteCustomCategoryInputSchema,
    run: (service, actor, args) => service.deleteCustomCategory(actor, args),
    annotations: DESTRUCTIVE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'add_to_watchlist',
    title: 'Add to watchlist',
    description: () => `Adds up to ${MAX_WATCHLIST_ITEMS_PER_CALL} keywords, by text and/or searchTermId from search rows, to the watchlist, which holds at most ${MAX_WATCHED_KEYWORDS}. Reports added, already watching, unmatched, and skipped at the cap. Re-adding is harmless. ${ASKS}`,
    inputSchema: watchlistSelectionInputSchema,
    run: (service, actor, args) => service.addToWatchlist(actor, args),
    annotations: ADDITIVE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
  frozenTool({
    name: 'remove_from_watchlist',
    title: 'Remove from watchlist',
    description: () => `Removes up to ${MAX_WATCHLIST_ITEMS_PER_CALL} keywords, by text and/or searchTermId, from the watchlist. Not permanent: a removed keyword can be added again. Reports removed, not watching, and unmatched. ${ASKS}`,
    inputSchema: watchlistSelectionInputSchema,
    run: (service, actor, args) => service.removeFromWatchlist(actor, args),
    annotations: DESTRUCTIVE_ANNOTATIONS,
    requiresConfirmation: true,
  }),
]);

export function workspaceToolByName(name: WorkspaceToolName): WorkspaceToolDefinition {
  const t = WORKSPACE_TOOLS.find((d) => d.name === name);
  if (!t) throw new Error(`unknown workspace tool ${name}`);
  return t;
}

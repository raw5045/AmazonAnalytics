/**
 * The workspace service (spec 2026-09-30 §8, §10): one method per tool. Every call runs
 * validate → reserve (the per-minute bucket, rows 0) → daily write cap (writes only) → command →
 * record (mcp_request; writes also bump mcp_write) → one log line. Everything is injected so
 * unit tests never touch a database; defaultWorkspaceDeps() wires production.
 */
import { bumpUserActivity } from '@/lib/activity/bump';
import { secondsUntilNextEtDay } from '@/lib/activity/etDay';
import { errFields } from '@/lib/ask/logSafe';
import { countUserActivityToday } from '@/lib/activity/readToday';
import * as categoryCommands from '@/lib/customCategories/commands';
import { listCustomCategoriesForUser, loadCustomCategoryForUser, type CustomCategoryDTO } from '@/lib/customCategories/loadServer';
import { MAX_CUSTOM_CATEGORIES, MAX_LEAF_PATHS_PER_CATEGORY } from '@/lib/customCategories/validation';
import { isPoolConnectTimeout } from '@/lib/db/tcpPool';
import { env } from '@/lib/env';
import type { ExplorerFilters } from '@/lib/explorer/types';
import { applyPresets } from '@/lib/research/catalog';
import { defaultCategoryDeps, resolveScope, type CategoryDeps } from '@/lib/research/categories';
import { invalid, parseSearchInput, type Filters } from '@/lib/research/contracts';
import { poolBusyError, ResearchError, type ResearchErrorCode } from '@/lib/research/errors';
import { researchLimits, type ResearchLimits } from '@/lib/research/limits';
import { keywordUrlFor } from '@/lib/research/links';
import type { ResearchActor } from '@/lib/research/service';
import { SAFE_TOOL_FAILURE } from '@/lib/research/toolErrors';
import { recordResearchActivity, reserveResearchRequest } from '@/lib/research/usage';
import * as savedViewCommands from '@/lib/savedViews/commands';
import { listSavedViewsForUser } from '@/lib/savedViews/loadServer';
import type { SavedView } from '@/lib/savedViews/types';
import { MAX_VIEWS_PER_USER } from '@/lib/savedViews/validation';
import * as watchlistCommands from '@/lib/watchlist/commands';
import { listWatchlistWithKeywords, watchlistCountForUser } from '@/lib/watchlist/loadServer';
import { MAX_WATCHED_KEYWORDS } from '@/lib/watchlist/validation';
import {
  createCustomCategoryInputSchema, createSavedViewInputSchema, deleteCustomCategoryInputSchema, deleteSavedViewInputSchema, emptyInputSchema,
  PREVIEW_LEAF_PATHS, updateCustomCategoryInputSchema, updateSavedViewInputSchema, watchlistSelectionInputSchema,
  type AddToWatchlistResponse, type CustomCategorySummary, type CustomCategoryWriteResponse, type DeleteCustomCategoryResponse,
  type DeleteSavedViewResponse, type LeafMode, type ListCustomCategoriesResponse, type ListSavedViewsResponse, type ListWatchlistResponse,
  type RemoveFromWatchlistResponse, type SavedViewSummary, type SavedViewWriteResponse, type SearchSpec, type WorkspaceService, type WorkspaceToolName,
} from './contracts';
import { compactExplorerFilters, customCategoryUrlFor, savedViewUrlFor, toExplorerFilters } from './explorerFilters';

export interface WorkspaceServiceDeps {
  limits: ResearchLimits;
  appUrl: string;
  now: () => Date;
  reserve: typeof reserveResearchRequest;
  record: typeof recordResearchActivity;
  /** Today's (ET) mcp_write count for the account. */
  countWritesToday: (userId: string) => Promise<number>;
  /** Fire-and-forget +1 on mcp_write. */
  bumpWrite: (userId: string) => void;
  categories: CategoryDeps;
  savedViews: {
    list: typeof listSavedViewsForUser;
    create: typeof savedViewCommands.createSavedView;
    update: typeof savedViewCommands.updateSavedView;
    delete: typeof savedViewCommands.deleteSavedView;
  };
  customCategories: {
    list: typeof listCustomCategoriesForUser;
    load: typeof loadCustomCategoryForUser;
    create: typeof categoryCommands.createCustomCategory;
    update: typeof categoryCommands.updateCustomCategory;
    delete: typeof categoryCommands.deleteCustomCategory;
  };
  watchlist: {
    list: typeof listWatchlistWithKeywords;
    count: typeof watchlistCountForUser;
    add: typeof watchlistCommands.addToWatchlist;
    remove: typeof watchlistCommands.removeFromWatchlist;
  };
}

export function defaultWorkspaceDeps(): WorkspaceServiceDeps {
  return {
    limits: researchLimits(),
    appUrl: env.APP_PUBLIC_URL,
    now: () => new Date(),
    reserve: reserveResearchRequest,
    record: recordResearchActivity,
    countWritesToday: (userId) => countUserActivityToday(userId, 'mcp_write'),
    bumpWrite: (userId) => {
      void bumpUserActivity(userId, 'mcp_write');
    },
    categories: defaultCategoryDeps,
    savedViews: { list: listSavedViewsForUser, create: savedViewCommands.createSavedView, update: savedViewCommands.updateSavedView, delete: savedViewCommands.deleteSavedView },
    customCategories: {
      list: listCustomCategoriesForUser, load: loadCustomCategoryForUser,
      create: categoryCommands.createCustomCategory, update: categoryCommands.updateCustomCategory, delete: categoryCommands.deleteCustomCategory,
    },
    watchlist: { list: listWatchlistWithKeywords, count: watchlistCountForUser, add: watchlistCommands.addToWatchlist, remove: watchlistCommands.removeFromWatchlist },
  };
}

let singleton: WorkspaceService | null = null;
/** One shared service per process, built from the production deps on first use. */
export function defaultWorkspaceService(): WorkspaceService {
  if (!singleton) singleton = createWorkspaceService(defaultWorkspaceDeps());
  return singleton;
}
/** Test-only. */
export function resetWorkspaceServiceForTests(): void {
  singleton = null;
}

const NOT_FOUND_MESSAGE = {
  view: 'No saved view with that id belongs to this account.',
  category: 'No custom category with that id belongs to this account.',
} as const;

type CommandFailure = { ok: false; code: savedViewCommands.SavedViewCommandCode | categoryCommands.CustomCategoryCommandCode; message: string };

/** §7: command result codes → ResearchError codes. Messages are the app's own sentences, except NOT_FOUND, which names the account scope. */
function toResearchError(r: CommandFailure, kind: keyof typeof NOT_FOUND_MESSAGE): ResearchError {
  switch (r.code) {
    case 'cap_reached':
    case 'too_many_leaves':
      return new ResearchError('LIMIT_REACHED', r.message);
    case 'duplicate_name':
      return new ResearchError('DUPLICATE_NAME', r.message);
    case 'not_found':
      return new ResearchError('NOT_FOUND', NOT_FOUND_MESSAGE[kind]);
    // Input problems the schemas mostly prevent; the command's own sentence says what was wrong.
    case 'invalid_id':
    case 'invalid_name':
    case 'nothing_to_update':
    case 'no_leaves':
      return new ResearchError('INVALID_FILTERS', r.message);
    default: {
      // A command code added later fails the typecheck here instead of silently becoming INVALID_FILTERS.
      const _exhaustive: never = r.code;
      void _exhaustive;
      return new ResearchError('INVALID_FILTERS', r.message);
    }
  }
}

/** ResearchError codes that mean the infrastructure failed, not that the request was wrong: logged as `failed`, like an unexpected error, so one alert on outcome=failed sees them. */
const INFRA_CODES: ReadonlySet<ResearchErrorCode> = new Set<ResearchErrorCode>(['DATA_UNAVAILABLE', 'QUERY_TIMEOUT']);

/**
 * §8.6: one line per call — tool, outcome, code or error name, account id, timing. Never names, keywords or paths.
 * A ResearchError is already a safe, client-facing shape and passes through unchanged. Anything else is replaced by a
 * fresh ResearchError carrying nothing from the original (no message, no cause): the MCP adapter's classifyToolError
 * logs a raw error's message and stack, and a DrizzleQueryError's message embeds the bound params (view names, filter
 * JSON, category names, leaf paths, keyword text).
 */
function logged<T>(tool: WorkspaceToolName, actor: ResearchActor, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const line = (fields: Record<string, unknown>) =>
    console.log('[workspace]', JSON.stringify({ tool, ...fields, userId: actor.localUserId, durationMs: Date.now() - started }));
  return fn().then(
    (out) => {
      line({ outcome: 'ok' });
      return out;
    },
    (e: unknown) => {
      if (e instanceof ResearchError) {
        line({ outcome: INFRA_CODES.has(e.code) ? 'failed' : 'refused', code: e.code });
        throw e;
      }
      // A DrizzleQueryError's own name is just "Error" and its message embeds the bound params, so log
      // the unwrapped name and SQLSTATE only (lib/ask/logSafe.ts reads the cause) — never a message.
      const { error, code } = errFields(e);
      line({ outcome: 'failed', error, ...(code ? { code } : {}) });
      throw isPoolConnectTimeout(e) ? poolBusyError() : new ResearchError('DATA_UNAVAILABLE', SAFE_TOOL_FAILURE.message, { retryable: true });
    },
  );
}

/**
 * §6.2: the leaves a custom category ends with after an update. `expansion` is what the caller expanded from the request's
 * categories — in remove mode only its `selections`, through the catalog. `explicitPaths` are the request's own leaf paths,
 * which remove subtracts verbatim (trimmed): a stale stored leaf the catalog no longer has must stay removable.
 */
export function applyLeafMode(args: { stored: string[]; mode: LeafMode; explicitPaths: string[]; expansion: string[] }): string[] {
  const { stored, mode, explicitPaths, expansion } = args;
  switch (mode) {
    case 'replace':
      return expansion;
    case 'add':
      return [...new Set([...stored, ...expansion])];
    case 'remove': {
      const drop = new Set([...explicitPaths.map((path) => path.trim()), ...expansion]);
      return stored.filter((path) => !drop.has(path));
    }
  }
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  const reserve = (actor: ResearchActor) =>
    deps.reserve({ userId: actor.localUserId, channel: actor.channel, rows: 0, now: deps.now(), limits: deps.limits });

  /** §8.1–8.2: the minute bucket, then the daily write cap. */
  async function beforeWrite(actor: ResearchActor): Promise<void> {
    await reserve(actor);
    const today = await deps.countWritesToday(actor.localUserId);
    if (today >= deps.limits.writesPerDay) {
      throw new ResearchError('RATE_LIMITED', `Daily limit of ${deps.limits.writesPerDay} saves reached. Try again tomorrow.`, {
        retryable: true,
        retryAfterSeconds: secondsUntilNextEtDay(deps.now()),
      });
    }
  }

  function recorded(actor: ResearchActor, write: boolean): void {
    deps.record(actor.localUserId, 0, actor.channel);
    if (write) deps.bumpWrite(actor.localUserId);
  }

  /** Like categorySummary: a department saved as a view can name up to 2,000 leaves, so the summary previews the first PREVIEW_LEAF_PATHS and says how many there are. */
  const viewSummary = (v: SavedView): SavedViewSummary => {
    const filters = compactExplorerFilters(v.filters); // a fresh object, so trimming its leafPaths never touches the stored view
    const leafCount = v.filters.leafPaths.length;
    if (filters.leafPaths) filters.leafPaths = filters.leafPaths.slice(0, PREVIEW_LEAF_PATHS);
    return {
      id: v.id, name: v.name, explorerUrl: savedViewUrlFor(deps.appUrl, v.id), filters, leafCount, previewComplete: leafCount <= PREVIEW_LEAF_PATHS,
      createdAt: v.createdAt, updatedAt: v.updatedAt,
    };
  };
  const categorySummary = (c: CustomCategoryDTO): CustomCategorySummary => ({
    id: c.id, name: c.name, leafCount: c.leafPaths.length, previewPaths: c.leafPaths.slice(0, PREVIEW_LEAF_PATHS), previewComplete: c.leafPaths.length <= PREVIEW_LEAF_PATHS,
    explorerUrl: customCategoryUrlFor(deps.appUrl, c.id), createdAt: c.createdAt, updatedAt: c.updatedAt,
  });

  /** §5.1: the search's own validation (schema → presets → full scope), then the taxonomy-only leaves for the converter. */
  async function convertSearch(userId: string, search: SearchSpec): Promise<{ filters: ExplorerFilters; notes: string[] }> {
    const parsed = parseSearchInput({ schemaVersion: 1, ...search });
    // Unreachable: searchSpecSchema is strict and omits `cursor`, so parseSearchInput never sees one here. Kept only so `parsed` narrows to the new-search branch.
    if (parsed.kind === 'continuation') throw new ResearchError('INVALID_FILTERS', 'Pass the search criteria, never a cursor.');
    const { filters, sort, comparisonWindow } = applyPresets(parsed.request);
    const full = await resolveScope(userId, filters.categories, deps.limits.maxExpandedLeaves, deps.categories);
    const hasCustom = filters.categories.selections.some((s) => s.kind === 'custom');
    const taxonomyOnly: Filters['categories'] = { selections: filters.categories.selections.filter((s) => s.kind === 'taxonomy'), leafPaths: filters.categories.leafPaths };
    const leaves = hasCustom ? (await resolveScope(userId, taxonomyOnly, deps.limits.maxExpandedLeaves, deps.categories)).leaves : full.leaves;
    return toExplorerFilters({ filters, sort, window: comparisonWindow, leaves });
  }

  /** §6.2: a category may hold a whole department, so the cap here is the column's, not the search's. */
  async function expandForCategory(userId: string, categories: Filters['categories']): Promise<string[]> {
    return (await resolveScope(userId, categories, MAX_LEAF_PATHS_PER_CATEGORY, deps.categories)).leaves;
  }

  async function listSavedViews(actor: ResearchActor, input: unknown): Promise<ListSavedViewsResponse> {
    const p = emptyInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await reserve(actor);
    const views = (await deps.savedViews.list(actor.localUserId)).map(viewSummary);
    recorded(actor, false);
    return { views, count: views.length, limit: MAX_VIEWS_PER_USER };
  }

  async function listCustomCategories(actor: ResearchActor, input: unknown): Promise<ListCustomCategoriesResponse> {
    const p = emptyInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await reserve(actor);
    const categories = (await deps.customCategories.list(actor.localUserId)).map(categorySummary);
    recorded(actor, false);
    return { categories, count: categories.length, limit: MAX_CUSTOM_CATEGORIES };
  }

  async function listWatchlist(actor: ResearchActor, input: unknown): Promise<ListWatchlistResponse> {
    const p = emptyInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await reserve(actor);
    const items = (await deps.watchlist.list(actor.localUserId)).map((i) => ({
      searchTermId: i.keywordId, keyword: i.keyword, keywordUrl: keywordUrlFor(deps.appUrl, i.keywordId), addedAt: i.addedAt,
    }));
    recorded(actor, false);
    return { items, count: items.length, limit: MAX_WATCHED_KEYWORDS };
  }

  async function createSavedView(actor: ResearchActor, input: unknown): Promise<SavedViewWriteResponse> {
    const p = createSavedViewInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    const { filters, notes } = await convertSearch(actor.localUserId, p.data.search);
    const r = await deps.savedViews.create(actor.localUserId, { name: p.data.name, filters });
    if (!r.ok) throw toResearchError(r, 'view');
    recorded(actor, true);
    return { view: viewSummary(r.view), notes };
  }

  async function updateSavedView(actor: ResearchActor, input: unknown): Promise<SavedViewWriteResponse> {
    const p = updateSavedViewInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    let filters: ExplorerFilters | undefined;
    let notes: string[] = [];
    if (p.data.search) ({ filters, notes } = await convertSearch(actor.localUserId, p.data.search));
    const r = await deps.savedViews.update(actor.localUserId, p.data.id, { name: p.data.name, filters });
    if (!r.ok) throw toResearchError(r, 'view');
    recorded(actor, true);
    return { view: viewSummary(r.view), notes };
  }

  async function deleteSavedView(actor: ResearchActor, input: unknown): Promise<DeleteSavedViewResponse> {
    const p = deleteSavedViewInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    const r = await deps.savedViews.delete(actor.localUserId, p.data.id);
    if (!r.ok) throw toResearchError(r, 'view');
    recorded(actor, true);
    return { deleted: r.deleted };
  }

  async function createCustomCategory(actor: ResearchActor, input: unknown): Promise<CustomCategoryWriteResponse> {
    const p = createCustomCategoryInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    const leafPaths = await expandForCategory(actor.localUserId, p.data.categories);
    const r = await deps.customCategories.create(actor.localUserId, { name: p.data.name, leafPaths });
    if (!r.ok) throw toResearchError(r, 'category');
    recorded(actor, true);
    return { category: categorySummary(r.category), notes: [] };
  }

  async function updateCustomCategory(actor: ResearchActor, input: unknown): Promise<CustomCategoryWriteResponse> {
    const p = updateCustomCategoryInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    let leafPaths: string[] | undefined;
    if (p.data.categories) {
      const existing = await deps.customCategories.load(actor.localUserId, p.data.id);
      if (!existing) throw new ResearchError('NOT_FOUND', NOT_FOUND_MESSAGE.category);
      const { selections, leafPaths: explicitPaths } = p.data.categories;
      const mode = p.data.leafMode;
      // Remove expands only the selections through the catalog: its explicit paths are subtracted verbatim by applyLeafMode,
      // so a stale stored leaf the catalog no longer has (resolveScope would reject it) stays removable. The other modes expand everything.
      const toExpand: Filters['categories'] = mode === 'remove' ? { selections, leafPaths: [] } : p.data.categories;
      const expansion = toExpand.selections.length + toExpand.leafPaths.length > 0 ? await expandForCategory(actor.localUserId, toExpand) : [];
      leafPaths = applyLeafMode({ stored: existing.leafPaths, mode, explicitPaths, expansion });
    }
    const r = await deps.customCategories.update(actor.localUserId, p.data.id, { name: p.data.name, leafPaths });
    if (!r.ok) throw toResearchError(r, 'category');
    recorded(actor, true);
    return { category: categorySummary(r.category), notes: [] };
  }

  async function deleteCustomCategory(actor: ResearchActor, input: unknown): Promise<DeleteCustomCategoryResponse> {
    const p = deleteCustomCategoryInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    const r = await deps.customCategories.delete(actor.localUserId, p.data.id);
    if (!r.ok) throw toResearchError(r, 'category');
    recorded(actor, true);
    return { deleted: r.deleted };
  }

  async function addToWatchlist(actor: ResearchActor, input: unknown): Promise<AddToWatchlistResponse> {
    const p = watchlistSelectionInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    const r = await deps.watchlist.add(actor.localUserId, { keywords: p.data.keywords, searchTermIds: p.data.searchTermIds });
    // Record before the trailing count read: a write that landed counts toward the daily cap even if that read then fails.
    recorded(actor, true);
    const watching = await deps.watchlist.count(actor.localUserId);
    return { ...r, watching, limit: MAX_WATCHED_KEYWORDS };
  }

  async function removeFromWatchlist(actor: ResearchActor, input: unknown): Promise<RemoveFromWatchlistResponse> {
    const p = watchlistSelectionInputSchema.safeParse(input);
    if (!p.success) throw invalid(p.error);
    await beforeWrite(actor);
    const r = await deps.watchlist.remove(actor.localUserId, { keywords: p.data.keywords, searchTermIds: p.data.searchTermIds });
    // Record before the trailing count read: a write that landed counts toward the daily cap even if that read then fails.
    recorded(actor, true);
    const watching = await deps.watchlist.count(actor.localUserId);
    return { ...r, watching, limit: MAX_WATCHED_KEYWORDS };
  }

  return {
    listSavedViews: (a, i) => logged('list_saved_views', a, () => listSavedViews(a, i)),
    listCustomCategories: (a, i) => logged('list_custom_categories', a, () => listCustomCategories(a, i)),
    listWatchlist: (a, i) => logged('list_watchlist', a, () => listWatchlist(a, i)),
    createSavedView: (a, i) => logged('create_saved_view', a, () => createSavedView(a, i)),
    updateSavedView: (a, i) => logged('update_saved_view', a, () => updateSavedView(a, i)),
    deleteSavedView: (a, i) => logged('delete_saved_view', a, () => deleteSavedView(a, i)),
    createCustomCategory: (a, i) => logged('create_custom_category', a, () => createCustomCategory(a, i)),
    updateCustomCategory: (a, i) => logged('update_custom_category', a, () => updateCustomCategory(a, i)),
    deleteCustomCategory: (a, i) => logged('delete_custom_category', a, () => deleteCustomCategory(a, i)),
    addToWatchlist: (a, i) => logged('add_to_watchlist', a, () => addToWatchlist(a, i)),
    removeFromWatchlist: (a, i) => logged('remove_from_watchlist', a, () => removeFromWatchlist(a, i)),
  };
}

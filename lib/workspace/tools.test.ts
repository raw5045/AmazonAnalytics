// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/env', () => ({ env: {} }));
import { MAX_NAME_LENGTH as CUSTOM_CATEGORY_NAME_MAX } from '@/lib/customCategories/validation';
import { PREVIEW_PATHS } from '@/lib/research/categories';
import { DEFAULT_LIMITS } from '@/lib/research/limits';
import { READ_ONLY_ANNOTATIONS } from '@/lib/research/tools';
import type { ResearchActor } from '@/lib/research/service';
import { MAX_NAME_LENGTH as SAVED_VIEW_NAME_MAX } from '@/lib/savedViews/validation';
import {
  createCustomCategoryInputSchema, createSavedViewInputSchema, deleteSavedViewInputSchema, PREVIEW_LEAF_PATHS, updateCustomCategoryInputSchema, updateSavedViewInputSchema,
  watchlistSelectionInputSchema, WORKSPACE_TOOL_NAMES, type WorkspaceService,
} from './contracts';
import { ADDITIVE_ANNOTATIONS, CREATE_ANNOTATIONS, DESTRUCTIVE_ANNOTATIONS, WORKSPACE_TOOLS, workspaceToolByName } from './tools';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'client_claude', channel: 'mcp', isAdmin: false };
const ID = '11111111-1111-4111-8111-111111111111';
// Has hex letters, unlike ID (all digits, so uppercasing it changes nothing): for the id-lowercasing test.
const HEX_ID = 'abcdef12-abcd-4abc-8abc-abcdef123456';

describe('WORKSPACE_TOOLS', () => {
  it('lists the eleven tools in order: three read-only lists, then the eight writes that need confirmation', () => {
    expect(WORKSPACE_TOOL_NAMES).toEqual([
      'list_saved_views', 'list_custom_categories', 'list_watchlist',
      'create_saved_view', 'update_saved_view', 'delete_saved_view',
      'create_custom_category', 'update_custom_category', 'delete_custom_category',
      'add_to_watchlist', 'remove_from_watchlist',
    ]);
    expect(WORKSPACE_TOOLS.map((t) => t.name)).toEqual([...WORKSPACE_TOOL_NAMES]);
    expect(Object.isFrozen(WORKSPACE_TOOLS)).toBe(true);
    for (const t of WORKSPACE_TOOLS) {
      expect(Object.isFrozen(t)).toBe(true);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.description(DEFAULT_LIMITS).length).toBeGreaterThan(40);
      expect(t.annotations.openWorldHint).toBe(false);
      expect(t.requiresConfirmation).toBe(!t.annotations.readOnlyHint);
    }
  });
  it('annotates per spec §3: lists read-only, creates non-idempotent, the watchlist add additive, updates/deletes/removals destructive', () => {
    for (const n of ['list_saved_views', 'list_custom_categories', 'list_watchlist'] as const) expect(workspaceToolByName(n).annotations).toEqual(READ_ONLY_ANNOTATIONS);
    for (const n of ['create_saved_view', 'create_custom_category'] as const) expect(workspaceToolByName(n).annotations).toEqual(CREATE_ANNOTATIONS);
    expect(workspaceToolByName('add_to_watchlist').annotations).toEqual(ADDITIVE_ANNOTATIONS);
    for (const n of ['update_saved_view', 'update_custom_category', 'delete_saved_view', 'delete_custom_category', 'remove_from_watchlist'] as const) expect(workspaceToolByName(n).annotations).toEqual(DESTRUCTIVE_ANNOTATIONS);
    // Literal pins, so a flipped flag in a constant cannot pass by comparing the constant with itself.
    expect(CREATE_ANNOTATIONS).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(ADDITIVE_ANNOTATIONS).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(DESTRUCTIVE_ANNOTATIONS).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect(workspaceToolByName('delete_saved_view').description(DEFAULT_LIMITS)).toContain('permanently');
    expect(workspaceToolByName('delete_custom_category').description(DEFAULT_LIMITS)).toContain('shows every category');
    expect(workspaceToolByName('remove_from_watchlist').description(DEFAULT_LIMITS)).toContain('Not permanent');
  });
  it('the saved-view descriptions say the stored leaf categories are previewed, with leafCount', () => {
    expect(workspaceToolByName('list_saved_views').description(DEFAULT_LIMITS)).toContain(`leaf categories are previewed: the first ${PREVIEW_LEAF_PATHS} of leafCount`);
    for (const n of ['create_saved_view', 'update_saved_view'] as const) {
      expect(workspaceToolByName(n).description(DEFAULT_LIMITS), n).toContain('its compact filters (leaf categories previewed, with leafCount)');
    }
  });
  it('the saved-view and custom-category write descriptions name the count and limit their results carry (2026-10-04: the chat model mis-computed free slots)', () => {
    for (const n of ['create_saved_view', 'update_saved_view', 'delete_saved_view'] as const) {
      expect(workspaceToolByName(n).description(DEFAULT_LIMITS), n).toContain('count (how many saved views the account has after this call) and limit (the cap)');
    }
    for (const n of ['create_custom_category', 'update_custom_category', 'delete_custom_category'] as const) {
      expect(workspaceToolByName(n).description(DEFAULT_LIMITS), n).toContain('count (how many custom categories the account has after this call) and limit (the cap)');
    }
  });
  it('previews as many leaf paths as a search scope does', () => {
    // Intentional: research's resolvedCategoryScope.previewPaths and the workspace category/view summaries preview the same number of paths.
    expect(PREVIEW_LEAF_PATHS).toBe(PREVIEW_PATHS);
  });
  it('every write description ends with the confirmation sentence and no list description carries it', () => {
    for (const t of WORKSPACE_TOOLS) {
      expect(t.description(DEFAULT_LIMITS).endsWith('Clients normally ask the person before this runs.'), t.name).toBe(t.requiresConfirmation);
    }
  });
  it('every input schema is strict: an unknown key is rejected with unrecognized_keys, never silently dropped', () => {
    for (const t of WORKSPACE_TOOLS) {
      const r = t.inputSchema.safeParse({ __probe: 1 });
      expect(r.success, t.name).toBe(false);
      expect(r.success ? [] : r.error.issues.map((i) => i.code), t.name).toContain('unrecognized_keys');
    }
  });
  it('run() dispatches to the matching service method with the actor and raw args', async () => {
    const service = Object.fromEntries(WORKSPACE_TOOL_NAMES.map((n) => [camel(n), vi.fn(async () => ({ tool: n }))])) as unknown as WorkspaceService;
    for (const n of WORKSPACE_TOOL_NAMES) {
      await expect(workspaceToolByName(n).run(service, actor, { any: 1 })).resolves.toEqual({ tool: n });
      expect((service as unknown as Record<string, ReturnType<typeof vi.fn>>)[camel(n)]).toHaveBeenCalledWith(actor, { any: 1 });
    }
  });
});

/** list_saved_views → listSavedViews, add_to_watchlist → addToWatchlist. */
function camel(n: string): string {
  return n.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

describe('input schemas', () => {
  it('a saved view takes the search criteria (a pageSize is accepted, a cursor never), and a name of 1–80 characters', () => {
    expect(createSavedViewInputSchema.safeParse({ name: 'Lamps', search: { schemaVersion: 1, filters: { text: { value: 'lamp' } } } }).success).toBe(true);
    expect(createSavedViewInputSchema.safeParse({ name: 'Lamps', search: { cursor: 'c'.repeat(20) } }).success).toBe(false);
    // A model may copy its search_keywords arguments as-is: pageSize parses with the search's own bounds (the service ignores it).
    expect(createSavedViewInputSchema.safeParse({ name: 'Lamps', search: { pageSize: 50 } }).success).toBe(true);
    expect(createSavedViewInputSchema.safeParse({ name: 'Lamps', search: { pageSize: 101 } }).success).toBe(false);
    expect(updateSavedViewInputSchema.safeParse({ id: ID, search: { pageSize: 50 } }).success).toBe(true);
    expect(updateSavedViewInputSchema.safeParse({ id: ID, search: { cursor: 'c'.repeat(20) } }).success).toBe(false);
    expect(createSavedViewInputSchema.safeParse({ name: '', search: {} }).success).toBe(false);
    expect(createSavedViewInputSchema.safeParse({ name: 'x'.repeat(81), search: {} }).success).toBe(false);
    expect(createSavedViewInputSchema.safeParse({ name: 'Lamps', search: {}, extra: 1 }).success).toBe(false);
  });
  it('an update needs a name, a search/categories object, or both', () => {
    expect(updateSavedViewInputSchema.safeParse({ id: ID }).success).toBe(false);
    expect(updateSavedViewInputSchema.safeParse({ id: ID, name: 'New' }).success).toBe(true);
    expect(updateSavedViewInputSchema.safeParse({ id: 'nope', name: 'New' }).success).toBe(false);
    expect(updateCustomCategoryInputSchema.safeParse({ id: ID }).success).toBe(false);
    const parsed = updateCustomCategoryInputSchema.safeParse({ id: ID, categories: { leafPaths: ['A › B'] } });
    expect(parsed.success && parsed.data.leafMode).toBe('replace');
    expect(updateCustomCategoryInputSchema.safeParse({ id: ID, categories: { leafPaths: ['A › B'] }, leafMode: 'merge' }).success).toBe(false);
  });
  it('a custom category needs at least one selection or leaf path', () => {
    expect(createCustomCategoryInputSchema.safeParse({ name: 'L', categories: {} }).success).toBe(false);
    expect(createCustomCategoryInputSchema.safeParse({ name: 'L', categories: { selections: [{ kind: 'taxonomy', path: 'Lighting' }] } }).success).toBe(true);
    expect(createCustomCategoryInputSchema.safeParse({ name: 'L', categories: { selections: [{ kind: 'custom', id: ID }] } }).success).toBe(true);
  });
  it('a watchlist call takes 1–100 items across keywords and ids', () => {
    expect(watchlistSelectionInputSchema.safeParse({}).success).toBe(false);
    expect(watchlistSelectionInputSchema.safeParse({ keywords: ['desk lamp'] }).success).toBe(true);
    expect(watchlistSelectionInputSchema.safeParse({ searchTermIds: [ID] }).success).toBe(true);
    expect(watchlistSelectionInputSchema.safeParse({ searchTermIds: ['nope'] }).success).toBe(false);
    expect(watchlistSelectionInputSchema.safeParse({ keywords: Array.from({ length: 60 }, (_, i) => `k${i}`), searchTermIds: Array.from({ length: 41 }, () => ID) }).success).toBe(false);
  });
  it('accepts an empty search (the service fills schemaVersion), an 80-character name, and 50 + 50 watchlist items; rejects a whitespace-only name', () => {
    expect(createSavedViewInputSchema.safeParse({ name: 'Lamps', search: {} }).success).toBe(true);
    expect(createSavedViewInputSchema.safeParse({ name: 'x'.repeat(80), search: {} }).success).toBe(true);
    expect(createSavedViewInputSchema.safeParse({ name: '   ', search: {} }).success).toBe(false);
    expect(watchlistSelectionInputSchema.safeParse({ keywords: Array.from({ length: 50 }, (_, i) => `k${i}`), searchTermIds: Array.from({ length: 50 }, () => ID) }).success).toBe(true);
    expect(SAVED_VIEW_NAME_MAX).toBe(CUSTOM_CATEGORY_NAME_MAX); // one nameSchema serves both resources
  });
  it('lowercases ids, so an uppercase uuid still reaches the owner-scoped lookups', () => {
    expect(deleteSavedViewInputSchema.parse({ id: HEX_ID.toUpperCase() }).id).toBe(HEX_ID);
    expect(watchlistSelectionInputSchema.parse({ searchTermIds: [HEX_ID.toUpperCase()] }).searchTermIds).toEqual([HEX_ID]);
  });
});

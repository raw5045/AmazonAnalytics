/**
 * Spec 2026-10-01 §3: which workspace tools are changes and which are deletes. A static list,
 * not derived from lib/workspace/tools.ts, because this module is rendered in the browser
 * (ApprovalCard) and importing the definitions would pull their whole graph (zod schemas, the
 * research contracts, the Explorer query builder) into the client bundle; writeKinds.test.ts
 * keeps the two in step. Reads (list_*) are neither and never need a card.
 */
export type WriteKind = 'change' | 'delete';

/** The two permanent writes: a card every time unless the deletes toggle is on. */
export const DELETE_TOOLS: ReadonlySet<string> = new Set(['delete_saved_view', 'delete_custom_category']);
/** Creates, updates and watchlist adds/removes (remove_from_watchlist is a change: not permanent). */
export const CHANGE_TOOLS: ReadonlySet<string> = new Set([
  'create_saved_view', 'update_saved_view', 'create_custom_category', 'update_custom_category', 'add_to_watchlist', 'remove_from_watchlist',
]);

/** null for a list tool, a research tool or an unknown name. Never throws. */
export function writeKind(name: string): WriteKind | null {
  if (DELETE_TOOLS.has(name)) return 'delete';
  if (CHANGE_TOOLS.has(name)) return 'change';
  return null;
}

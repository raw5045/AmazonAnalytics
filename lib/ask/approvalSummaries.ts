/**
 * Spec 2026-10-01 §5: one plain-English line per pending write, built from the tool's own input,
 * for the approval card. Pure and import-free: imported by browser code (ApprovalCard), so the
 * workspace definitions cannot be imported here; TITLES copies their titles and
 * approvalSummaries.test.ts pins the parity. Never throws — a malformed input falls back to the
 * tool's title: a line is built only when the input carries what it needs (a name to create, an
 * id to update or delete, something to change, at least one item).
 */

/** The eleven titles, copied from lib/workspace/tools.ts (parity-tested). */
export const TITLES: Readonly<Record<string, string>> = Object.freeze({
  list_saved_views: 'List saved views',
  list_custom_categories: 'List custom categories',
  list_watchlist: 'List watchlist',
  create_saved_view: 'Create saved view',
  update_saved_view: 'Update saved view',
  delete_saved_view: 'Delete saved view',
  create_custom_category: 'Create custom category',
  update_custom_category: 'Update custom category',
  delete_custom_category: 'Delete custom category',
  add_to_watchlist: 'Add to watchlist',
  remove_from_watchlist: 'Remove from watchlist',
});

/** Names the card can resolve ids to (loaded client-side from the member's own lists; empty while loading). */
export interface ApprovalNames { views: Record<string, string>; categories: Record<string, string> }

const q = (s: string) => `‘${s}’`;
const shortId = (id: string) => `…${id.slice(-8)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');
/** A map's own entry only: a key such as 'constructor' or '__proto__' never reads Object.prototype. */
const own = (m: Readonly<Record<string, unknown>>, key: string): string | null => (Object.hasOwn(m, key) ? str(m[key]) : null);

/** ‘Name’ from the member's lists, else the id's last 8 characters (while the lists load, or if they fail); null without an id. */
function nameOf(kind: keyof ApprovalNames, id: unknown, names: ApprovalNames): string | null {
  const s = str(id);
  if (!s) return null;
  const known = own(names[kind], s) ?? own(names[kind], s.toLowerCase());
  return known ? q(known) : shortId(s);
}

/** "2 selections", "1 leaf path", "2 selections and 1 leaf path" — from a categories input ({ selections, leafPaths }); null when it names nothing. */
function categoriesCount(v: unknown): string | null {
  if (!isRecord(v)) return null;
  const selections = list(v.selections).filter(isRecord).length;
  const leafPaths = strings(v.leafPaths).length;
  if (selections > 0 && leafPaths > 0) return `${plural(selections, 'selection')} and ${plural(leafPaths, 'leaf path')}`;
  if (selections > 0) return plural(selections, 'selection');
  if (leafPaths > 0) return plural(leafPaths, 'leaf path');
  return null;
}

/** An update's leaf change with its leafMode in words: "add 1 selection", "replace its leaves with 2 leaf paths"; null without one. */
function leafChange(input: Record<string, unknown>): string | null {
  const count = categoriesCount(input.categories);
  if (!count) return null;
  // replace is the schema's default; an unrecognised mode reads as replace too, the most sweeping of the three.
  const verb = input.leafMode === 'add' || input.leafMode === 'remove' ? input.leafMode : 'replace its leaves with';
  return `${verb} ${count}`;
}

/** How many keywords (texts and ids) and the first three texts: ": desk lamp, floor lamp, led strip (+17)". */
function keywordsPhrase(input: Record<string, unknown>): { count: number; sample: string } {
  const keywords = strings(input.keywords);
  const count = keywords.length + strings(input.searchTermIds).length;
  const shown = keywords.slice(0, 3);
  const extra = count - shown.length;
  const sample = shown.length === 0 ? '' : `: ${shown.join(', ')}${extra > 0 ? ` (+${extra})` : ''}`;
  return { count, sample };
}

export function summarizeApproval(toolName: string, input: unknown, names: ApprovalNames): string {
  const fallback = own(TITLES, toolName) ?? toolName;
  try {
    if (!isRecord(input)) return fallback;
    switch (toolName) {
      case 'create_saved_view': {
        const name = str(input.name);
        return name ? `Save a view named ${q(name)}` : fallback;
      }
      case 'update_saved_view': {
        const view = nameOf('views', input.id, names);
        const name = str(input.name);
        const filters = isRecord(input.search);
        if (!view) return fallback;
        if (name && filters) return `Rename the view ${view} to ${q(name)} and replace its filters`;
        if (name) return `Rename the view ${view} to ${q(name)}`;
        if (filters) return `Replace the filters of the view ${view}`;
        return fallback;
      }
      case 'delete_saved_view': {
        const view = nameOf('views', input.id, names);
        return view ? `Delete the view ${view} — permanent` : fallback;
      }
      case 'create_custom_category': {
        const name = str(input.name);
        const count = categoriesCount(input.categories);
        return name && count ? `Create the category ${q(name)} from ${count}` : fallback;
      }
      case 'update_custom_category': {
        const category = nameOf('categories', input.id, names);
        const name = str(input.name);
        const change = leafChange(input);
        if (!category) return fallback;
        if (name && change) return `Rename the category ${category} to ${q(name)} and ${change}`;
        if (change) return `Change the category ${category}: ${change}`;
        if (name) return `Rename the category ${category} to ${q(name)}`;
        return fallback;
      }
      case 'delete_custom_category': {
        const category = nameOf('categories', input.id, names);
        return category ? `Delete the category ${category} — permanent; saved views that filter on it lose that filter` : fallback;
      }
      case 'add_to_watchlist': {
        const { count, sample } = keywordsPhrase(input);
        return count > 0 ? `Add ${plural(count, 'keyword')} to the watchlist${sample}` : fallback;
      }
      case 'remove_from_watchlist': {
        const { count, sample } = keywordsPhrase(input);
        return count > 0 ? `Remove ${plural(count, 'keyword')} from the watchlist${sample}` : fallback;
      }
      default:
        return fallback;
    }
  } catch {
    return fallback;
  }
}

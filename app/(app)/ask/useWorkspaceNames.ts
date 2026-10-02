'use client';
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { getToolName, isToolUIPart } from 'ai';
import type { ApprovalNames } from '@/lib/ask/approvalSummaries';
import type { AskUIMessage } from '@/lib/ask/conversations';

type NameMap = Record<string, string>;
type ListKind = keyof ApprovalNames;
/** The existing GET list routes, one per kind. */
const LIST_URLS: Readonly<Record<ListKind, string>> = { views: '/api/explorer/saved-views', categories: '/api/category-builder/custom' };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Keys lowercased: the summaries look an input id up as given and lowercased, and Postgres returns lowercase ids. */
function add(map: NameMap, item: unknown): void {
  if (isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string') map[item.id.toLowerCase()] = item.name;
}
function addAll(map: NameMap, items: unknown): void {
  if (Array.isArray(items)) for (const item of items) add(map, item);
}

/**
 * Names the chat itself produced, from its tool results (lib/workspace/contracts.ts): the list
 * tools' items, a create/update result's `view` / `category`, and a delete result's `deleted`.
 * Later results win (a rename). Error results and every other tool are ignored. Across a reload,
 * page.tsx keeps a reduced output on the workspace writes (`{ view | category | deleted: { id,
 * name } }`), so a write's record keeps its name; list (and research) outputs exist only live.
 */
function namesFromResults(messages: AskUIMessage[]): ApprovalNames {
  const views: NameMap = {};
  const categories: NameMap = {};
  for (const m of messages) {
    for (const p of m.parts) {
      if (!isToolUIPart(p) || p.state !== 'output-available' || !isRecord(p.output)) continue;
      const out = p.output;
      switch (getToolName(p)) {
        case 'list_saved_views': addAll(views, out.views); break;
        case 'list_custom_categories': addAll(categories, out.categories); break;
        case 'create_saved_view': case 'update_saved_view': add(views, out.view); break;
        case 'create_custom_category': case 'update_custom_category': add(categories, out.category); break;
        case 'delete_saved_view': add(views, out.deleted); break;
        case 'delete_custom_category': add(categories, out.deleted); break;
      }
    }
  }
  return { views, categories };
}

/** The list a card's `id` is named from: *_saved_view → saved views, *_custom_category → categories. Creates and the watchlist carry no id to name. */
function listOf(toolName: string): ListKind | null {
  if (toolName.endsWith('_saved_view')) return 'views';
  if (toolName.endsWith('_custom_category')) return 'categories';
  return null;
}

/**
 * The ids that open cards (asked, or answered here and not sent yet) carry for one list and that
 * no known name resolves — sorted and joined, '' when there are none. Only these are fetched: a new
 * card with an unknown id (say, a view an earlier approved write just created) asks again; an
 * answer, a known id or a record (its name travels in its own result) does not.
 */
function unresolvedIds(messages: AskUIMessage[], kind: ListKind, known: ApprovalNames): string {
  const ids = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (!isToolUIPart(p) || (p.state !== 'approval-requested' && p.state !== 'approval-responded')) continue;
      if (listOf(getToolName(p)) !== kind || !isRecord(p.input) || typeof p.input.id !== 'string') continue;
      const id = p.input.id.toLowerCase();
      if (!Object.hasOwn(known[kind], id)) ids.add(id);
    }
  }
  return [...ids].sort().join(' ');
}

/** id → name from one of the existing GET list routes; empty when the request fails or the body is not the expected list. */
async function fetchNames(url: string, key: ListKind, signal: AbortSignal): Promise<NameMap> {
  const map: NameMap = {};
  try {
    const res = await fetch(url, { credentials: 'same-origin', signal });
    if (!res.ok) return map;
    const body: unknown = await res.json();
    if (isRecord(body)) addAll(map, body[key]);
  } catch {
    // Aborted, offline or not JSON: nothing learned; the card shows the id's last 8 characters.
  }
  return map;
}

/**
 * Fetches one list while `unresolved` (its ids no name resolves) is non-empty. A changed set aborts
 * the request in flight and asks again; names accumulate; a failed fetch adds nothing (the card
 * then shows the id's last 8 characters, and the same set is not retried).
 */
function useListNames(kind: ListKind, unresolved: string, setFetched: Dispatch<SetStateAction<ApprovalNames>>): void {
  useEffect(() => {
    if (unresolved === '') return;
    const controller = new AbortController();
    void fetchNames(LIST_URLS[kind], kind, controller.signal).then((found) => {
      if (!controller.signal.aborted) setFetched((prev) => ({ ...prev, [kind]: { ...prev[kind], ...found } }));
    });
    return () => controller.abort();
  }, [kind, unresolved, setFetched]);
}

/**
 * Spec 2026-10-01 §5: what the approval cards resolve view and category ids to. Two sources, the
 * chat's own results winning: (1) names the chat produced (above), derived on every render; (2) the
 * member's own lists — GET /api/explorer/saved-views and GET /api/category-builder/custom — each
 * fetched only when an open card carries an id of its kind that nothing resolves yet (a create or a
 * watchlist card never fetches). Fetched names accumulate for the life of the thread, so a view
 * deleted on an earlier card keeps its name on that record when a later card fetches again.
 */
export function useWorkspaceNames(messages: AskUIMessage[]): ApprovalNames {
  const own = useMemo(() => namesFromResults(messages), [messages]);
  const [fetched, setFetched] = useState<ApprovalNames>({ views: {}, categories: {} });
  const names = useMemo(() => ({ views: { ...fetched.views, ...own.views }, categories: { ...fetched.categories, ...own.categories } }), [fetched, own]);
  useListNames('views', unresolvedIds(messages, 'views', names), setFetched);
  useListNames('categories', unresolvedIds(messages, 'categories', names), setFetched);
  return names;
}

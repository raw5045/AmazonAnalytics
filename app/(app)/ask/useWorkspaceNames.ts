'use client';
import { useEffect, useMemo, useState } from 'react';
import { getToolName, isToolUIPart } from 'ai';
import type { ApprovalNames } from '@/lib/ask/approvalSummaries';
import type { AskUIMessage } from '@/lib/ask/conversations';

type NameMap = Record<string, string>;

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
 * Later results win (a rename). Error results and every other tool are ignored. Only live results
 * carry an output: page.tsx strips tool outputs from a reloaded chat.
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

/**
 * Every approval id in the chat, sorted: '' while no part carries an approval. A new card adds an
 * id, so the lookup runs again (picking up what an earlier approved write just created); an answer
 * only changes a part's state, so it does not (that fetch would race the very write it waits for).
 */
function approvalKey(messages: AskUIMessage[]): string {
  const ids = new Set<string>();
  for (const m of messages) for (const p of m.parts) if (isToolUIPart(p) && p.approval) ids.add(p.approval.id);
  return [...ids].sort().join(' ');
}

/** id → name from one of the existing GET list routes; empty when the request fails or the body is not the expected list. */
async function fetchNames(url: string, key: 'views' | 'categories', signal: AbortSignal): Promise<NameMap> {
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
 * Spec 2026-10-01 §5: what the approval cards resolve view and category ids to. Two sources, the
 * chat's own results winning: (1) names the chat produced (above), derived on every render; (2) the
 * member's own lists — GET /api/explorer/saved-views and GET /api/category-builder/custom — fetched
 * once the first part with an approval appears and again for each new card. Fetched names
 * accumulate for the life of the thread, so a view deleted on an earlier card keeps its name on that
 * record when a later card fetches again; a failed fetch adds nothing.
 */
export function useWorkspaceNames(messages: AskUIMessage[]): ApprovalNames {
  const own = useMemo(() => namesFromResults(messages), [messages]);
  const key = useMemo(() => approvalKey(messages), [messages]);
  const [fetched, setFetched] = useState<ApprovalNames>({ views: {}, categories: {} });
  useEffect(() => {
    if (key === '') return;
    const controller = new AbortController();
    void Promise.all([
      fetchNames('/api/explorer/saved-views', 'views', controller.signal),
      fetchNames('/api/category-builder/custom', 'categories', controller.signal),
    ]).then(([views, categories]) => {
      if (controller.signal.aborted) return;
      setFetched((prev) => ({ views: { ...prev.views, ...views }, categories: { ...prev.categories, ...categories } }));
    });
    return () => controller.abort();
  }, [key]);
  return useMemo(() => ({ views: { ...fetched.views, ...own.views }, categories: { ...fetched.categories, ...own.categories } }), [fetched, own]);
}

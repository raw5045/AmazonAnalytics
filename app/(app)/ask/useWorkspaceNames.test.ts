import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { AskUIMessage } from '@/lib/ask/conversations';
import { useWorkspaceNames } from './useWorkspaceNames';

const VIEW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VIEW_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const VIEW_3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const CAT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CAT_2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const VIEWS_URL = '/api/explorer/saved-views';
const CATEGORIES_URL = '/api/category-builder/custom';

const question: AskUIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'save it' }] };
const answer = (id: string, ...parts: unknown[]) => ({ id, role: 'assistant', parts }) as AskUIMessage;
/** A finished tool call and its result, as the chat route streams it. */
const result = (tool: string, output: unknown) => ({ type: `tool-${tool}`, toolCallId: `${tool}-call`, state: 'output-available', input: {}, output });
/** A write that paused for a card. */
const card = (tool: string, approvalId: string, state = 'approval-requested') => ({
  type: `tool-${tool}`, toolCallId: `${approvalId}-call`, state, input: { id: VIEW }, approval: state === 'approval-requested' ? { id: approvalId } : { id: approvalId, approved: state !== 'output-denied' },
});

/** The two GET list routes (their real shapes: extra fields beside id and name). */
function mockLists(lists: { views?: Array<{ id: string; name: string }>; categories?: Array<{ id: string; name: string }> } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === VIEWS_URL) return Response.json({ views: (lists.views ?? []).map((v) => ({ ...v, filters: {}, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })) });
    if (url === CATEGORIES_URL) return Response.json({ categories: (lists.categories ?? []).map((c) => ({ ...c, leafPaths: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })) });
    return new Response(null, { status: 404 });
  });
}
/** Lets the hook's fetch promises and the state update they end in settle. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('useWorkspaceNames (spec 2026-10-01 §5: the card names a view or category, not its id)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('learns names from the chat\'s own tool results — lists, a create/update result, a delete result — and fetches nothing while no part carries an approval', async () => {
    const fetchSpy = mockLists();
    const messages = [question, answer('a1',
      result('list_saved_views', { views: [{ id: VIEW, name: 'Lamps' }], count: 1, limit: 5 }),
      result('list_custom_categories', { categories: [{ id: CAT, name: 'Lighting' }], count: 1, limit: 25 }),
      result('create_saved_view', { view: { id: VIEW_2, name: 'Desks' }, notes: [] }),
      result('update_custom_category', { category: { id: CAT, name: 'Lighting, renamed' }, notes: [] }),
      result('delete_saved_view', { deleted: { id: VIEW_3, name: 'Old lamps' } }),
      result('delete_custom_category', { deleted: { id: CAT_2, name: 'Old lighting', leafCount: 3 } }),
      // ignored: an error result, a research tool's result, a call still waiting for its card
      result('update_saved_view', { error: { code: 'NOT_FOUND', message: 'No such view.', retryable: false } }),
      result('search_keywords', { rows: [{ id: VIEW, name: 'not a view' }] }),
    )];
    const { result: hook } = renderHook(() => useWorkspaceNames(messages));
    expect(hook.current).toEqual({
      views: { [VIEW]: 'Lamps', [VIEW_2]: 'Desks', [VIEW_3]: 'Old lamps' },
      categories: { [CAT]: 'Lighting, renamed', [CAT_2]: 'Old lighting' },
    });
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches both lists once the first part with an approval appears, and the chat\'s own results win over them', async () => {
    const fetchSpy = mockLists({ views: [{ id: VIEW, name: 'Lamps (as listed)' }, { id: VIEW_2, name: 'Desks' }], categories: [{ id: CAT, name: 'Lighting' }] });
    const before = [question, answer('a1', result('create_saved_view', { view: { id: VIEW, name: 'Lamps (as created here)' }, notes: [] }))];
    const { result: hook, rerender } = renderHook(({ messages }) => useWorkspaceNames(messages), { initialProps: { messages: before } });
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
    rerender({ messages: [...before, { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'delete it' }] }, answer('a2', card('delete_saved_view', 'ap_1'))] });
    await waitFor(() => expect(hook.current.views[VIEW_2]).toBe('Desks'));
    expect(hook.current).toEqual({ views: { [VIEW]: 'Lamps (as created here)', [VIEW_2]: 'Desks' }, categories: { [CAT]: 'Lighting' } });
    expect(fetchSpy.mock.calls.map(([url]) => url).sort()).toEqual([CATEGORIES_URL, VIEWS_URL]);
    for (const [, init] of fetchSpy.mock.calls) expect(init).toMatchObject({ credentials: 'same-origin' });
  });

  it('a reloaded chat whose cards are all answered still fetches once (its records need names too)', async () => {
    const fetchSpy = mockLists({ views: [{ id: VIEW, name: 'Lamps' }] });
    const { result: hook } = renderHook(() => useWorkspaceNames([question, answer('a1', card('update_saved_view', 'ap_1', 'output-denied'))]));
    await waitFor(() => expect(hook.current.views[VIEW]).toBe('Lamps'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when a NEW approval id appears — not on an unrelated re-render, and not when a card is only answered', async () => {
    const fetchSpy = mockLists({ views: [{ id: VIEW, name: 'Lamps' }] });
    const first = [question, answer('a1', card('delete_saved_view', 'ap_1'))];
    const { rerender } = renderHook(({ messages }) => useWorkspaceNames(messages), { initialProps: { messages: first } });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    rerender({ messages: [...first] });                                                       // a streaming update: new array, same cards
    await settle();
    const answered = [question, answer('a1', card('delete_saved_view', 'ap_1', 'approval-responded'))];
    rerender({ messages: answered });                                                          // the member answered the card
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    rerender({ messages: [...answered, { id: 'o1', role: 'user', parts: [{ type: 'text', text: '[approval-result] pending' }] }, answer('a2', card('update_saved_view', 'ap_2'))] });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4));
  });

  it('keeps a name it already fetched when a later fetch no longer lists it (a deleted view\'s record keeps its name), and takes a rename', async () => {
    const fetchSpy = mockLists({ views: [{ id: VIEW, name: 'Lamps' }, { id: VIEW_2, name: 'Desks' }] });
    const first = [question, answer('a1', card('delete_saved_view', 'ap_1'))];
    const { result: hook, rerender } = renderHook(({ messages }) => useWorkspaceNames(messages), { initialProps: { messages: first } });
    await waitFor(() => expect(hook.current.views[VIEW]).toBe('Lamps'));
    fetchSpy.mockRestore();
    mockLists({ views: [{ id: VIEW_2, name: 'Desks, renamed' }] });
    rerender({ messages: [...first, answer('a2', card('update_saved_view', 'ap_2'))] });
    await waitFor(() => expect(hook.current.views[VIEW_2]).toBe('Desks, renamed'));
    expect(hook.current.views[VIEW]).toBe('Lamps');
  });

  it('a non-OK response or a rejected fetch adds nothing: the map stays empty and the card falls back to the short id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url === VIEWS_URL) return new Response('{"error":"nope"}', { status: 500 });
      throw new TypeError('Failed to fetch');
    });
    const { result: hook } = renderHook(() => useWorkspaceNames([question, answer('a1', card('delete_saved_view', 'ap_1'))]));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    await settle();
    expect(hook.current).toEqual({ views: {}, categories: {} });
  });

  it('one list failing does not lose the other, and a body that is not a list is ignored', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url === VIEWS_URL) return Response.json({ views: 'not a list' });
      return Response.json({ categories: [{ id: CAT, name: 'Lighting' }, { id: 42, name: 'no id' }, { id: CAT_2 }] });
    });
    const { result: hook } = renderHook(() => useWorkspaceNames([question, answer('a1', card('delete_custom_category', 'ap_1'))]));
    await waitFor(() => expect(hook.current.categories[CAT]).toBe('Lighting'));
    expect(hook.current).toEqual({ views: {}, categories: { [CAT]: 'Lighting' } });
  });

  it('aborts its request on unmount', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    const { unmount } = renderHook(() => useWorkspaceNames([question, answer('a1', card('delete_saved_view', 'ap_1'))]));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const signals = fetchSpy.mock.calls.map(([, init]) => (init as RequestInit).signal as AbortSignal);
    expect(signals.every((s) => !s.aborted)).toBe(true);
    unmount();
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AskAccount } from '@/lib/ask/ledger';
const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
const auth = vi.hoisted(() => ({ user: { id: 'u1', role: 'admin' as 'admin' | 'standard_user', email: 'a@example.com' } }));
vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({ requireAuthenticatedUser: async () => auth.user }));
// getAccount is typed so a test can hand it a row; balanceMicro is read by meterFor (not mocked)
// once there is a row.
const ledger = vi.hoisted(() => ({
  getAccount: vi.fn(async (): Promise<AskAccount | null> => null), resetPeriodIfDue: vi.fn(async () => null), countMemberAccountsWithAccess: vi.fn(async () => 0),
  balanceMicro: vi.fn(() => 0),
}));
vi.mock('@/lib/ask/ledger', () => ledger);
// loadConversation has no initial-value initialiser (unlike listConversations) so its inferred
// mock type isn't narrowed to `Promise<null>` — a test below overrides it with a full conversation
// shape via mockResolvedValueOnce, which a `vi.fn(async () => null)` inference would reject.
const conv = vi.hoisted(() => ({ listConversations: vi.fn(async () => []), loadConversation: vi.fn() }));
vi.mock('@/lib/ask/conversations', () => conv);
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound'); }, useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }) }));
vi.mock('@ai-sdk/react', () => ({ useChat: () => ({ messages: [], sendMessage: vi.fn(), status: 'ready', stop: vi.fn(), error: undefined, clearError: vi.fn() }) }));
import AskPage from './page';

describe('Ask AI page', () => {
  beforeEach(() => { envMock.env = { APP_PUBLIC_URL: 'https://keywordquarry.com', ASK_AI_ENABLED: '1' }; auth.user.role = 'admin'; });
  it('renders the title, the admin preview chip while no member has access, the rail and the meter', async () => {
    render(await AskPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Ask AI' })).toBeInTheDocument();
    expect(screen.getByText('Admin preview')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New chat' })).toBeInTheDocument();
    expect(screen.getByText('Admin: usage is metered but not limited.')).toBeInTheDocument();
  });
  it('drops the chip once a member has access', async () => {
    ledger.countMemberAccountsWithAccess.mockResolvedValueOnce(3);
    render(await AskPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText('Admin preview')).toBeNull();
  });
  it('is not found for a member without access, and says so when switched off', async () => {
    auth.user.role = 'standard_user';
    await expect(AskPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('notFound');
    auth.user.role = 'admin';
    envMock.env.ASK_AI_ENABLED = undefined;
    render(await AskPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('Ask AI is switched off for now.')).toBeInTheDocument();
  });
  it('ignores a non-uuid ?c and opens a valid one', async () => {
    render(await AskPage({ searchParams: Promise.resolve({ c: 'nope' }) }));
    expect(conv.loadConversation).not.toHaveBeenCalled();
    render(await AskPage({ searchParams: Promise.resolve({ c: '11111111-1111-4111-8111-111111111111' }) }));
    expect(conv.loadConversation).toHaveBeenCalledWith('u1', '11111111-1111-4111-8111-111111111111');
  });
  it('strips tool part outputs from the messages passed to AskAi (item 6)', async () => {
    conv.loadConversation.mockResolvedValueOnce({
      conversation: {
        id: 'c1', userId: 'u1', title: 'Chat', model: 'claude-sonnet-5', messageCount: 1,
        inFlightSince: null, createdAt: new Date(), updatedAt: new Date(),
      },
      messages: [{
        id: 'm1', role: 'assistant',
        parts: [{ type: 'tool-search_keywords', toolCallId: 't1', state: 'output-available', input: {}, output: { rows: ['secret row'] } }],
        metadata: { status: 'complete' },
      }],
    });
    // AskPage returns the <AskAi ...> element without rendering it — its `.props` can be read
    // directly, which is the only way to see what actually reaches AskAi: the useChat mock above
    // ignores whatever `messages` Thread is initialised with, so nothing about it is observable
    // through the rendered DOM.
    const element = await AskPage({ searchParams: Promise.resolve({ c: '11111111-1111-4111-8111-111111111111' }) });
    const openProp = (element as unknown as { props: { open: { messages: Array<{ parts: Array<{ toolCallId?: string; output?: unknown }> }> } } }).props.open;
    const part = openProp.messages[0].parts[0];
    expect(part.output).toBeUndefined();
    expect(part.toolCallId).toBe('t1');
  });
  it('computes inFlight server-side from inFlightSince, never passing the raw timestamp to the client (item 1 / N1)', async () => {
    const conversation = (inFlightSince: Date | null) => ({
      id: 'c1', userId: 'u1', title: 'Chat', model: 'claude-sonnet-5' as const, messageCount: 1, inFlightSince, createdAt: new Date(), updatedAt: new Date(),
    });
    conv.loadConversation.mockResolvedValueOnce({ conversation: conversation(new Date(Date.now() - 60_000)), messages: [] }); // 1 minute ago
    let element = await AskPage({ searchParams: Promise.resolve({ c: '11111111-1111-4111-8111-111111111111' }) });
    let openProp = (element as unknown as { props: { open: { inFlight: boolean; inFlightSince?: unknown } } }).props.open;
    expect(openProp.inFlight).toBe(true);
    expect(openProp.inFlightSince).toBeUndefined();

    conv.loadConversation.mockResolvedValueOnce({ conversation: conversation(new Date(Date.now() - 6 * 60_000)), messages: [] }); // stale (> 5 min)
    element = await AskPage({ searchParams: Promise.resolve({ c: '11111111-1111-4111-8111-111111111111' }) });
    openProp = (element as unknown as { props: { open: { inFlight: boolean } } }).props.open;
    expect(openProp.inFlight).toBe(false);

    conv.loadConversation.mockResolvedValueOnce({ conversation: conversation(null), messages: [] });
    element = await AskPage({ searchParams: Promise.resolve({ c: '11111111-1111-4111-8111-111111111111' }) });
    openProp = (element as unknown as { props: { open: { inFlight: boolean } } }).props.open;
    expect(openProp.inFlight).toBe(false);
  });

  describe('the two "always allow" switches (spec 2026-10-01 §8)', () => {
    /** An admin's metering row (no access grant, no allowance) with the two toggles. */
    const accountRow = (toggles: { autoApproveChanges: boolean; autoApproveDeletes: boolean }): AskAccount => ({
      userId: 'u1', access: false, monthlyAllowanceMicro: 0, allowanceUsedMicro: 0, periodStart: '2026-10-01', creditMicro: 0, conversationCount: 1, ...toggles,
    });
    const writesOf = (element: unknown) => (element as { props: { writes: unknown } }).props.writes;

    it('with ASK_AI_WRITES_ENABLED=1 and an account row, passes the row\'s two toggles to AskAi as writes', async () => {
      envMock.env.ASK_AI_WRITES_ENABLED = '1';
      ledger.getAccount.mockResolvedValueOnce(accountRow({ autoApproveChanges: true, autoApproveDeletes: false }));
      expect(writesOf(await AskPage({ searchParams: Promise.resolve({}) }))).toEqual({ autoApproveChanges: true, autoApproveDeletes: false });
    });

    it('passes null without the flag, and with the flag but no account row yet (an admin before their first turn)', async () => {
      ledger.getAccount.mockResolvedValueOnce(accountRow({ autoApproveChanges: true, autoApproveDeletes: true }));
      expect(writesOf(await AskPage({ searchParams: Promise.resolve({}) }))).toBeNull();
      envMock.env.ASK_AI_WRITES_ENABLED = '1';
      expect(writesOf(await AskPage({ searchParams: Promise.resolve({}) }))).toBeNull();
    });
  });

  it('a reload keeps a reduced output on the workspace writes — the { id, name } a card names, or the { error } — and strips every other output (arc 4)', async () => {
    const VIEW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const VIEW_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    const CAT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const writeError = { code: 'DUPLICATE_NAME', message: 'A custom category with that name already exists.', retryable: false };
    // An approved delete's record; anything beside `deleted` (nothing today) is dropped too.
    const deleteRecord = {
      type: 'tool-delete_saved_view', toolCallId: 't1', state: 'output-available', input: { id: VIEW }, approval: { id: 'a1', approved: true },
      output: { deleted: { id: VIEW, name: 'Lamps' }, notes: ['Deleted.'] },
    };
    const pendingCard = { type: 'tool-delete_saved_view', toolCallId: 't8', state: 'approval-requested', input: { id: VIEW_2 }, approval: { id: 'a8' } };
    conv.loadConversation.mockResolvedValueOnce({
      conversation: { id: 'c1', userId: 'u1', title: 'Chat', model: 'claude-sonnet-5', messageCount: 2, inFlightSince: null, createdAt: new Date(), updatedAt: new Date() },
      messages: [{
        id: 'm1', role: 'assistant', metadata: { status: 'complete' },
        parts: [
          deleteRecord,
          {
            type: 'tool-create_saved_view', toolCallId: 't2', state: 'output-available', input: { name: 'Desks', search: {} },
            output: {
              view: { id: VIEW_2, name: 'Desks', explorerUrl: 'https://keywordquarry.com/explorer?view=1', filters: { minVolume: 1000 }, leafCount: 0, previewComplete: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
              notes: ['Saved.'],
            },
          },
          { type: 'tool-delete_custom_category', toolCallId: 't3', state: 'output-available', input: { id: CAT }, approval: { id: 'a3', approved: true }, output: { deleted: { id: CAT, name: 'Lighting', leafCount: 12 } } },
          { type: 'tool-update_custom_category', toolCallId: 't4', state: 'output-available', input: { id: CAT, name: 'Lighting' }, output: { error: writeError } },
          { type: 'tool-add_to_watchlist', toolCallId: 't5', state: 'output-available', input: { keywords: ['desk lamp'] }, output: { added: 1, alreadyWatching: 0, unmatched: [], skippedAtCap: 0, watching: 1, limit: 500 } },
          { type: 'tool-list_saved_views', toolCallId: 't6', state: 'output-available', input: {}, output: { views: [{ id: VIEW, name: 'Lamps' }], count: 1, limit: 5 } },
          { type: 'tool-search_keywords', toolCallId: 't7', state: 'output-available', input: {}, output: { rows: ['a row'] } },
          pendingCard,
        ],
      }],
    });
    const element = await AskPage({ searchParams: Promise.resolve({ c: '11111111-1111-4111-8111-111111111111' }) });
    const parts = (element as unknown as { props: { open: { messages: Array<{ parts: Array<Record<string, unknown>> }> } } }).props.open.messages[0].parts;
    // Only the output changes: the type, id, state, input and approval record are as stored.
    expect(parts[0]).toEqual({ ...deleteRecord, output: { deleted: { id: VIEW, name: 'Lamps' } } });
    expect(parts.slice(1, 7).map((p) => p.output)).toEqual([
      { view: { id: VIEW_2, name: 'Desks' } },
      { deleted: { id: CAT, name: 'Lighting' } },
      { error: writeError },
      undefined, // a watchlist result names nothing
      undefined, // a list is not a write: stripped as before
      undefined, // research rows: stripped as before
    ]);
    expect(parts[6].toolCallId).toBe('t7');
    expect(parts[7]).toEqual(pendingCard);
  });
});

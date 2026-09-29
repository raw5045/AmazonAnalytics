import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
const auth = vi.hoisted(() => ({ user: { id: 'u1', role: 'admin' as 'admin' | 'standard_user', email: 'a@example.com' } }));
vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({ requireAuthenticatedUser: async () => auth.user }));
const ledger = vi.hoisted(() => ({ getAccount: vi.fn(async () => null), resetPeriodIfDue: vi.fn(async () => null), countMemberAccountsWithAccess: vi.fn(async () => 0) }));
vi.mock('@/lib/ask/ledger', () => ledger);
const conv = vi.hoisted(() => ({ listConversations: vi.fn(async () => []), loadConversation: vi.fn(async () => null) }));
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
});

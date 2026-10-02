import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
vi.mock('@/db/client', () => ({ db: { execute: vi.fn() } }));
// redirect for the page's own gate (S1); useRouter for the child GrantForm/AccountActions client
// components, always rendered on the page regardless of row count.
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); }, useRouter: () => ({ refresh: vi.fn() }) }));
const auth = vi.hoisted(() => ({ state: 'admin' as 'admin' | 'unauthenticated' | 'forbidden' }));
vi.mock('@/lib/auth/requireAdmin', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/auth/requireAdmin')>();
  return {
    ...mod,
    requireAdmin: async () => {
      if (auth.state === 'unauthenticated') throw new mod.AuthError('UNAUTHENTICATED', 'Not signed in');
      if (auth.state === 'forbidden') throw new mod.AuthError('FORBIDDEN', 'Admin only');
      return { id: 'a1', role: 'admin' };
    },
  };
});
const usageDefault = { month: '2026-09-01', costMicro: 0, questions: 0, alerted80At: null as Date | null, alerted100At: null as Date | null };
const ledger = vi.hoisted(() => ({ globalUsageForMonth: vi.fn(), monthStartUtc: () => '2026-09-01', sumRemainingAllowances: vi.fn() }));
vi.mock('@/lib/ask/ledger', () => ledger);
const view = vi.hoisted(() => ({ listAccountsForAdmin: vi.fn(), modelMixForMonth: vi.fn(), sumCreditWithAccess: vi.fn() }));
vi.mock('@/lib/ask/adminView', () => view);
import AskAiAdminPage from './page';

describe('AskAiAdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.state = 'admin';
    ledger.globalUsageForMonth.mockResolvedValue({ ...usageDefault });
    ledger.sumRemainingAllowances.mockResolvedValue(0);
    view.listAccountsForAdmin.mockResolvedValue([]);
    view.modelMixForMonth.mockResolvedValue([]);
    view.sumCreditWithAccess.mockResolvedValue(0);
  });

  it('redirects a non-admin before any data read — the page checks requireAdmin() itself, not only the layout (S1)', async () => {
    auth.state = 'unauthenticated';
    await expect(AskAiAdminPage()).rejects.toThrow('redirect:/sign-in');
    expect(view.listAccountsForAdmin).not.toHaveBeenCalled();
    auth.state = 'forbidden';
    await expect(AskAiAdminPage()).rejects.toThrow('redirect:/explorer');
    expect(view.listAccountsForAdmin).not.toHaveBeenCalled();
  });

  it('renders spend vs ceiling, the model mix, and alert timestamps (S2, C-m3)', async () => {
    ledger.globalUsageForMonth.mockResolvedValue({ ...usageDefault, costMicro: 160_500_000, questions: 4012, alerted80At: new Date('2026-09-20T10:00:00Z'), alerted100At: null });
    view.modelMixForMonth.mockResolvedValue([{ model: 'claude-sonnet-5', turns: 120, costMicro: 4_800_000 }, { model: 'claude-opus-5-5', turns: 1, costMicro: 40_000 }]);
    render(await AskAiAdminPage());
    expect(screen.getByRole('heading', { name: 'Ask AI' })).toBeInTheDocument();
    // The model mix counts turns (ledger 'usage' rows: questions plus approval resumes, arc 4); the
    // month line keeps "questions" from the global counter, which a resume does not bump.
    expect(screen.getByText(/Standard \(Sonnet 5\) 120 turns \(\$4\.80\) · Advanced \(Opus 5\.5\) 1 turn \(\$0\.04\)/)).toBeInTheDocument();
    expect(screen.getByText(/4,012 questions\./)).toBeInTheDocument();
    expect(screen.getByText(/80% reached 2026-09-20 10:00 UTC/)).toBeInTheDocument();
  });

  it('shows "none yet" for the model mix and "none" for alerts when there is no usage', async () => {
    render(await AskAiAdminPage());
    expect(screen.getByText(/Model mix: none yet/)).toBeInTheDocument();
    expect(screen.getByText('Alerts this month: none')).toBeInTheDocument();
  });

  it('flags the ceiling as too low when remaining allowances alone exceed it, and also when only credit does (C-m7)', async () => {
    ledger.sumRemainingAllowances.mockResolvedValue(250_000_000);
    view.sumCreditWithAccess.mockResolvedValue(0);
    const { unmount } = render(await AskAiAdminPage());
    expect(screen.getByText(/ceiling is lower than what members could still use/)).toBeInTheDocument();
    unmount();
    ledger.sumRemainingAllowances.mockResolvedValue(0);
    view.sumCreditWithAccess.mockResolvedValue(250_000_000);
    render(await AskAiAdminPage());
    expect(screen.getByText(/ceiling is lower than what members could still use/)).toBeInTheDocument();
  });

  it('does not flag the ceiling as too low when remaining allowances and credit together are still under it', async () => {
    ledger.sumRemainingAllowances.mockResolvedValue(80_000_000);
    view.sumCreditWithAccess.mockResolvedValue(80_000_000);
    render(await AskAiAdminPage());
    expect(screen.queryByText(/ceiling is lower than what members could still use/)).toBeNull();
  });

  it('shows a Spend (month) column per member, and the member\'s turns this month under "Turns"', async () => {
    view.listAccountsForAdmin.mockResolvedValue([{ userId: 'u1', email: 'm@example.com', role: 'standard_user', access: true, monthlyAllowanceMicro: 10_000_000, allowanceUsedMicro: 400_000, periodStart: '2026-09-01', creditMicro: 0, turnsMonth: 12, spendMonthMicro: 480_000, lastAt: new Date('2026-09-28T10:00:00Z') }]);
    render(await AskAiAdminPage());
    expect(screen.getByText('$0.48')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Turns' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Questions' })).toBeNull();
    expect(screen.getByText('12')).toBeInTheDocument();
  });
});

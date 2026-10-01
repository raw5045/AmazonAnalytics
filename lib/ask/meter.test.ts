import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/env', () => ({ env: {} }));
// meter.ts pulls in ./ledger for AskAccount/balanceMicro, which imports the real db client;
// db/client.ts constructs a neon() client eagerly at module load using env.DATABASE_URL, which
// throws given the empty env mock above — stub it out the same way lib/ask/gates.test.ts does.
// meterFor never touches `db` itself, so an empty stub is enough.
vi.mock('@/db/client', () => ({ db: {} }));
import { meterFor } from './meter';
const acct = { userId: 'u1', access: true, monthlyAllowanceMicro: 10_000_000, allowanceUsedMicro: 2_500_000, periodStart: '2026-09-01', creditMicro: 0, conversationCount: 1, autoApproveChanges: false, autoApproveDeletes: false };
describe('meterFor', () => {
  it('percent used, questions left for the model, credit flag, exhausted flag', () => {
    expect(meterFor(acct, 'claude-sonnet-5', false)).toEqual({ percentUsed: 25, questionsLeft: 187, hasCredit: false, exhausted: false, admin: false });
    expect(meterFor({ ...acct, creditMicro: 4_000_000 }, 'claude-opus-5-5', false)).toEqual({ percentUsed: 25, questionsLeft: 143, hasCredit: true, exhausted: false, admin: false });
    expect(meterFor({ ...acct, allowanceUsedMicro: 10_000_000 }, 'claude-sonnet-5', false)).toMatchObject({ percentUsed: 100, questionsLeft: 0, exhausted: true });
    expect(meterFor({ ...acct, allowanceUsedMicro: 12_000_000 }, 'claude-sonnet-5', false).percentUsed).toBe(100);
  });
  it('admins are metered, never limited; a missing account reads as zero', () => {
    expect(meterFor({ ...acct, monthlyAllowanceMicro: 0 }, 'claude-sonnet-5', true)).toMatchObject({ admin: true, exhausted: false, percentUsed: 0 });
    expect(meterFor(null, 'claude-sonnet-5', false)).toEqual({ percentUsed: 0, questionsLeft: 0, hasCredit: false, exhausted: true, admin: false });
  });
});

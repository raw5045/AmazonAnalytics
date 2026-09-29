import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AskAiCeilingEmailInput } from '@/lib/notifications/buildAskAiCeilingEmail';
const envMock = vi.hoisted(() => ({ env: { INITIAL_ADMIN_EMAIL: 'owner@example.com' } as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
vi.mock('./config', async (importOriginal) => ({ ...(await importOriginal<typeof import('./config')>()), globalMonthlyCeilingMicro: () => 100_000_000 }));
const ledger = vi.hoisted(() => ({ markCeilingAlert: vi.fn(), monthStartUtc: () => '2026-09-01' }));
vi.mock('./ledger', () => ledger);
// Typed via vi.fn's generic (matching lib/ask/turn.test.ts's own convention), rather than leaving
// the plan's zero-arg `async () => ({ sent: true })` to infer its own type: a parameterless vi.fn()
// infers `mock.calls[n]` as the empty tuple `[]`, and this file's own `.mock.calls[0][0]` assertion
// below (copied from the plan) then fails `pnpm typecheck` with "Tuple type '[]' of length '0' has
// no element at index '0'".
const send = vi.hoisted(() => ({ sendAskAiCeilingEmail: vi.fn<(input: AskAiCeilingEmailInput & { to: string }) => Promise<{ sent: boolean }>>(async () => ({ sent: true })) }));
vi.mock('@/lib/notifications/sendAskAiCeilingEmail', () => send);
import { maybeAlertCeiling } from './alerts';
const now = new Date('2026-09-28T12:00:00Z');
describe('maybeAlertCeiling', () => {
  beforeEach(() => { vi.clearAllMocks(); ledger.markCeilingAlert.mockResolvedValue(true); envMock.env = { INITIAL_ADMIN_EMAIL: 'owner@example.com' }; });
  it('does nothing under 80%', async () => {
    await maybeAlertCeiling(79_999_999, now);
    expect(ledger.markCeilingAlert).not.toHaveBeenCalled();
  });
  it('sends the 80% email once', async () => {
    await maybeAlertCeiling(80_000_000, now);
    expect(ledger.markCeilingAlert).toHaveBeenCalledWith('2026-09-01', 80, now);
    expect(send.sendAskAiCeilingEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com', level: 80, costMicro: 80_000_000, ceilingMicro: 100_000_000, month: '2026-09-01' }));
    ledger.markCeilingAlert.mockResolvedValueOnce(false);
    await maybeAlertCeiling(81_000_000, now);
    expect(send.sendAskAiCeilingEmail).toHaveBeenCalledTimes(1);
  });
  it('at 100% marks both levels and sends the 100% email only', async () => {
    await maybeAlertCeiling(100_000_000, now);
    expect(ledger.markCeilingAlert).toHaveBeenCalledWith('2026-09-01', 100, now);
    expect(ledger.markCeilingAlert).toHaveBeenCalledWith('2026-09-01', 80, now);
    expect(send.sendAskAiCeilingEmail).toHaveBeenCalledTimes(1);
    expect(send.sendAskAiCeilingEmail.mock.calls[0][0]).toMatchObject({ level: 100 });
  });
  it('only logs when the admin email is unset', async () => {
    envMock.env.INITIAL_ADMIN_EMAIL = undefined;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await maybeAlertCeiling(90_000_000, now);
    expect(send.sendAskAiCeilingEmail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
  // Task 10 implementer delta A: maybeAlertCeiling must AWAIT the send (not fire-and-forget), because
  // the chat route's onEnd awaits it inside the turn's after() lifetime — a still-pending send would
  // be cut off when Vercel reclaims the function once that lifetime promise resolves.
  it('awaits the send — does not resolve before sendAskAiCeilingEmail settles', async () => {
    let resolveSend!: (v: { sent: boolean }) => void;
    send.sendAskAiCeilingEmail.mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
    const PENDING = Symbol('pending');
    const p = maybeAlertCeiling(80_000_000, now);
    const raced = await Promise.race([
      p.then(() => 'resolved' as const),
      new Promise((resolve) => setTimeout(() => resolve(PENDING), 20)),
    ]);
    expect(raced).toBe(PENDING);
    resolveSend({ sent: true });
    await expect(p).resolves.toBeUndefined();
  });
  it('a rejected send does not throw out of maybeAlertCeiling', async () => {
    send.sendAskAiCeilingEmail.mockRejectedValueOnce(new Error('resend down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(maybeAlertCeiling(80_000_000, now)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

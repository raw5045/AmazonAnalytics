import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  afterEach(() => { vi.useRealTimers(); });

  it('does nothing under 80%', async () => {
    await maybeAlertCeiling(79_999_999, now, 100);
    expect(ledger.markCeilingAlert).not.toHaveBeenCalled();
  });
  it('sends the 80% email once, passing questions through to the send (C-m8)', async () => {
    await maybeAlertCeiling(80_000_000, now, 4012);
    expect(ledger.markCeilingAlert).toHaveBeenCalledWith('2026-09-01', 80, now);
    expect(send.sendAskAiCeilingEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com', level: 80, costMicro: 80_000_000, ceilingMicro: 100_000_000, month: '2026-09-01', questions: 4012 }));
    ledger.markCeilingAlert.mockResolvedValueOnce(false);
    await maybeAlertCeiling(81_000_000, now, 4013);
    expect(send.sendAskAiCeilingEmail).toHaveBeenCalledTimes(1);
  });
  it('at 100% marks both levels and sends the 100% email only', async () => {
    await maybeAlertCeiling(100_000_000, now, 5000);
    expect(ledger.markCeilingAlert).toHaveBeenCalledWith('2026-09-01', 100, now);
    expect(ledger.markCeilingAlert).toHaveBeenCalledWith('2026-09-01', 80, now);
    expect(send.sendAskAiCeilingEmail).toHaveBeenCalledTimes(1);
    expect(send.sendAskAiCeilingEmail.mock.calls[0][0]).toMatchObject({ level: 100, questions: 5000 });
  });
  it('only logs when the admin email is unset', async () => {
    envMock.env.INITIAL_ADMIN_EMAIL = undefined;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await maybeAlertCeiling(90_000_000, now, 10);
    expect(send.sendAskAiCeilingEmail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
  // Task 10 implementer delta A (Task 10 first round): maybeAlertCeiling must AWAIT the send (not
  // fire-and-forget) — the chat route now starts maybeAlertCeiling itself un-awaited (Task 10
  // review, C4), so this function's own internal await is what bounds the work.
  it('awaits the send — does not resolve before sendAskAiCeilingEmail settles', async () => {
    let resolveSend!: (v: { sent: boolean }) => void;
    send.sendAskAiCeilingEmail.mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
    const PENDING = Symbol('pending');
    const p = maybeAlertCeiling(80_000_000, now, 10);
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
    await expect(maybeAlertCeiling(80_000_000, now, 10)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  // Task 10 review, S6: maybeAlertCeiling "really never throws" (a guarded markCeilingAlert) and
  // the send is bounded to 10s.
  it('a markCeilingAlert failure resolves without throwing, logs alert_mark_failed, and never sends', async () => {
    ledger.markCeilingAlert.mockRejectedValueOnce(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(maybeAlertCeiling(80_000_000, now, 10)).resolves.toBeUndefined();
    expect(send.sendAskAiCeilingEmail).not.toHaveBeenCalled();
    const found = error.mock.calls.map((c) => { try { return JSON.parse(String(c[1])) as { outcome?: string }; } catch { return undefined; } });
    expect(found.some((o) => o?.outcome === 'alert_mark_failed')).toBe(true);
    error.mockRestore();
  });
  it('a send that never resolves times out after 10s, resolves maybeAlertCeiling anyway, and logs alert_send_timeout', async () => {
    vi.useFakeTimers();
    send.sendAskAiCeilingEmail.mockImplementationOnce(() => new Promise(() => {}));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = maybeAlertCeiling(80_000_000, now, 10);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBeUndefined();
    const found = error.mock.calls.map((c) => { try { return JSON.parse(String(c[1])) as { outcome?: string }; } catch { return undefined; } });
    expect(found.some((o) => o?.outcome === 'alert_send_timeout')).toBe(true);
    error.mockRestore();
  });
  // Task 10 nits, spec note 7 / N2: the 10s timer must not be left pending once the send settles —
  // a leaked timer would otherwise hold a handle open for up to 10s longer than necessary.
  it('clears the 10s send timer once the send settles, not leaving a pending timer', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    await maybeAlertCeiling(80_000_000, now, 10);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
  // Task 10 nits, N4: the 100%→80% secondary mark used to fail silently despite the docblock's own
  // claim that every step is logged — it must now log alert_mark_failed (level: 80) without failing
  // the primary mark or blocking the send.
  it('a secondary 80% mark failure (while marking 100%) is logged, not silent, and the send still proceeds', async () => {
    ledger.markCeilingAlert.mockImplementation(async (_month: string, level: number) => {
      if (level === 100) return true;
      throw new Error('80 mark db down');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(maybeAlertCeiling(100_000_000, now, 10)).resolves.toBeUndefined();
    const found = error.mock.calls.map((c) => { try { return JSON.parse(String(c[1])) as { outcome?: string; level?: number }; } catch { return undefined; } });
    expect(found.some((o) => o?.outcome === 'alert_mark_failed' && o?.level === 80)).toBe(true);
    expect(send.sendAskAiCeilingEmail).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

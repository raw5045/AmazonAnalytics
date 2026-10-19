// lib/perf/handlerTimer.test.ts
import { describe, it, expect, expectTypeOf, vi, afterEach } from 'vitest';
import { startHandlerTimer, timed } from './handlerTimer';

afterEach(() => vi.restoreAllMocks());

describe('startHandlerTimer', () => {
  it('records each mark as the time since the previous one, with its note, and the total since the start', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000); // start
    const timer = startHandlerTimer();
    now.mockReturnValueOnce(1_060); // mark auth
    timer.mark('auth');
    now.mockReturnValueOnce(1_390); // mark loads
    timer.mark('loads', 'parallel');
    now.mockReturnValueOnce(1_400); // totalMs
    expect(timer.steps).toEqual([
      { label: 'auth', ms: 60, note: undefined },
      { label: 'loads', ms: 330, note: 'parallel' },
    ]);
    expect(timer.totalMs()).toBe(400);
  });
});

describe('timed', () => {
  it("resolves to the promise's value and the ms it took to settle", async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(5_000).mockReturnValueOnce(5_250);
    await expect(timed(Promise.resolve(['a', 'b']))).resolves.toEqual({ value: ['a', 'b'], ms: 250 });
  });

  it('passes a rejection through unchanged (the caller decides what a failed read means)', async () => {
    const failure = new Error('cold');
    await expect(timed(Promise.reject(failure))).rejects.toBe(failure);
  });

  it('types the result as { value, ms } (type-only pin; pnpm typecheck compiles this file)', () => {
    expectTypeOf(timed(Promise.resolve(['a']))).resolves.toEqualTypeOf<{ value: string[]; ms: number }>();
  });
});

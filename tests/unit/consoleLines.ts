import { format } from 'node:util';
import { vi } from 'vitest';

/**
 * Log-safety test helpers for the fail-soft email senders.
 *
 * `consoleLines` renders every call a spied console method received the way Node's console
 * itself renders its arguments (util.format). That fidelity is the point: JSON.stringify(new
 * Error(x)) is `{}`, so a stringify-based check would miss a leaked message inside a raw Error
 * argument, while the real console prints that Error's stack — message included.
 */
export function consoleLines(...spies: { mock: { calls: readonly unknown[][] } }[]): string[] {
  return spies.flatMap((spy) =>
    spy.mock.calls.map((args) => {
      const [first, ...rest] = args;
      return format(first, ...rest);
    }),
  );
}

/** Spy on and silence console.error/warn/log; pass the result to consoleLines. Restored by vi.restoreAllMocks(). */
export function spyOnConsole() {
  const silence = () => {};
  return [
    vi.spyOn(console, 'error').mockImplementation(silence),
    vi.spyOn(console, 'warn').mockImplementation(silence),
    vi.spyOn(console, 'log').mockImplementation(silence),
  ];
}

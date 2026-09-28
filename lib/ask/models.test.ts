import { describe, it, expect } from 'vitest';
import { ASK_MODELS, DEFAULT_MODEL, ASK_LIMITS, usdToMicro } from './models';

// Deliberately does NOT mock '@/lib/env': lib/ask/models.ts must be importable without it (it is
// bundled into client components), so importing this file unmocked has to succeed on its own. If
// models.ts ever pulls in @/lib/env (directly or transitively), env.ts's parseEnv() runs at
// module load in this jsdom test environment (no NEXT_PUBLIC_* vars set here) and throws, which
// fails this file at import time before any test body runs.
describe('ask models (env-free)', () => {
  it('exposes the model catalogue and fixed limits with no @/lib/env dependency', () => {
    expect(ASK_MODELS.length).toBe(3);
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5');
    expect(Object.isFrozen(ASK_LIMITS)).toBe(true);
    expect(usdToMicro(10)).toBe(10_000_000);
  });
});

import { describe, it, expect, vi } from 'vitest';

// Actively guards models.ts's env-free contract: lib/ask/models.ts must be importable without
// '@/lib/env' (it is bundled into client components). The factory only runs if something
// actually imports '@/lib/env', so if models.ts ever pulls it in (directly or transitively), the
// factory throws and fails this file at import time before any test body runs — regardless of
// the shell environment (previously this relied on env.ts's parseEnv() throwing only because no
// NEXT_PUBLIC_* vars happen to be set in this jsdom test environment).
vi.mock('@/lib/env', () => {
  throw new Error('lib/ask/models.ts must stay env-free');
});

import { ASK_MODELS, DEFAULT_MODEL, ASK_LIMITS, usdToMicro } from './models';

describe('ask models (env-free)', () => {
  it('exposes the model catalogue and fixed limits with no @/lib/env dependency', () => {
    expect(ASK_MODELS.length).toBe(3);
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5');
    expect(Object.isFrozen(ASK_LIMITS)).toBe(true);
    expect(usdToMicro(10)).toBe(10_000_000);
  });
});

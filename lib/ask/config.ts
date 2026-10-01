import { env } from '@/lib/env';
import { usdToMicro } from './models';

export * from './models';

/**
 * Ask AI configuration (spec §6, §10): env-driven dials, read lazily and memoised per process. A
 * bad value never throws — it warns once and falls back — because the browser product must keep
 * serving even if a dial is mistyped in Vercel. Env-free constants (models, fixed limits) live in
 * ./models and are re-exported above, so existing `@/lib/ask/config` imports keep working; client
 * components should import `@/lib/ask/models` directly to avoid pulling in @/lib/env.
 */

export function askAiEnabled(): boolean {
  return env.ASK_AI_ENABLED === '1';
}

/** Spec 2026-10-01 §2: the eleven workspace tools inside the chat. Reaches a deployment on its next deploy only. */
export function askAiWritesEnabled(): boolean {
  return env.ASK_AI_WRITES_ENABLED === '1';
}

export function anthropicApiKey(): string | null {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? key : null;
}

const DEFAULTS = { dailyMessageLimit: 100, globalMonthlyCeilingUsd: 200, defaultAllowanceUsd: 10 } as const;

let memo: { daily: number; ceilingMicro: number; allowanceMicro: number } | null = null;

function positiveSafeInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  const ok = Number.isFinite(n) && Number.isSafeInteger(n) && n > 0;
  if (!ok) {
    console.warn(`[ask config] ${name}=${JSON.stringify(raw)} is not a positive integer — using ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * Parses a dollar-denominated dial and validates AFTER converting to micro-dollars, so a value
 * that overflows or rounds away under conversion is refused even though it looked fine in
 * dollars (e.g. "1e308" overflows to Infinity; "0.0000001" rounds to 0 despite being positive).
 * Zero itself is accepted: a 0 ceiling pauses Ask AI for everyone, a 0 allowance grants access
 * with no included usage.
 */
function nonNegativeMicroDial(name: string, raw: string | undefined, fallbackUsd: number): number {
  const fallbackMicro = usdToMicro(fallbackUsd);
  if (raw === undefined || raw.trim() === '') return fallbackMicro;
  const n = Number(raw);
  const micro = usdToMicro(n);
  const ok = Number.isFinite(n) && Number.isSafeInteger(micro) && micro >= 0 && (n === 0 || micro > 0);
  if (!ok) {
    console.warn(`[ask config] ${name}=${JSON.stringify(raw)} is not a valid non-negative dollar amount — using ${fallbackUsd}`);
    return fallbackMicro;
  }
  return micro;
}

function settings() {
  if (!memo) {
    memo = {
      daily: positiveSafeInteger('ASK_AI_DAILY_MESSAGE_LIMIT', env.ASK_AI_DAILY_MESSAGE_LIMIT, DEFAULTS.dailyMessageLimit),
      ceilingMicro: nonNegativeMicroDial('ASK_AI_GLOBAL_MONTHLY_CEILING_USD', env.ASK_AI_GLOBAL_MONTHLY_CEILING_USD, DEFAULTS.globalMonthlyCeilingUsd),
      allowanceMicro: nonNegativeMicroDial('ASK_AI_DEFAULT_ALLOWANCE_USD', env.ASK_AI_DEFAULT_ALLOWANCE_USD, DEFAULTS.defaultAllowanceUsd),
    };
  }
  return memo;
}

/** Questions per member per UTC day (spec §9.5 gate 3). */
export function dailyMessageLimit(): number {
  return settings().daily;
}
/** Total model cost across all accounts per month, micro-dollars (spec §9.5 gate 5). */
export function globalMonthlyCeilingMicro(): number {
  return settings().ceilingMicro;
}
/** Allowance a new grant starts with, micro-dollars (spec §9.7). */
export function defaultAllowanceMicro(): number {
  return settings().allowanceMicro;
}
/** Test-only: clears the memo so the next read re-parses env. */
export function resetAskConfigForTests(): void {
  memo = null;
}

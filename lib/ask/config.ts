import { env } from '@/lib/env';

/**
 * Ask AI configuration (spec §6, §10). Everything env-driven is read lazily and memoised per
 * process; a bad value never throws — it warns once and falls back — because the browser product
 * must keep serving even if a dial is mistyped in Vercel.
 */
export const ASK_MODELS = [
  { id: 'claude-sonnet-5', label: 'Standard (Sonnet 5)', note: null },
  { id: 'claude-opus-5-5', label: 'Advanced (Opus 5.5)', note: 'uses about twice the usage' },
  { id: 'claude-haiku-4-5', label: 'Quick (Haiku 4.5)', note: 'uses about half' },
] as const;
export type AskModelId = (typeof ASK_MODELS)[number]['id'];
export const DEFAULT_MODEL: AskModelId = 'claude-sonnet-5';

export function isAskModelId(v: unknown): v is AskModelId {
  return typeof v === 'string' && ASK_MODELS.some((m) => m.id === v);
}

/** Fixed in code (spec §10). */
export const ASK_LIMITS = Object.freeze({
  maxChats: 5,
  maxMessagesPerChat: 200,
  maxMessageChars: 4000,
  historyWindowMessages: 20,
  historyWindowTokens: 60_000,
  maxToolCallsPerTurn: 8,
  /** eight tool-call steps + one answer step + one spare; the prompt says "at most eight tool calls" */
  maxSteps: 10,
  maxOutputTokens: 4096,
  turnDeadlineMs: 240_000,
  inFlightExpiryMinutes: 5,
});

export const MICRO = 1_000_000;
export function usdToMicro(usd: number): number {
  return Math.round(usd * MICRO);
}

export function askAiEnabled(): boolean {
  return env.ASK_AI_ENABLED === '1';
}

export function anthropicApiKey(): string | null {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? key : null;
}

const DEFAULTS = { dailyMessageLimit: 100, globalMonthlyCeilingUsd: 200, defaultAllowanceUsd: 10 } as const;

let memo: { daily: number; ceilingMicro: number; allowanceMicro: number } | null = null;

function positiveNumber(name: string, raw: string | undefined, fallback: number, integer: boolean): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  const ok = Number.isFinite(n) && n > 0 && (!integer || Number.isSafeInteger(n));
  if (!ok) {
    console.warn(`[ask config] ${name}=${JSON.stringify(raw)} is not a positive ${integer ? 'integer' : 'number'} — using ${fallback}`);
    return fallback;
  }
  return n;
}

function settings() {
  if (!memo) {
    memo = {
      daily: positiveNumber('ASK_AI_DAILY_MESSAGE_LIMIT', env.ASK_AI_DAILY_MESSAGE_LIMIT, DEFAULTS.dailyMessageLimit, true),
      ceilingMicro: usdToMicro(positiveNumber('ASK_AI_GLOBAL_MONTHLY_CEILING_USD', env.ASK_AI_GLOBAL_MONTHLY_CEILING_USD, DEFAULTS.globalMonthlyCeilingUsd, false)),
      allowanceMicro: usdToMicro(positiveNumber('ASK_AI_DEFAULT_ALLOWANCE_USD', env.ASK_AI_DEFAULT_ALLOWANCE_USD, DEFAULTS.defaultAllowanceUsd, false)),
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

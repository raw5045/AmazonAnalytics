import type { LanguageModelUsage } from 'ai';
import { env } from '@/lib/env';
import { ASK_MODELS, isAskModelId, type AskModelId } from './config';

/** Micro-dollars per token — numerically equal to Anthropic's "$ per million tokens" (spec §9.1). */
export interface ModelRates {
  input: number;
  /**
   * The 5-minute-TTL cache-write rate. Anthropic bills a 1-hour TTL write at 2× the input rate
   * instead, but the SDK's `usage.inputTokenDetails.cacheWriteTokens` does not split by TTL, so a
   * 1-hour write is currently costed at this (5-minute) rate — undercounted if 1-hour caching is
   * ever turned on here. Revisit if that changes.
   */
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** Feeds only the meter's "about N questions left" text (spec §9.2); replaced by a rolling average in a follow-up. */
  estimatePerQuestionMicro: number;
}

export const PRICES_AS_OF = '2026-09-28';

export const DEFAULT_RATES: Readonly<Record<AskModelId, Readonly<ModelRates>>> = Object.freeze({
  'claude-sonnet-5': Object.freeze({ input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10, estimatePerQuestionMicro: 40_000 }),
  'claude-opus-5-5': Object.freeze({ input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20, estimatePerQuestionMicro: 80_000 }),
  'claude-haiku-4-5': Object.freeze({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5, estimatePerQuestionMicro: 15_000 }),
});

export interface TurnUsage {
  noCacheTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}
export const ZERO_USAGE: Readonly<TurnUsage> = Object.freeze({ noCacheTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 });

export function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    noCacheTokens: a.noCacheTokens + b.noCacheTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** The SDK reports `inputTokenDetails.{noCacheTokens, cacheReadTokens, cacheWriteTokens}`; a missing noCache count is derived from the total so nothing is ever left uncounted. */
export function usageFromSdk(u: LanguageModelUsage): TurnUsage {
  const cacheRead = u.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = u.inputTokenDetails?.cacheWriteTokens ?? 0;
  const noCache = u.inputTokenDetails?.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite);
  return { noCacheTokens: noCache, cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead, outputTokens: u.outputTokens ?? 0 };
}

export function costMicro(model: AskModelId, usage: TurnUsage, rates: Readonly<Record<AskModelId, Readonly<ModelRates>>> = effectiveRates()): number {
  const r = rates[model];
  return Math.round(usage.noCacheTokens * r.input + usage.cacheWriteTokens * r.cacheWrite + usage.cacheReadTokens * r.cacheRead + usage.outputTokens * r.output);
}

/** The four per-token rates, in micro-dollars per token — bounded to [MIN_RATE_MICRO, MAX_RATE_MICRO]. */
const PRICE_KEYS = ['input', 'cacheWrite', 'cacheRead', 'output'] as const;
const RATE_KEYS = [...PRICE_KEYS, 'estimatePerQuestionMicro'] as const;
/** A sane bound on a per-token rate override: catches an obvious typo (a dollar figure instead of
 * micro-dollars, a stray extra zero) without hard-coding today's actual prices as a ceiling. */
const MIN_RATE_MICRO = 0.01;
const MAX_RATE_MICRO = 1000;

/** ASK_AI_PRICES_JSON: `{ "<model id>": { input?, cacheWrite?, cacheRead?, output?, estimatePerQuestionMicro? } }`; every rejection warns and keeps the default. Never throws. */
export function parseRateOverrides(raw: string | undefined): Record<AskModelId, ModelRates> {
  const out = Object.fromEntries(ASK_MODELS.map((m) => [m.id, { ...DEFAULT_RATES[m.id] }])) as Record<AskModelId, ModelRates>;
  if (!raw?.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[ask pricing] ASK_AI_PRICES_JSON is not valid JSON — using defaults');
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[ask pricing] ASK_AI_PRICES_JSON must be an object — using defaults');
    return out;
  }
  for (const [model, rates] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isAskModelId(model)) {
      console.warn(`[ask pricing] unknown model ${JSON.stringify(model)} ignored`);
      continue;
    }
    if (rates === null || typeof rates !== 'object' || Array.isArray(rates)) {
      console.warn(`[ask pricing] rates for ${model} must be an object — default kept`);
      continue;
    }
    for (const [key, value] of Object.entries(rates as Record<string, unknown>)) {
      if (!(RATE_KEYS as readonly string[]).includes(key)) {
        console.warn(`[ask pricing] ${model}.${key} is not a rate — ignored`);
        continue;
      }
      if ((PRICE_KEYS as readonly string[]).includes(key)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_RATE_MICRO || value > MAX_RATE_MICRO) {
          console.warn(`[ask pricing] ${model}.${key}=${JSON.stringify(value)} must be a number between ${MIN_RATE_MICRO} and ${MAX_RATE_MICRO} (micro-dollars per token) — default kept`);
          continue;
        }
      } else if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        console.warn(`[ask pricing] ${model}.${key}=${JSON.stringify(value)} must be a positive integer — default kept`);
        continue;
      }
      out[model][key as (typeof RATE_KEYS)[number]] = value;
    }
  }
  return out;
}

let cached: Readonly<Record<AskModelId, Readonly<ModelRates>>> | null = null;
/**
 * Reads ASK_AI_PRICES_JSON once per process and memoises the result — an env change needs a
 * redeploy to take effect; it is never re-read mid-process. Returns a deep-frozen snapshot (each
 * model's rates frozen, then the outer map), so nothing downstream can mutate the shared cache.
 */
export function effectiveRates(): Readonly<Record<AskModelId, Readonly<ModelRates>>> {
  if (!cached) {
    const parsed = parseRateOverrides(env.ASK_AI_PRICES_JSON);
    for (const { id } of ASK_MODELS) Object.freeze(parsed[id]);
    cached = Object.freeze(parsed);
  }
  return cached;
}
export function resetPricingForTests(): void {
  cached = null;
}

export function estimatedQuestionsLeft(balanceMicro: number, model: AskModelId, rates = effectiveRates()): number {
  return Math.max(0, Math.floor(balanceMicro / rates[model].estimatePerQuestionMicro));
}

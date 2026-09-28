/**
 * Env-free constants shared with client components; never import @/lib/env here.
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
  /** a prompt budget (the system prompt tells the model this number); maxSteps is the hard bound the loop enforces */
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
import { DEFAULT_RATES, PRICES_AS_OF, costMicro, usageFromSdk, addUsage, ZERO_USAGE, parseRateOverrides, effectiveRates, resetPricingForTests, estimatedQuestionsLeft } from './pricing';

describe('pricing', () => {
  beforeEach(() => { envMock.env = {}; resetPricingForTests(); });
  afterEach(() => vi.restoreAllMocks());

  it('carries the 2026-09-28 rates in micro-dollars per token', () => {
    expect(PRICES_AS_OF).toBe('2026-09-28');
    expect(DEFAULT_RATES['claude-sonnet-5']).toEqual({ input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10, estimatePerQuestionMicro: 40_000 });
    expect(DEFAULT_RATES['claude-opus-5-5']).toEqual({ input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20, estimatePerQuestionMicro: 80_000 });
    expect(DEFAULT_RATES['claude-haiku-4-5']).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5, estimatePerQuestionMicro: 15_000 });
  });
  it('costs a turn from the four token counts with one rounding', () => {
    const usage = { noCacheTokens: 5_000, cacheWriteTokens: 1_000, cacheReadTokens: 10_000, outputTokens: 1_000 };
    // 5000*2 + 1000*2.5 + 10000*0.2 + 1000*10 = 10000 + 2500 + 2000 + 10000
    expect(costMicro('claude-sonnet-5', usage)).toBe(24_500);
    expect(costMicro('claude-opus-5-5', usage)).toBe(20_000 + 5_000 + 2_000 + 20_000);
    expect(costMicro('claude-haiku-4-5', { noCacheTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 3, outputTokens: 0 })).toBe(1); // 1 + 0.3 → 1
  });
  it('maps SDK usage, filling missing detail counts from the total', () => {
    expect(usageFromSdk({ inputTokens: 100, inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 30, cacheWriteTokens: 10 }, outputTokens: 7, outputTokenDetails: { textTokens: 7, reasoningTokens: 0 }, totalTokens: 107 }))
      .toEqual({ noCacheTokens: 60, cacheWriteTokens: 10, cacheReadTokens: 30, outputTokens: 7 });
    expect(usageFromSdk({ inputTokens: 100, inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: 30, cacheWriteTokens: undefined }, outputTokens: undefined, outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined }, totalTokens: undefined }))
      .toEqual({ noCacheTokens: 70, cacheWriteTokens: 0, cacheReadTokens: 30, outputTokens: 0 });
  });
  it('adds usage', () => {
    expect(addUsage(ZERO_USAGE, { noCacheTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4 })).toEqual({ noCacheTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4 });
  });
  it('accepts partial overrides per model and warns about junk', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rates = parseRateOverrides('{"claude-sonnet-5":{"input":3,"output":15},"claude-fable-5-1":{"input":1},"claude-opus-5-5":{"input":-1,"cacheRead":"x"}}');
    expect(rates['claude-sonnet-5']).toMatchObject({ input: 3, output: 15, cacheWrite: 2.5, cacheRead: 0.2 });
    expect(rates['claude-opus-5-5']).toEqual(DEFAULT_RATES['claude-opus-5-5']);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(parseRateOverrides('not json')).toEqual(DEFAULT_RATES);
    expect(parseRateOverrides(undefined)).toEqual(DEFAULT_RATES);
  });
  it('effectiveRates reads ASK_AI_PRICES_JSON once per process', () => {
    envMock.env.ASK_AI_PRICES_JSON = '{"claude-haiku-4-5":{"output":6}}';
    expect(effectiveRates()['claude-haiku-4-5'].output).toBe(6);
    envMock.env.ASK_AI_PRICES_JSON = '{"claude-haiku-4-5":{"output":7}}';
    expect(effectiveRates()['claude-haiku-4-5'].output).toBe(6);
  });
  it('estimates questions left from the balance and the model estimate', () => {
    expect(estimatedQuestionsLeft(10_000_000, 'claude-sonnet-5')).toBe(250);
    expect(estimatedQuestionsLeft(39_999, 'claude-sonnet-5')).toBe(0);
    expect(estimatedQuestionsLeft(0, 'claude-opus-5-5')).toBe(0);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);

import {
  ASK_MODELS, DEFAULT_MODEL, ASK_LIMITS, MICRO, usdToMicro, isAskModelId, askAiEnabled, anthropicApiKey,
  dailyMessageLimit, globalMonthlyCeilingMicro, defaultAllowanceMicro, resetAskConfigForTests,
} from './config';

describe('ask config', () => {
  beforeEach(() => { envMock.env = {}; resetAskConfigForTests(); });
  afterEach(() => vi.restoreAllMocks());

  it('lists the three models with Sonnet 5 as the default', () => {
    expect(ASK_MODELS.map((m) => m.id)).toEqual(['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5']);
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5');
    expect(isAskModelId('claude-opus-5-5')).toBe(true);
    expect(isAskModelId('claude-fable-5-1')).toBe(false);
    expect(isAskModelId(42)).toBe(false);
  });
  it('fixed limits match the spec §10', () => {
    expect(ASK_LIMITS).toMatchObject({ maxChats: 5, maxMessagesPerChat: 200, maxMessageChars: 4000, historyWindowMessages: 20, historyWindowTokens: 60_000, maxToolCallsPerTurn: 8, maxSteps: 10, maxOutputTokens: 4096, turnDeadlineMs: 240_000, inFlightExpiryMinutes: 5 });
    expect(Object.isFrozen(ASK_LIMITS)).toBe(true);
  });
  it('converts dollars to micro-dollars with rounding', () => {
    expect(MICRO).toBe(1_000_000);
    expect(usdToMicro(10)).toBe(10_000_000);
    expect(usdToMicro(0.004)).toBe(4000);
    expect(usdToMicro(1.0000004)).toBe(1_000_000);
  });
  it('the kill switch is on only for exactly "1"', () => {
    expect(askAiEnabled()).toBe(false);
    envMock.env.ASK_AI_ENABLED = '1';
    expect(askAiEnabled()).toBe(true);
    envMock.env.ASK_AI_ENABLED = 'true';
    expect(askAiEnabled()).toBe(false);
  });
  it('the API key is trimmed and null when blank', () => {
    expect(anthropicApiKey()).toBeNull();
    envMock.env.ANTHROPIC_API_KEY = '  sk-ant-test  ';
    expect(anthropicApiKey()).toBe('sk-ant-test');
    envMock.env.ANTHROPIC_API_KEY = '   ';
    expect(anthropicApiKey()).toBeNull();
  });
  it('numeric dials default, parse, and fall back with one warning on junk, naming the variable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(dailyMessageLimit()).toBe(100);
    expect(globalMonthlyCeilingMicro()).toBe(200_000_000);
    expect(defaultAllowanceMicro()).toBe(10_000_000);
    envMock.env.ASK_AI_DAILY_MESSAGE_LIMIT = '25';
    envMock.env.ASK_AI_GLOBAL_MONTHLY_CEILING_USD = '30.5';
    envMock.env.ASK_AI_DEFAULT_ALLOWANCE_USD = '12';
    resetAskConfigForTests();
    expect(dailyMessageLimit()).toBe(25);
    expect(globalMonthlyCeilingMicro()).toBe(30_500_000);
    expect(defaultAllowanceMicro()).toBe(12_000_000);
    envMock.env.ASK_AI_DAILY_MESSAGE_LIMIT = 'lots';
    envMock.env.ASK_AI_GLOBAL_MONTHLY_CEILING_USD = '-1';
    resetAskConfigForTests();
    expect(dailyMessageLimit()).toBe(100);
    expect(dailyMessageLimit()).toBe(100);
    expect(globalMonthlyCeilingMicro()).toBe(200_000_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([m]) => String(m))).toEqual([
      expect.stringContaining('ASK_AI_DAILY_MESSAGE_LIMIT'),
      expect.stringContaining('ASK_AI_GLOBAL_MONTHLY_CEILING_USD'),
    ]);
  });
  it('refuses a non-integer daily message limit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    envMock.env.ASK_AI_DAILY_MESSAGE_LIMIT = '25.5';
    resetAskConfigForTests();
    expect(dailyMessageLimit()).toBe(100);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ASK_AI_DAILY_MESSAGE_LIMIT');
  });
  it('refuses a zero daily message limit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    envMock.env.ASK_AI_DAILY_MESSAGE_LIMIT = '0';
    resetAskConfigForTests();
    expect(dailyMessageLimit()).toBe(100);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ASK_AI_DAILY_MESSAGE_LIMIT');
  });
  it('accepts zero for the monthly ceiling and the default allowance with no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    envMock.env.ASK_AI_GLOBAL_MONTHLY_CEILING_USD = '0';
    envMock.env.ASK_AI_DEFAULT_ALLOWANCE_USD = '0';
    resetAskConfigForTests();
    expect(globalMonthlyCeilingMicro()).toBe(0);
    expect(defaultAllowanceMicro()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
  it('refuses a monthly ceiling that overflows to Infinity under micro-dollar conversion', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    envMock.env.ASK_AI_GLOBAL_MONTHLY_CEILING_USD = '1e308';
    resetAskConfigForTests();
    expect(globalMonthlyCeilingMicro()).toBe(200_000_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ASK_AI_GLOBAL_MONTHLY_CEILING_USD');
  });
  it('refuses a positive default allowance that rounds away to zero under micro-dollar conversion', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    envMock.env.ASK_AI_DEFAULT_ALLOWANCE_USD = '0.0000001';
    resetAskConfigForTests();
    expect(defaultAllowanceMicro()).toBe(10_000_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ASK_AI_DEFAULT_ALLOWANCE_USD');
  });
});

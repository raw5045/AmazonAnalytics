import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ASK_LIMITS } from './models';
import { CHAT_CAP_MESSAGE, TOO_LONG_MESSAGE, dailyLimitMessage } from './messages';

const source = () => readFileSync(path.join(__dirname, 'messages.ts'), 'utf8');

describe('messages', () => {
  it('dailyLimitMessage uses singular "question" only for a limit of exactly 1', () => {
    expect(dailyLimitMessage(1, 3_600)).toBe("You've reached today's limit of 1 question. It resets in 1 hour.");
    expect(dailyLimitMessage(2, 30)).toBe("You've reached today's limit of 2 questions. It resets in less than an hour.");
    expect(dailyLimitMessage(100, 21_600)).toBe("You've reached today's limit of 100 questions. It resets in 6 hours.");
  });
  it('CHAT_CAP_MESSAGE and TOO_LONG_MESSAGE are built from ASK_LIMITS, not hard-coded', () => {
    expect(CHAT_CAP_MESSAGE).toBe(`You have ${ASK_LIMITS.maxChats} chats. Delete one to start another.`);
    expect(TOO_LONG_MESSAGE).toBe(`Keep it under ${ASK_LIMITS.maxMessageChars.toLocaleString('en-US')} characters.`);
    expect(TOO_LONG_MESSAGE).toContain('4,000');
  });
  it('stays env-free: no import from ./config, @/lib/env or the ai package', () => {
    const src = source();
    expect(src).not.toMatch(/from ['"]\.\/config['"]/);
    expect(src).not.toMatch(/from ['"]@\/lib\/env['"]/);
    expect(src).not.toMatch(/from ['"]ai['"]/);
  });
});

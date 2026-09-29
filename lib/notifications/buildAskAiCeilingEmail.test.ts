import { describe, it, expect } from 'vitest';
import { buildAskAiCeilingEmail } from './buildAskAiCeilingEmail';
describe('buildAskAiCeilingEmail', () => {
  it('states the level, month, spend and ceiling in dollars, and what happens', () => {
    const e = buildAskAiCeilingEmail({ level: 80, month: '2026-09-01', costMicro: 160_500_000, ceilingMicro: 200_000_000, questions: 4012 });
    expect(e.subject).toBe('Ask AI is at 80% of its monthly ceiling');
    expect(e.text).toContain('$160.50 of the $200.00 ceiling');
    expect(e.text).toContain('September 2026');
    expect(e.text).toContain('4,012 questions');
    expect(e.html).toContain('ASK_AI_GLOBAL_MONTHLY_CEILING_USD');
    const f = buildAskAiCeilingEmail({ level: 100, month: '2026-09-01', costMicro: 200_000_000, ceilingMicro: 200_000_000, questions: 5000 });
    expect(f.subject).toBe('Ask AI is paused: monthly ceiling reached');
    expect(f.text).toContain('paused for everyone');
  });
});

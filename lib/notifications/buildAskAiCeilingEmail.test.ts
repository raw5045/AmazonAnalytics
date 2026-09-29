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
  it('tells the owner raising the ceiling does not re-arm alerts until next month, only on the 100% email (C-m3)', () => {
    const at100 = buildAskAiCeilingEmail({ level: 100, month: '2026-09-01', costMicro: 200_000_000, ceilingMicro: 200_000_000, questions: 5000 });
    expect(at100.text).toContain('does not re-arm these alerts until next month');
    const at80 = buildAskAiCeilingEmail({ level: 80, month: '2026-09-01', costMicro: 160_000_000, ceilingMicro: 200_000_000, questions: 4000 });
    expect(at80.text).not.toContain('re-arm');
  });
  it('uses the singular "question" for exactly one, and a thousands separator for large amounts (C-m7)', () => {
    const e = buildAskAiCeilingEmail({ level: 80, month: '2026-09-01', costMicro: 1_234_560_000, ceilingMicro: 2_000_000_000, questions: 1 });
    expect(e.text).toContain('1 question)');
    expect(e.text).not.toContain('1 questions)');
    expect(e.text).toContain('$1,234.56 of the $2,000.00 ceiling');
  });
});

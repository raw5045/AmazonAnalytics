import { describe, it, expect } from 'vitest';
import { EXAMPLE_QUESTIONS, FIRST_EXAMPLE, MORE_EXAMPLES } from './examples';
import { WORKSPACE_EXAMPLES } from '@/lib/workspace/examples';

// Spec 2026-09-30 §11.10: Ask AI's example list unchanged — it has no write tools, so no workspace prompt belongs in it.
describe('Ask AI example prompts', () => {
  it('include none of the workspace prompts', () => {
    for (const w of WORKSPACE_EXAMPLES) {
      expect(FIRST_EXAMPLE).not.toContain(w);
      for (const q of MORE_EXAMPLES) expect(q).not.toContain(w);
      for (const q of EXAMPLE_QUESTIONS) expect(q).not.toContain(w); // what the Ask AI empty state renders
    }
  });

  it('keep exactly eight prompts behind the first, the products one last (spec 2026-10-23 §3)', () => {
    expect(MORE_EXAMPLES).toHaveLength(8);
    expect(MORE_EXAMPLES.at(-1)).toBe('Show me products in the supplements niche that sell over 1,000 units a day and were listed within the last 60 days.');
    expect(EXAMPLE_QUESTIONS).toContain('Show me products in the supplements niche that sell over 1,000 units a day and were listed within the last 60 days.');
  });
});

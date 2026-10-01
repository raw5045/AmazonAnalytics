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

  it('keep exactly seven prompts behind the first', () => {
    expect(MORE_EXAMPLES).toHaveLength(7);
  });
});

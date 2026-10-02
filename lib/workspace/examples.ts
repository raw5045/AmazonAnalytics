/** Spec 2026-09-30 §9.3: shown on the Connect AI page only while MCP_WRITE_ENABLED is on — not in Ask AI's empty state (lib/ask/examples.ts): the chat has the write tools behind ASK_AI_WRITES_ENABLED since arc 4, but its example questions stay research-only until the layout pass. */
export const WORKSPACE_EXAMPLES = [
  'Save that search as a view called Lamps under 500 reviews.',
  'Build a custom category called Lighting from everything under Lamps and Ceiling Lights, then show me its top keywords.',
  'Add the top 20 results to my watchlist.',
] as const;

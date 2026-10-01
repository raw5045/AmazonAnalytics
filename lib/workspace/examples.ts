/** Spec 2026-09-30 §9.3: shown on the Connect AI page only while MCP_WRITE_ENABLED is on — never in Ask AI's empty state (lib/ask/examples.ts), which has no write tools. */
export const WORKSPACE_EXAMPLES = [
  'Save that search as a view called Lamps under 500 reviews.',
  'Build a custom category called Lighting from everything under Lamps and Ceiling Lights, then show me its top keywords.',
  'Add the top 20 results to my watchlist.',
] as const;

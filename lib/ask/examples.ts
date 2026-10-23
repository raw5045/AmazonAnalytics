/** The owner-chosen prompts (eight on 2026-09-24, then the products one, spec 2026-10-23 §3), shared by the Connect AI page and the Ask AI empty state. */
export const FIRST_EXAMPLE = 'Show me the highest volume keywords in the lighting niche with less than 500 average reviews.';
export const MORE_EXAMPLES = [
  'Which lighting keywords gained the most search volume in the last 4 weeks?',
  'Find long-tail keywords about desk lamps, four words or more, with at least 1,000 searches a month.',
  "Which lighting keywords have top-clicked products that don't use the keyword in their titles?",
  "Give me the full picture on 'led strip lights': rank, estimated searches, top clicked products and category.",
  "How has 'solar path lights' trended over the past year?",
  "Compare 'floor lamp' and 'standing lamp'. Which has more demand and less competition?",
  'What categories do you have under pet supplies, and how many keywords are in each?',
  'Show me products in the supplements niche that sell over 1,000 units a day and were listed within the last 60 days.',
] as const;
export const EXAMPLE_QUESTIONS = [FIRST_EXAMPLE, ...MORE_EXAMPLES] as const;

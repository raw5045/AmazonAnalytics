/**
 * Sample prompts for a freshly connected client. The first one is always
 * visible; the rest sit behind a native <details> disclosure, so this stays a
 * server component with no client-side script. Copy chosen by the owner
 * (2026-09-24); every prompt maps onto something the research tools can do.
 */
const FIRST_EXAMPLE = 'Show me the highest volume keywords in the lighting niche with less than 500 average reviews.';

const MORE_EXAMPLES = [
  'Which lighting keywords gained the most search volume in the last 4 weeks?',
  'Find long-tail keywords about desk lamps, four words or more, with at least 1,000 searches a month.',
  "Which lighting keywords have top-clicked products that don't use the keyword in their titles?",
  "Give me the full picture on 'led strip lights': rank, estimated searches, top clicked products and category.",
  "How has 'solar path lights' trended over the past year?",
  "Compare 'floor lamp' and 'standing lamp'. Which has more demand and less competition?",
  'What categories do you have under pet supplies, and how many keywords are in each?',
];

const prompt = 'select-all rounded bg-slate-100 px-2 py-1.5';

export function ExampleQuestions({ className }: { className: string }) {
  return (
    <section className={className}>
      <h2 className="font-semibold">Try asking</h2>
      <p className={`mt-2 text-sm ${prompt}`}>&ldquo;{FIRST_EXAMPLE}&rdquo;</p>
      <details className="group mt-2 text-sm">
        <summary className="cursor-pointer select-none text-blue-700 hover:text-blue-800">
          <span className="group-open:hidden">Show more example questions</span>
          <span className="hidden group-open:inline">Hide example questions</span>
        </summary>
        <ul className="mt-2 space-y-1.5">
          {MORE_EXAMPLES.map((q) => (
            <li key={q} className={prompt}>
              &ldquo;{q}&rdquo;
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

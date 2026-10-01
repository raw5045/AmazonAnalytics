/**
 * Sample prompts for a freshly connected client. The first one is always
 * visible; the rest sit behind a native <details> disclosure, so this stays a
 * server component with no client-side script. Copy chosen by the owner
 * (2026-09-24); every prompt maps onto something the research tools can do.
 * Shared with the Ask AI empty state (lib/ask/examples.ts). With `writes` on
 * (MCP_WRITE_ENABLED), three workspace prompts follow inside the same
 * disclosure; Ask AI never shows those (spec 2026-09-30 §9.3).
 */
import { FIRST_EXAMPLE, MORE_EXAMPLES } from '@/lib/ask/examples';
import { WORKSPACE_EXAMPLES } from '@/lib/workspace/examples';

const prompt = 'select-all rounded bg-slate-100 px-2 py-1.5';

export function ExampleQuestions({ className, writes }: { className: string; writes: boolean }) {
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
        {writes && (
          <>
            <p className="mt-3 font-medium">With saving on, also try</p>
            <ul className="mt-2 space-y-1.5">
              {WORKSPACE_EXAMPLES.map((q) => (
                <li key={q} className={prompt}>
                  &ldquo;{q}&rdquo;
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </section>
  );
}

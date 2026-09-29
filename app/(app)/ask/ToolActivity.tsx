import type { ToolUIPart } from 'ai';

const LABELS: Record<string, string> = {
  'tool-get_research_guide': 'Reading the guide',
  'tool-resolve_categories': 'Resolving categories',
  'tool-search_keywords': 'Searching keywords',
  'tool-get_keyword_details': 'Loading keyword details',
  'tool-get_keyword_history': 'Loading history',
};
const compact = (input: unknown): string => {
  const s = JSON.stringify(input ?? {});
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
};

/** Spec §11.3: status lines while tools run; afterwards a "Used N tools" disclosure with each call's compact input, never the rows. */
export function ToolActivity({ parts, streaming }: { parts: ToolUIPart[]; streaming: boolean }) {
  if (parts.length === 0) return null;
  const pending = parts.filter((p) => p.state !== 'output-available' && p.state !== 'output-error');
  if (streaming && pending.length > 0) {
    return (
      <ul aria-live="polite" className="mb-2 text-xs text-slate-500">
        {pending.map((p) => <li key={p.toolCallId}>{LABELS[p.type] ?? 'Working'}…</li>)}
      </ul>
    );
  }
  return (
    <details className="mb-2 text-xs text-slate-600">
      <summary className="cursor-pointer select-none">Used {parts.length} {parts.length === 1 ? 'tool' : 'tools'}</summary>
      <ul className="mt-1 space-y-1">
        {parts.map((p) => (
          <li key={p.toolCallId}><span className="font-medium">{LABELS[p.type] ?? p.type}</span> <code className="break-all">{compact(p.input)}</code></li>
        ))}
      </ul>
    </details>
  );
}

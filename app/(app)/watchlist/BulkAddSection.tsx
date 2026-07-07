'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MAX_WATCHED_KEYWORDS, HARD_MAX_INPUT } from '@/lib/watchlist/validation';

/**
 * Inline bulk-add affordance on /watchlist. A native <details> collapsible
 * containing a textarea + submit button + last-submission result line.
 *
 * Closed by default. At-cap (currentCount >= MAX_WATCHED_KEYWORDS) the
 * textarea is disabled, the button is hidden, and a "remove some to add
 * more" inline message renders below the summary.
 *
 * See docs/superpowers/specs/2026-05-29-watchlist-bulk-add-design.md §6.
 */
export function BulkAddSection({ currentCount }: { currentCount: number }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const atCap = currentCount >= MAX_WATCHED_KEYWORDS;
  const canSubmit = !atCap && !submitting && text.trim().length > 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    const keywords = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (keywords.length === 0) return;

    setSubmitting(true);
    setOutcome(null);
    try {
      const res = await fetch('/api/watchlist/items/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keywords }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'too_many_keywords') {
          setOutcome({ kind: 'error', message: `Too many keywords (max ${HARD_MAX_INPUT}). Paste a smaller list.` });
        } else {
          setOutcome({ kind: 'error', message: "Couldn't save — try again." });
        }
        return;
      }
      const result = (await res.json()) as BulkAddResult;
      setText('');
      setOutcome({ kind: 'success', result });
      router.refresh();
    } catch {
      setOutcome({ kind: 'error', message: "Couldn't save — try again." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <details className="card-app mb-4 overflow-hidden">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-gray-800">
        ＋ Add keywords — one per line
      </summary>
      <div className="px-3 pb-3 pt-1 space-y-2">
        {atCap ? (
          <p className="text-sm text-gray-700">
            You&apos;re at the {MAX_WATCHED_KEYWORDS}-keyword limit. Remove some to add more.
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={submitting}
              rows={6}
              placeholder="wireless earbuds&#10;airpods case&#10;usb cable"
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm font-mono bg-white disabled:bg-gray-100"
            />
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={!canSubmit}
                className="rounded-full bg-amber-300 px-4 py-1.5 text-sm font-semibold text-[#0B1E3A] hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Adding…' : 'Add to watchlist'}
              </button>
              {outcome && <ResultLine outcome={outcome} />}
            </div>
          </form>
        )}
      </div>
    </details>
  );
}

// --- Types + helpers ---------------------------------------------------

interface BulkAddResult {
  added: number;
  alreadyWatching: number;
  unmatched: string[];
  skippedAtCap: number;
}

type Outcome =
  | null
  | { kind: 'success'; result: BulkAddResult }
  | { kind: 'error'; message: string };

function ResultLine({ outcome }: { outcome: Exclude<Outcome, null> }) {
  if (outcome.kind === 'error') {
    return <span className="text-sm text-red-700">× {outcome.message}</span>;
  }
  const { result } = outcome;
  const parts: string[] = [`✓ ${result.added} added`];
  if (result.alreadyWatching > 0) {
    parts.push(`${result.alreadyWatching} already watching`);
  }
  if (result.unmatched.length > 0) {
    const quoted = result.unmatched.map((u) => `"${u}"`).join(', ');
    parts.push(`${result.unmatched.length} didn't match: ${quoted}`);
  }
  if (result.skippedAtCap > 0) {
    parts.push(`${result.skippedAtCap} skipped (at ${MAX_WATCHED_KEYWORDS}-keyword limit)`);
  }
  return <span className="text-sm text-gray-700">{parts.join(' · ')}</span>;
}

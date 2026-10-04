'use client';
import { useId, useState } from 'react';

/** The account's two "always allow" toggles (spec 2026-10-01 §3, §8), as PATCH /api/ask/account answers them. */
export interface WriteToggles { autoApproveChanges: boolean; autoApproveDeletes: boolean }
type Toggle = keyof WriteToggles;

const SWITCHES: ReadonlyArray<{ field: Toggle; label: string; note: string }> = [
  { field: 'autoApproveChanges', label: 'Changes: always allow', note: 'Ask AI will not ask before saving or changing things.' },
  { field: 'autoApproveDeletes', label: 'Deletes: always allow', note: 'Ask AI will not ask before deleting things — deletes are permanent.' },
];
const SAVE_FAILED = 'Could not save that setting. Try again.';

/** Both toggles from the route's answer, or null for any other body. */
function savedToggles(body: unknown): WriteToggles | null {
  if (typeof body !== 'object' || body === null) return null;
  const { autoApproveChanges, autoApproveDeletes } = body as Record<string, unknown>;
  return typeof autoApproveChanges === 'boolean' && typeof autoApproveDeletes === 'boolean' ? { autoApproveChanges, autoApproveDeletes } : null;
}

/** One toggle's save: both values from the answer, or null when it failed (refused, offline, or any other body). */
async function saveToggle(field: Toggle, next: boolean): Promise<WriteToggles | null> {
  try {
    // 'PATCH' in capitals: fetch upper-cases only DELETE/GET/HEAD/OPTIONS/POST/PUT, so a
    // lower-case 'patch' would reach Next as written and be answered 405.
    const res = await fetch('/api/ask/account', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ [field]: next }),
    });
    return res.ok ? savedToggles(await res.json()) : null;
  } catch {
    return null; // offline, or a body that is not JSON: the same as a refusal
  }
}

/**
 * Spec 2026-10-01 §8, drawn as switches since spec 2026-10-04 §3: the two "always allow" toggles.
 * Controlled: AskAi holds the values, because an "Always approve" answered on a card turns a switch
 * on as well — possibly in the same tick as a change here, so every change is an updater on the
 * current pair, never a copy of a rendered one. A toggle shows at once, saves with only its own
 * field, then takes both values from the answer; a failed save puts that switch back and says so (a
 * new attempt clears the line first, so a second failure in a row is announced again). Both
 * switches stay disabled while a save is out, so there is one request at a time: two could answer
 * out of order (each answer carries both values), and a revert could restore a value that is
 * already stale.
 */
export function WriteSwitches({ value, onChange }: { value: WriteToggles; onChange: (update: (prev: WriteToggles) => WriteToggles) => void }) {
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const toggle = async (field: Toggle, next: boolean) => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    onChange((t) => ({ ...t, [field]: next }));
    const saved = await saveToggle(field, next);
    setSaving(false);
    setFailed(saved === null);
    if (saved) onChange(() => saved);
    else onChange((t) => ({ ...t, [field]: !next }));
  };
  return (
    <fieldset className="text-sm">
      <legend className="text-xs font-semibold text-slate-700">Approvals</legend>
      <div className="mt-1.5 flex flex-col gap-1.5">
        {SWITCHES.map(({ field, label, note }) => (
          <div key={field}>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700">
              {/* The native checkbox stays for assistive tech and tests (sr-only); the span is the drawn switch. */}
              <input
                type="checkbox"
                className="peer sr-only"
                checked={value[field]}
                disabled={saving}
                aria-describedby={`${id}-${field}`}
                onChange={(e) => void toggle(field, e.target.checked)}
              />
              <span
                aria-hidden="true"
                className="relative inline-block h-4 w-7 flex-none rounded-full bg-slate-400 transition after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-white after:transition peer-checked:bg-sky-500 peer-checked:after:translate-x-3 peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400 peer-focus-visible:ring-offset-1 peer-disabled:opacity-50"
              />
              {label}
            </label>
            {/* Outside the label: inside it, the note would join the checkbox's name as well as describe it. */}
            <span id={`${id}-${field}`} className="sr-only">{note}</span>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-slate-500">Off, Ask AI asks in a card first. Deletes are permanent.</p>
      <p aria-live="polite" className="text-xs text-red-700">{failed ? SAVE_FAILED : null}</p>
    </fieldset>
  );
}

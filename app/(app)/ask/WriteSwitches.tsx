'use client';
import { useEffect, useId, useRef, useState } from 'react';

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

/**
 * Spec 2026-10-01 §8: the two "always allow" switches. Controlled: AskAi holds the values, because
 * an "Always approve" answered on a card turns a switch on as well. A toggle shows at once, saves
 * with only its own field, then takes both values from the answer; a failed save puts the switch
 * back and says so. Both switches stay disabled while a save is out, so there is one request at a
 * time: two could answer out of order (each answer carries both values), and a revert could
 * restore a value that is already stale.
 */
export function WriteSwitches({ value, onChange }: { value: WriteToggles; onChange: (next: WriteToggles) => void }) {
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // The values as last rendered, for the revert after the await: an "Always approve" answered in
  // the thread while the save was out (AskAi's onAlwaysApproved) must survive a failed save.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  const toggle = async (field: Toggle, next: boolean) => {
    if (saving) return;
    setSaving(true);
    onChange({ ...value, [field]: next });
    let saved: WriteToggles | null = null;
    try {
      // 'PATCH' in capitals: fetch upper-cases only DELETE/GET/HEAD/OPTIONS/POST/PUT, so a
      // lower-case 'patch' would reach Next as written and be answered 405.
      const res = await fetch('/api/ask/account', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ [field]: next }),
      });
      if (res.ok) saved = savedToggles(await res.json());
    } catch {
      // Offline, or a body that is not JSON: the same as a refusal.
    }
    setSaving(false);
    setFailed(saved === null);
    onChange(saved ?? { ...latest.current, [field]: !next });
  };
  return (
    <fieldset className="text-sm">
      <legend className="font-semibold">Approvals</legend>
      <div className="mt-1 flex flex-col gap-1">
        {SWITCHES.map(({ field, label, note }) => (
          <div key={field}>
            <label className="flex items-center gap-2 text-slate-700">
              <input
                type="checkbox"
                checked={value[field]}
                disabled={saving}
                aria-describedby={`${id}-${field}`}
                onChange={(e) => void toggle(field, e.target.checked)}
              />
              {label}
            </label>
            <p id={`${id}-${field}`} className="ml-5 text-xs text-slate-500">{note}</p>
          </div>
        ))}
      </div>
      <p aria-live="polite" className="text-xs text-red-700">{failed ? SAVE_FAILED : null}</p>
    </fieldset>
  );
}

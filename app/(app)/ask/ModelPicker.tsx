'use client';
import { useId } from 'react';
import { ASK_MODELS, type AskModelId } from '@/lib/ask/models';

export const MODEL_FIXED_NOTE = 'The model stays fixed for this chat. Start a new chat to use another one.';
const CHIP = 'inline-flex max-w-full items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600';

/** Spec 2026-10-04 §5: the new chat's model, a labelled select in the composer's bottom row; the first send fixes it (Thread disables this once the chat has a message). */
export function ModelPicker({ value, onChange, disabled }: { value: AskModelId; onChange: (m: AskModelId) => void; disabled: boolean }) {
  const noteId = useId();
  return (
    <span className={CHIP}>
      <span aria-hidden="true">Model:</span>
      <select
        aria-label="Model"
        aria-describedby={noteId}
        title={MODEL_FIXED_NOTE}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const next = ASK_MODELS.find((m) => m.id === e.target.value);
          if (next) onChange(next.id);
        }}
        className="min-w-0 truncate rounded-sm bg-transparent text-xs text-slate-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60"
      >
        {ASK_MODELS.map((m) => (
          <option key={m.id} value={m.id}>{m.note ? `${m.label}, ${m.note}` : m.label}</option>
        ))}
      </select>
      <span id={noteId} className="sr-only">{MODEL_FIXED_NOTE}</span>
    </span>
  );
}

/** An open chat's model, fixed: the read-only chip in the picker's place. */
export function ModelLabel({ model }: { model: AskModelId }) {
  return (
    <span className={CHIP}>
      <span>{ASK_MODELS.find((m) => m.id === model)?.label ?? model}</span>
      <span className="text-slate-500">· fixed for this chat</span>
    </span>
  );
}

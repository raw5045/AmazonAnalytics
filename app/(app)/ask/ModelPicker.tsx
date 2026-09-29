'use client';
import { ASK_MODELS, type AskModelId } from '@/lib/ask/models';

export function ModelPicker({ value, onChange, disabled }: { value: AskModelId; onChange: (m: AskModelId) => void; disabled: boolean }) {
  return (
    <fieldset className="text-sm">
      <legend className="font-semibold">Model</legend>
      <div className="mt-2 flex flex-col gap-1">
        {ASK_MODELS.map((m) => (
          <label key={m.id} className="flex items-center gap-2">
            <input type="radio" name="model" value={m.id} checked={value === m.id} disabled={disabled} onChange={() => onChange(m.id)} />
            <span>{m.label}{m.note ? <span className="text-slate-500">, {m.note}</span> : null}</span>
          </label>
        ))}
      </div>
      <p className="mt-1 text-xs text-slate-500">The model stays fixed for this chat. Start a new chat to use another one.</p>
    </fieldset>
  );
}

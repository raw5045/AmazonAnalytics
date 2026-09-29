'use client';
import { ASK_LIMITS } from '@/lib/ask/models';
import { ACCURACY_NOTICE } from '@/lib/ask/messages';

export function Composer({ value, onChange, onSend, onStop, streaming, disabled, sendDisabled, disabledReason }: {
  value: string; onChange: (v: string) => void; onSend: (text: string) => void; onStop: () => void; streaming: boolean;
  disabled: boolean;
  /** Task 9 fix round M5: a separate gate from `disabled` for the Stop cooldown — it disables only Send, so the textarea (and its focus) is never lost. */
  sendDisabled: boolean;
  disabledReason: string | null;
}) {
  const remaining = ASK_LIMITS.maxMessageChars - value.length;
  const canSend = !disabled && !sendDisabled && !streaming && value.trim().length > 0 && remaining >= 0;
  const submit = () => { if (canSend) onSend(value.trim()); };
  const button = 'rounded-md px-3 py-1.5 text-sm font-medium';
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3">
      <textarea
        aria-label="Your question"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey) return;
          // IME composition (Task 9 fix round, item 7): while an IME (Japanese/Chinese/Korean
          // input) is composing, its own confirm keystroke is also "Enter" — sending here would
          // submit the in-progress composition instead of letting the IME finish it.
          // isComposing is the standard signal; keyCode 229 is what some browsers still send for
          // the same event when isComposing has already flipped back to false by keydown time.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          submit();
        }}
        maxLength={ASK_LIMITS.maxMessageChars}
        rows={3}
        disabled={disabled}
        placeholder="Ask about keywords, categories or trends"
        className="w-full resize-y rounded border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">{ACCURACY_NOTICE}</p>
        <div className="flex items-center gap-2">
          {value.length >= 3500 && <span className="text-xs text-slate-500">{remaining} left</span>}
          {streaming ? (
            <button type="button" onClick={onStop} className={`${button} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}>Stop</button>
          ) : (
            <button type="submit" disabled={!canSend} className={`${button} bg-[#0B1E3A] text-white disabled:opacity-50`}>Send</button>
          )}
        </div>
      </div>
      {disabled && disabledReason && <p role="status" className="text-sm text-amber-800">{disabledReason}</p>}
    </form>
  );
}

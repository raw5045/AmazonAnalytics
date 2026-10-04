'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { ASK_LIMITS } from '@/lib/ask/models';
import { ACCURACY_NOTICE } from '@/lib/ask/messages';

/** The box grows with its content up to this height (about ten lines), then scrolls inside. */
const MAX_BOX_HEIGHT_PX = 240;

/**
 * Spec 2026-10-04 §4: the box (textarea, then a bottom row with the model control on the left and
 * the counter + Send/Stop on the right), the accuracy notice under it, the disabled reason above it.
 * Enter sends, Shift+Enter breaks the line, IME composition is respected (Task 9 fix round, item 7).
 * `sendDisabled` disables only Send (Task 9 fix round M5): the textarea and its focus are never lost.
 */
export function Composer({ value, onChange, onSend, onStop, streaming, disabled, sendDisabled, disabledReason, modelControl }: {
  value: string; onChange: (v: string) => void; onSend: (text: string) => void; onStop: () => void; streaming: boolean;
  disabled: boolean;
  sendDisabled: boolean;
  disabledReason: string | null;
  /** The model select (a new chat) or the fixed-model chip (an open chat) — Thread decides which. */
  modelControl?: ReactNode;
}) {
  const boxRef = useRef<HTMLTextAreaElement>(null);
  // Auto-grow: reset, then fit the content. Where layout is not measured (jsdom: scrollHeight 0)
  // only the reset happens. Touches the DOM only — not the setState-in-effect the lint rule forbids.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, MAX_BOX_HEIGHT_PX)}px`;
  }, [value]);
  const remaining = ASK_LIMITS.maxMessageChars - value.length;
  const canSend = !disabled && !sendDisabled && !streaming && value.trim().length > 0 && remaining >= 0;
  const submit = () => { if (canSend) onSend(value.trim()); };
  const button = 'rounded-md px-3 py-1.5 text-sm font-medium';
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-1.5">
      {disabled && disabledReason && <p role="status" className="text-sm text-amber-800">{disabledReason}</p>}
      <div className="rounded-2xl border border-slate-300 bg-white shadow-sm focus-within:border-sky-400">
        <textarea
          ref={boxRef}
          aria-label="Your question"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            // IME composition (Task 9 fix round, item 7): the IME's own confirm keystroke is also
            // "Enter"; keyCode 229 is what some browsers still send once isComposing has flipped back.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            submit();
          }}
          maxLength={ASK_LIMITS.maxMessageChars}
          rows={2}
          disabled={disabled}
          placeholder="Ask about keywords, categories or trends"
          className="block w-full resize-none rounded-2xl bg-transparent px-4 pt-3 pb-1 text-[15px] leading-relaxed focus:outline-none disabled:text-slate-500"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5">
          <div>{modelControl}</div>
          <div className="flex items-center gap-2">
            {value.length >= 3500 && <span className="text-xs text-slate-500">{remaining} left</span>}
            {streaming ? (
              <button type="button" onClick={onStop} className={`${button} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}>Stop</button>
            ) : (
              <button type="submit" disabled={!canSend} className={`${button} bg-[#0B1E3A] text-white hover:bg-[#13294f] disabled:opacity-50 disabled:hover:bg-[#0B1E3A]`}>Send</button>
            )}
          </div>
        </div>
      </div>
      <p className="text-center text-[11px] text-slate-500">{ACCURACY_NOTICE}</p>
    </form>
  );
}

'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { isToolUIPart, type ToolUIPart } from 'ai';
import { ASK_MODELS, type AskModelId } from '@/lib/ask/models';
import type { AskUIMessage } from '@/lib/ask/conversations';
import { EXAMPLE_QUESTIONS } from '@/lib/ask/examples';
import { CUT_OFF_MESSAGE, FAILED_MESSAGE, RAN_OUT_MESSAGE, STOPPED_LINE, TOO_LONG_TURN_MESSAGE } from '@/lib/ask/messages';
import { describeChatError } from '@/lib/ask/clientErrors';
import { createAskTransport } from '@/lib/ask/transport';
import { AnswerMarkdown } from './AnswerMarkdown';
import { Composer } from './Composer';
import { ModelPicker } from './ModelPicker';
import { ToolActivity } from './ToolActivity';

export interface OpenConversation { id: string; model: AskModelId; messageCount: number; messages: AskUIMessage[] }

/** How long the server may still be settling/saving a stopped turn under the lock (Task 8 review's "Notes for later tasks"): an immediate resend inside this window can get a 409 busy. Task 9 D6. */
const STOP_COOLDOWN_MS = 2000;
/** On an aborted first send, delay the URL move so the server's save of the partial answer lands before the page reloads the chat (Task 9 D7). */
const ABORT_NAV_DELAY_MS = 1500;

function hasVisibleText(m: AskUIMessage): boolean {
  return m.parts.some((p) => p.type === 'text' && p.text.trim().length > 0);
}

/**
 * One status line per assistant message (Task 9 D4). `status` (stopped/failed) is the only piece
 * persisted to storage, so it always applies. `finishReason`/`stopReason` are live-only — set as
 * the turn streams and never written to the DB (lib/ask/conversations.ts's `storedToUiMessage`
 * reconstructs only `{ status }`) — so a reloaded chat's assistant message falls back to the "no
 * text produced" heuristic for a ran-out-of-steps read. `isLive` suppresses the fallback for the
 * message currently streaming, where "no text yet" simply means the answer is still in progress.
 */
function statusLineFor(m: AskUIMessage, isLive: boolean): string | null {
  const meta = m.metadata;
  if (meta?.status === 'stopped') return meta.stopReason === 'deadline' ? TOO_LONG_TURN_MESSAGE : STOPPED_LINE;
  if (meta?.status === 'failed') return FAILED_MESSAGE;
  if (isLive) return null;
  if (meta?.finishReason === 'length') return CUT_OFF_MESSAGE;
  if (meta?.finishReason === 'tool-calls' || !hasVisibleText(m)) return RAN_OUT_MESSAGE;
  return null;
}

/**
 * Spec §11.3. One hook instance per chat (AskAi keys this component by the open chat's id). The
 * transport (lib/ask/transport.ts) sends only the new message text plus the chat id (and the model
 * on a first send) — the server loads history itself (spec §13). A first send learns the new
 * chat's id from the assistant message metadata and moves the URL there.
 */
export function Thread({ open, defaultModel, canSend, cantSendReason, appOrigin }: {
  open: OpenConversation | null; defaultModel: AskModelId; canSend: boolean; cantSendReason: string | null; appOrigin: string;
}) {
  const router = useRouter();
  const [model, setModel] = useState<AskModelId>(open?.model ?? defaultModel);
  const [draft, setDraft] = useState('');
  const [cooldown, setCooldown] = useState(false);
  const [transport] = useState(() => createAskTransport());
  const { messages, sendMessage, status, stop, error } = useChat<AskUIMessage>({
    id: open?.id ?? 'new',
    messages: open?.messages ?? [],
    generateId: () => crypto.randomUUID(),
    transport,
    onFinish: ({ message, isAbort }) => {
      const cid = message.metadata?.conversationId;
      const moveOn = () => {
        if (!open && cid) router.replace(`/ask?c=${cid}`);
        router.refresh();
      };
      // A member-initiated Stop (or a closed tab) ends the request with isAbort before the
      // server's onEnd has necessarily finished saving the partial answer — wait it out first.
      if (isAbort) setTimeout(moveOn, ABORT_NAV_DELAY_MS);
      else moveOn();
    },
  });
  const streaming = status === 'submitted' || status === 'streaming';
  const send = (text: string) => {
    setDraft('');
    void sendMessage({ text }, { body: { conversationId: open?.id ?? null, ...(open ? {} : { model }) } });
  };
  const onStop = () => {
    stop();
    setCooldown(true);
    setTimeout(() => setCooldown(false), STOP_COOLDOWN_MS);
  };
  const last = messages[messages.length - 1];
  /**
   * Genuinely no assistant message ever arrived for the last question — distinct from an assistant
   * message that arrived with no text, which the per-message line inside the list already covers
   * (Task 9 D4: one line per situation, not two).
   */
  const ranOut = status === 'ready' && last?.role === 'user';
  const empty = messages.length === 0;

  return (
    <section aria-label="Conversation" className="flex min-h-[60vh] flex-col gap-4">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span>Model:</span>
        {open ? <span className="rounded bg-slate-100 px-1.5 py-0.5">{ASK_MODELS.find((m) => m.id === open.model)?.label ?? open.model}</span> : <span>{ASK_MODELS.find((m) => m.id === model)?.label}</span>}
      </div>
      {empty && !open && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <ModelPicker value={model} onChange={setModel} disabled={streaming} />
          <h2 className="mt-4 font-semibold">Try asking</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {EXAMPLE_QUESTIONS.map((q) => (
              <li key={q}>
                <button type="button" onClick={() => setDraft(q)} className="w-full rounded bg-slate-100 px-2 py-1.5 text-left hover:bg-slate-200">&ldquo;{q}&rdquo;</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ol className="flex flex-1 flex-col gap-3">
        {messages.map((m) => {
          const toolParts = m.parts.filter(isToolUIPart) as ToolUIPart[];
          const isLive = streaming && m === last;
          const line = m.role === 'assistant' ? statusLineFor(m, isLive) : null;
          return (
            <li key={m.id} className={m.role === 'user' ? 'self-end' : 'self-start'}>
              <article aria-label={m.role === 'user' ? 'You' : 'Ask AI'} className={`max-w-[48rem] rounded-lg px-4 py-3 text-sm ${m.role === 'user' ? 'bg-[#0B1E3A] text-white' : 'border border-slate-200 bg-white'}`}>
                {m.role === 'assistant' && <ToolActivity parts={toolParts} streaming={isLive} />}
                {m.parts.map((p, i) => (p.type === 'text' ? (m.role === 'user' ? <p key={i} className="whitespace-pre-wrap">{p.text}</p> : <AnswerMarkdown key={i} appOrigin={appOrigin}>{p.text}</AnswerMarkdown>) : null))}
                {line && <p className={`mt-1 text-xs ${m.metadata?.status === 'failed' ? 'text-red-700' : 'text-slate-500'}`}>{line}</p>}
              </article>
            </li>
          );
        })}
        {ranOut && <li className="text-sm text-slate-600">{RAN_OUT_MESSAGE}</li>}
        {error && <li role="alert" className="text-sm text-red-700">{describeChatError(error)}</li>}
      </ol>
      <Composer value={draft} onChange={setDraft} onSend={send} onStop={onStop} streaming={streaming} disabled={!canSend || cooldown} disabledReason={cantSendReason} />
    </section>
  );
}

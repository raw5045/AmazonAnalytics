'use client';
import { useState } from 'react';
import { ASK_LIMITS, DEFAULT_MODEL } from '@/lib/ask/models';
import type { MeterData } from '@/lib/ask/meter';
import type { AskUIMessage } from '@/lib/ask/conversations';
import { CHAT_FULL_MESSAGE, NO_BALANCE_MESSAGE } from '@/lib/ask/messages';
import { Meter } from './Meter';
import { Rail, type RailConversation } from './Rail';
import { Thread, type OpenConversation } from './Thread';

export interface AskAiProps {
  conversations: RailConversation[];
  open: (OpenConversation & { messages: AskUIMessage[] }) | null;
  meter: MeterData;
  preview: boolean;
  /** The origin of env.APP_PUBLIC_URL (page.tsx), threaded down to AnswerMarkdown so it can tell an internal keyword link from an external one (Task 9 D9). */
  appOrigin: string;
}

export function AskAi({ conversations, open, meter, preview, appOrigin }: AskAiProps) {
  const atCap = conversations.length >= ASK_LIMITS.maxChats;
  const full = open !== null && open.messageCount >= ASK_LIMITS.maxMessagesPerChat;
  // The chat-cap reason is decided in Thread instead (fix round 2, item 6) — only it knows about a
  // chat id already learned from the stream, which the cap message must defer to (most visibly
  // right after a first-send error, where `open` stays null although the chat now exists).
  const cantSendReason = meter.exhausted ? NO_BALANCE_MESSAGE : full ? CHAT_FULL_MESSAGE : null;
  // The composer's draft lives here, not in Thread (Task 9 fix round, item 8 / M1): a first send
  // moves the URL to ?c=<id>, and Thread — keyed by the open chat's id — remounts when that
  // happens. Owning the draft one level up means whatever the member had queued survives that,
  // and it also means the draft intentionally follows the member from one chat to another.
  const [draft, setDraft] = useState('');
  // Narrow-screen drawer (spec §11.2, fix round item 11): a partial implementation of that section
  // — an in-page expanding panel below `md`, not an overlay; Rail is a fixed column at md+. Plain
  // state, no effects. Closed automatically once a chat is picked (fix round 2, item 5 minor).
  const [railOpen, setRailOpen] = useState(false);
  /**
   * B1 (Task 9 round-2 re-review): Thread must remount only on a busy→idle transition, never
   * idle→busy. Keying it directly by `open.inFlight` (the previous shape) remounted on ANY
   * transition, including idle→busy — and a `router.refresh()` whose server render happens to see
   * THIS VERY TURN's own lock (deleting another chat in the rail mid-stream; the post-Stop delayed
   * refresh landing while the save is still slow) reports `inFlight: true` for the chat that is
   * live right now. Remounting then tears down `useChat`, whose unmount cleanup calls `stop()` —
   * aborting the member's own in-progress answer and replacing it with the wait line.
   *
   * `epoch` only advances on busy→idle, so the key changes only then. This is React's own "adjust
   * state during render" pattern, not an effect: the write happens synchronously in the render
   * body, comparing this render's derived value against the last one, and React re-renders
   * immediately before the browser paints (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
   * — allowed by the hard rules' React Compiler note; there is no setState-in-effect here.
   */
  const busy = !!open?.inFlight;
  const [wasBusy, setWasBusy] = useState(busy);
  const [epoch, setEpoch] = useState(0);
  if (busy !== wasBusy) {
    setWasBusy(busy);
    if (wasBusy) setEpoch((e) => e + 1); // bump only on busy -> idle
  }
  return (
    <div className="mx-auto max-w-6xl px-6 py-6 text-slate-800">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {/* The chip is a sibling, not a child, of the h1: nested text would join the heading's
              accessible name ("Ask AIAdmin preview"), which breaks an exact "Ask AI" name lookup
              and is poor accessibility besides — a badge should not be read as part of the title. */}
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">Ask AI</h1>
            {preview && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">Admin preview</span>}
          </div>
          <p className="mt-1 text-sm text-slate-600">Ask questions about keywords, categories and trends. Same data as the Explorer, answered in plain language.</p>
        </div>
        <Meter meter={meter} />
      </header>
      <button
        type="button"
        onClick={() => setRailOpen((v) => !v)}
        aria-expanded={railOpen}
        aria-controls="ask-ai-rail"
        className="mt-4 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 md:hidden"
      >
        Chats
      </button>
      <div className="mt-4 grid gap-6 md:mt-6 md:grid-cols-[16rem_1fr]">
        <div id="ask-ai-rail" className={`${railOpen ? 'block' : 'hidden'} md:block`}>
          <Rail conversations={conversations} openId={open?.id ?? null} atCap={atCap} onNavigate={() => setRailOpen(false)} />
        </div>
        <Thread
          key={open ? `${open.id}:${epoch}` : 'new'}
          open={open}
          defaultModel={DEFAULT_MODEL}
          cantSendReason={cantSendReason}
          atCap={atCap}
          appOrigin={appOrigin}
          draft={draft}
          onDraftChange={setDraft}
        />
      </div>
    </div>
  );
}

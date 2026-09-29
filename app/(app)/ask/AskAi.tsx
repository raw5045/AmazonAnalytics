'use client';
import { useState } from 'react';
import { ASK_LIMITS, DEFAULT_MODEL } from '@/lib/ask/models';
import type { MeterData } from '@/lib/ask/meter';
import type { AskUIMessage } from '@/lib/ask/conversations';
import { CHAT_CAP_MESSAGE, CHAT_FULL_MESSAGE, NO_BALANCE_MESSAGE } from '@/lib/ask/messages';
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
  const cantSendReason = meter.exhausted ? NO_BALANCE_MESSAGE : full ? CHAT_FULL_MESSAGE : open === null && atCap ? CHAT_CAP_MESSAGE : null;
  // The composer's draft lives here, not in Thread (Task 9 fix round, item 8 / M1): a first send
  // moves the URL to ?c=<id>, and Thread — keyed by the open chat's id — remounts when that
  // happens. Owning the draft one level up means whatever the member had queued survives that.
  const [draft, setDraft] = useState('');
  // Narrow-screen drawer (spec §11.2, fix round item 11): Rail is a fixed column at md+ and a
  // toggled drawer below that. Plain state, no effects.
  const [railOpen, setRailOpen] = useState(false);
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
          <Rail conversations={conversations} openId={open?.id ?? null} atCap={atCap} />
        </div>
        <Thread
          key={open?.id ?? 'new'}
          open={open}
          defaultModel={DEFAULT_MODEL}
          canSend={cantSendReason === null}
          cantSendReason={cantSendReason}
          appOrigin={appOrigin}
          draft={draft}
          onDraftChange={setDraft}
        />
      </div>
    </div>
  );
}

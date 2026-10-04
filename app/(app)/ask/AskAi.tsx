'use client';
import { useEffect, useRef, useState } from 'react';
import { ASK_LIMITS, DEFAULT_MODEL } from '@/lib/ask/models';
import type { MeterData } from '@/lib/ask/meter';
import type { AskUIMessage } from '@/lib/ask/conversations';
import { CHAT_FULL_MESSAGE, NO_BALANCE_MESSAGE } from '@/lib/ask/messages';
import { Meter } from './Meter';
import { Rail, type RailConversation } from './Rail';
import { Thread, type OpenConversation } from './Thread';
import { WriteSwitches, type WriteToggles } from './WriteSwitches';

export interface AskAiProps {
  conversations: RailConversation[];
  open: (OpenConversation & { messages: AskUIMessage[] }) | null;
  meter: MeterData;
  preview: boolean;
  /** The origin of env.APP_PUBLIC_URL (page.tsx), threaded down to AnswerMarkdown so it can tell an internal keyword link from an external one (Task 9 D9). */
  appOrigin: string;
  /** The account's two "always allow" toggles (spec 2026-10-01 §8); null hides the switches: writes off, or no account row yet (page.tsx). */
  writes: WriteToggles | null;
}

/** The same two toggles, or both null: a server render that brings these again changes nothing (spec 2026-10-01 §8). */
function sameWrites(a: WriteToggles | null, b: WriteToggles | null): boolean {
  return a === b || (!!a && !!b && a.autoApproveChanges === b.autoApproveChanges && a.autoApproveDeletes === b.autoApproveDeletes);
}

/**
 * Spec 2026-10-04 §2: the shell. A 260px rail, sticky under the 52px app bar at full height on md+
 * and a drawer over a backdrop below that; a white main column of at least the viewport's height
 * holding the Thread (which pins its own composer band). The window stays the scroll container.
 */
export function AskAi({ conversations, open, meter, preview, appOrigin, writes }: AskAiProps) {
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
  // Below md the rail is a drawer (spec 2026-10-04 §6); on md+ the classes make it a static column
  // whatever this says. Closed by the backdrop, Escape, or picking a chat (onRailNavigate).
  const [railOpen, setRailOpen] = useState(false);
  const chatsButtonRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const closeRail = () => {
    setRailOpen(false);
    chatsButtonRef.current?.focus();
  };
  // Opening moves focus into the drawer; Escape closes it. The effect sets no state itself; the
  // handler does (inline rather than through closeRail, so the effect's only dependency is railOpen).
  useEffect(() => {
    if (!railOpen) return;
    // Focus starts on the drawer's first link (New chat): the Chats button sits under the drawer.
    railRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setRailOpen(false);
      chatsButtonRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [railOpen]);
  /**
   * Spec 2026-10-01 §8: the switches' values. They change here (a switch's save, an "Always
   * approve" on a card) and on the server, and every turn ends in a server render (router.refresh(),
   * or for a first send the router.replace to the new chat) that re-renders this component without
   * remounting it — so a server value that differs from the last one seen is taken, with the same
   * "adjust state during render" pattern as `epoch` below. That covers an "Always approve" whose
   * resume was then refused (the route saves the toggle before the writes; a refusal streams
   * nothing, so onAlwaysApproved never fires), a save whose answer was lost, another tab, the
   * writes flag switched off (null hides the switches) and an admin's first account row (created
   * by that first turn). A server value equal to the last one is ignored, so a refresh that read
   * the row before an in-flight save committed cannot undo the optimistic value.
   */
  const [toggles, setToggles] = useState(writes);
  const [serverWrites, setServerWrites] = useState(writes);
  if (!sameWrites(writes, serverWrites)) {
    setServerWrites(writes);
    setToggles(writes);
  }
  // An "Always approve" answered on a card turns its switch on, with no request of its own: the
  // resend that carried it reached the thread, so the route had already saved it.
  const onAlwaysApproved = (kind: 'changes' | 'deletes') =>
    setToggles((t) => t && { ...t, [kind === 'changes' ? 'autoApproveChanges' : 'autoApproveDeletes']: true });
  /**
   * Whether Thread lands at the chat's end when it mounts (spec 2026-10-04 §4). Two remounts keep
   * the member's place instead: the epoch remount below (the same chat, busy→idle, often seconds
   * into the member's own turn: B1's cases) and a first send's own move to the chat it created (the
   * open-id block after it, which runs later and so wins when both happen in one render).
   */
  const [landAtEnd, setLandAtEnd] = useState(true);
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
    // Bump only on busy -> idle. That remount is the same chat, so the member keeps their place.
    if (wasBusy) {
      setEpoch((e) => e + 1);
      setLandAtEnd(false);
    }
  }
  /**
   * Thread lands at the chat's end when a chat is opened, except on a first send's own move to the
   * chat it just created: Thread reports that id (onFirstSendMove) just before it moves the page,
   * and only the open-id change onto that same id keeps the member's place in the first answer
   * they are reading (spec 2026-10-04 §4). Picking an existing chat from the new-chat screen lands
   * at its end like any other open. The report is used up by the next open-id change, and a rail
   * click clears it (the member chose somewhere else). Adjusted during render, like `epoch`.
   */
  const openIdNow = open?.id ?? null;
  const [keepPlaceFor, setKeepPlaceFor] = useState<string | null>(null);
  const [prevOpenId, setPrevOpenId] = useState(openIdNow);
  if (openIdNow !== prevOpenId) {
    setLandAtEnd(openIdNow === null || openIdNow !== keepPlaceFor);
    setPrevOpenId(openIdNow);
    if (keepPlaceFor !== null) setKeepPlaceFor(null);
  }
  /**
   * Nits round: "New chat" while already on /ask (`open` is already null) does not change the
   * URL — its href is `/ask`, the same page — so without this, the 'new' key never changes and an
   * unsaved chat that already picked up messages (an error, a partial answer from Stop) would
   * stick around instead of resetting. `onNavigate` already fires on that click (it also closes
   * the narrow-screen drawer); bumping this nonce there too, and folding it into the 'new' key,
   * remounts Thread even though the URL didn't. Bumping it on an existing chat's link is harmless
   * — `open` becomes non-null once that navigation lands, and the key no longer reads the nonce.
   */
  const [newNonce, setNewNonce] = useState(0);
  const onRailNavigate = () => {
    setRailOpen(false);
    setNewNonce((n) => n + 1);
    setKeepPlaceFor(null); // a rail click during a first send's move: the member went elsewhere
  };
  const footer = (
    <div className="flex flex-col gap-3">
      {toggles && <WriteSwitches value={toggles} onChange={(update) => setToggles((t) => t && update(t))} />}
      <Meter meter={meter} />
    </div>
  );
  return (
    <div className="flex min-h-[calc(100dvh-52px)] text-slate-800">
      {/* The rail: hidden below md unless open (then a drawer over the backdrop); a static column on md+. */}
      <div id="ask-ai-rail" className={`${railOpen ? 'fixed inset-0 z-40 flex' : 'hidden'} md:static md:z-auto md:flex md:w-[260px] md:flex-none`}>
        {railOpen && <button type="button" aria-label="Close chats" onClick={closeRail} className="absolute inset-0 bg-slate-900/40 md:hidden" />}
        <div ref={railRef} className="relative flex h-dvh w-[260px] flex-none flex-col border-r border-slate-200 bg-[#F4F6FA] md:sticky md:top-[52px] md:h-[calc(100dvh-52px)]">
          <Rail conversations={conversations} openId={open?.id ?? null} atCap={atCap} onNavigate={onRailNavigate} preview={preview} footer={footer} />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col bg-white">
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2 md:hidden">
          <button
            ref={chatsButtonRef}
            type="button"
            onClick={() => setRailOpen((v) => !v)}
            aria-expanded={railOpen}
            aria-controls="ask-ai-rail"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700"
          >
            Chats
          </button>
          <span className="text-sm font-semibold">Ask AI</span>
        </div>
        <Thread
          key={open ? `${open.id}:${epoch}` : `new:${newNonce}`}
          open={open}
          defaultModel={DEFAULT_MODEL}
          cantSendReason={cantSendReason}
          atCap={atCap}
          appOrigin={appOrigin}
          draft={draft}
          onDraftChange={setDraft}
          onAlwaysApproved={onAlwaysApproved}
          landAtEnd={landAtEnd}
          onFirstSendMove={setKeepPlaceFor}
          // The server's current value, not the local toggles: writes switched off make a waiting card read-only.
          writesEnabled={writes !== null}
        />
      </div>
    </div>
  );
}

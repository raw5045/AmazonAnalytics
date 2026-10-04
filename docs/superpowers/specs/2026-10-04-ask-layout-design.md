# Ask AI page layout (arc 5) — design

**Date:** 2026-10-04. **Status:** approved by the owner from a static mock (the mock is not committed; its two states are described in §3 and §4).
**Scope:** the `/ask` page only — `app/(app)/ask/{AskAi,Rail,Thread,Composer,ModelPicker,Meter,WriteSwitches}.tsx` and their tests. No server, route, API, data or prompt change. The app bar, the Tutorials banner and every other page stay as they are.

## 1. Goal

Make the Ask AI page read like a chat product rather than a form: the chat list flush against the left edge of the window at full height, the conversation in a centered column with answers as plain text, the composer always in reach at the bottom, and the page's settings (the two approval switches, the usage meter) out of the way in the rail's footer. Same colours as the rest of the app: navy `#0B1E3A` (hover `#13294f`), canvas `#F4F6FA`, sky accents, amber for the approval cards.

The owner's words (2026-10-04): "format the entire section to look more like Claude's chat interface … with the lefthand menus far more left than on our screen". Reference: claude.ai's left sidebar + centered thread + bottom composer.

## 2. Shell

```
┌ app bar (52px, unchanged) ───────────────────────────────────────────────┐
│ Tutorials banner (unchanged, only until dismissed)                        │
├──────────────┬────────────────────────────────────────────────────────────┤
│ Rail 260px   │ main column (white, min-height = viewport − 52px)          │
│ canvas tint  │   ┌──────── centered column, max 48rem ────────┐           │
│ sticky,      │   │ messages …                                 │           │
│ own scroll   │   │                                            │           │
│              │   └────────────────────────────────────────────┘           │
│ footer:      │   composer band, sticky at the viewport bottom             │
│ Approvals,   │                                                            │
│ Usage        │                                                            │
└──────────────┴────────────────────────────────────────────────────────────┘
```

- The WINDOW stays the scroll container (no inner scrolling thread). The rail is `position: sticky; top: 52px; height: calc(100dvh − 52px)` with its own `overflow-y: auto`; the composer band is `position: sticky; bottom: 0`. This keeps the maths right whether or not the Tutorials banner is showing, and keeps browser find-in-page, text selection and the back button behaving as on any page.
- The page no longer has an outer `max-w-6xl` container, a page title block, a subtitle, or a "Model:" line above the thread. The h1 "Ask AI" and the "Admin preview" chip move into the rail header (document title unchanged).
- `AskAi` keeps every piece of state it has today (draft, rail open/closed, switches with the server re-seed, the busy→idle epoch key, the New-chat nonce). `page.tsx` and the props it passes are unchanged.

## 3. Rail

Top to bottom, inside a 260px column (`bg-[#F4F6FA]`, right border `slate-200`):

1. **Header:** h1 "Ask AI" (15px bold) and, when `preview`, the "Admin preview" chip (unchanged text and colours).
2. **New chat:** full-width navy button (the existing `Link` with the same cap behaviour and `CHAT_CAP_MESSAGE` under it when at five).
3. **Chats, grouped by recency:** "Today", "Yesterday", "Previous 7 days", "Older" — small uppercase slate labels; a group is shown only when it has chats. Grouping uses the member's local date and is applied only after hydration (`useSyncExternalStore` with a `null` server snapshot, as `TabNav` does for localStorage): the server render and the hydrating render show one unlabelled list, the first client render regroups it. Order inside a group is unchanged (newest first, as the server lists them). The pure grouping function lives in `railGroups.ts` and is unit-tested on its own.
   Each row is unchanged in substance: the title link (truncated, the open chat outlined in `sky-300` on white), a second line with the model tag and the date, the "Delete" control with its one-step confirm ("Delete this chat? It cannot be undone." → Delete / Cancel, autofocus on the confirm button). Only the styling gets lighter (the Delete control in slate-400, darker on hover and focus).
4. **Footer** (pinned to the rail's bottom, top border): the `Approvals` switches and the usage meter, passed in by `AskAi` as the rail's `footer`:
   - `WriteSwitches`: same two labelled checkboxes ("Changes: always allow", "Deletes: always allow"), drawn as toggle switches (the native checkbox stays in the DOM for assistive tech and tests, visually replaced by a track and knob via `peer-checked`). The two notes stay as each switch's accessible description but are no longer printed in full; one visible 11px line under the pair reads "Off, Ask AI asks in a card first. Deletes are permanent." The save behaviour (optimistic flip, one PATCH at a time, revert and the live error line) is unchanged. Absent when `writes` is null (writes off, or no account row yet), as today.
   - `Meter`: a compact row — "Usage" label, a short bar (`w-20`), then the same text as today (admin line, exhausted line, "about N questions left[, including credit]").

Below `md` the rail is a drawer (§6).

## 4. Main column

- **Centered column:** `mx-auto max-w-[48rem] px-6`, messages in a vertical list with 20px gaps. Text at 15px with relaxed line height for both roles (readability was part of the ask).
- **Member messages:** right-aligned navy bubbles (`rounded-2xl rounded-br-md`, `max-w-[36rem]`, `whitespace-pre-wrap`), as today but without the card look.
- **Answers:** plain text on the white column, no border, no card background. Above the answer, the existing "Used N tools" disclosure (`ToolActivity`, unchanged). Approval cards (`ApprovalCard`, unchanged component) render inside the answer where they do today; their footnote changes from "You can turn this off in the chat's settings." to "You can turn this off under Approvals in the side panel." Status lines (Stopped, cut off, failed, ran out, busy, no answer) are unchanged in text and position.
- **Empty state (new chat, nothing sent yet):** centered in the column's free height — heading "What do you want to find?", the line "Same data as the Explorer, answered in plain language.", then the eight example questions (`EXAMPLE_QUESTIONS`) as a two-column grid of rounded, left-aligned buttons on the canvas tint; a click still fills the draft. The radio-button model picker that lived in this box is gone (§5).
- **Composer band:** sticky at the viewport bottom, white with a top hairline, holding the composer centered at the same 48rem. Inside: the box (`rounded-2xl`, `border-slate-300`, soft shadow, sky border while focused) with the textarea (2 rows, grows with its content up to 240px, no manual resize handle) and a bottom row — the model control on the left (§5), on the right the "N left" counter (from 3,500 characters, as today) and Send or Stop. Under the box, centered, the accuracy notice in 11px. The disabled reason (no balance, chat full, five chats) shows above the box in amber, `role="status"`, as today. Enter sends, Shift+Enter breaks the line, IME composition is respected — unchanged.
- **Scrolling:** sending a question scrolls that question to the top of the view (a scroll margin keeps it clear of the app bar), so the answer streams into view under it; opening an existing chat lands on its last message. Both use `scrollIntoView` and are skipped where it does not exist (jsdom).

## 5. Model control

- **New chat:** a compact `<select>` in the composer's bottom row, labelled "Model" for assistive tech, options "Standard (Sonnet 5)", "Advanced (Opus 5.5), uses about twice the usage", "Quick (Haiku 4.5), uses about half" (labels and notes from `ASK_MODELS`). Disabled while streaming and once the chat has a message (the first send fixes the model). The old sentence "The model stays fixed for this chat. Start a new chat to use another one." becomes the select's accessible description.
- **Open chat:** a read-only chip in the same place: "Advanced (Opus 5.5) · fixed for this chat".
- `ModelPicker` is reduced to the select; the choice still lives in `Thread`'s state and goes out with the first send as today (`body.model`).

## 6. Narrow screens (below `md`, 768px)

- The rail is hidden; the main column gets a slim top row with a "Chats" button (`aria-expanded`, `aria-controls="ask-ai-rail"`, as today).
- Open, the rail is an overlay drawer: fixed, full height, 260px from the left edge, same content including the footer, over a dimmed backdrop. It closes on the backdrop, on Escape, and when a chat or New chat is picked (the existing `onNavigate`). Today's in-page expanding panel goes away.
- The composer band is sticky at the bottom there too; the thread column uses 16px side padding.

## 7. Unchanged behaviour (checked by the existing tests, which are kept)

The draft surviving the first-send remount; the Thread key (`id:epoch` / `new:nonce`); Stop and its cooldown; the busy-poll while another tab's turn is in flight; first-send error recovery and the "Open this chat" link; approval cards' full life cycle (answer, resend, superseded, 404/400 recovery, keyboard focus move, read-only when writes are off); `useWorkspaceNames`; the switches' PATCH flow and the server re-seed; the rail's delete flow (409 body, 404 as success, replace vs refresh); the chat cap; the hidden `[approval-result]` messages never rendered; links opening in a new tab.

## 8. Accessibility

One h1 per page (in the rail header). The drawer's backdrop is a button named "Close chats"; Escape closes it; focus returns to the "Chats" button when it closes. The select is labelled; the switches keep their checkbox semantics and descriptions; the example buttons keep their text as their name; the composer keeps `aria-label="Your question"`; the sticky composer never covers the last message (the column reserves its height because the band is in normal flow).

## 9. Testing

- Unit (vitest + RTL): `railGroups` (date buckets, including the before-hydration single group); `Rail` (header, grouped render with a pinned clock, footer slot, unchanged delete and cap tests); `WriteSwitches` and `Meter` (unchanged behaviour tests pass against the new markup); `ModelPicker` (select, options, disabled, description); `Composer` (model slot, auto-grow sets a height when the box has a scroll height, unchanged send/stop/IME tests); `Thread` (no "Model:" line, the select present only on a new chat and disabled once a message exists, the empty-state block, scroll calls guarded); `AskAi` (drawer contract: hidden/open, Escape, backdrop, closes on navigate; the rail footer holds the switches and meter; the existing switch and remount tests); `page.test.tsx` unchanged.
- Visual smoke after deploy, in the owner's Chrome on production: desktop at ~1440 and ~1100 wide, a phone, the Tutorials banner shown and dismissed, a long chat with tables, an approval card, Stop mid-answer, the drawer on a phone.

## 10. Not in this arc (follow-ups)

Collapsing the rail on desktop; a "jump to latest" button; per-message copy buttons; chat renaming or search; dark mode; moving the rest of the app to a sidebar.

## 11. Ship order

Plan `docs/superpowers/plans/2026-10-04-ask-layout.md`, executed with the subagent loop (implementer → spec review → code-quality review → nits; final whole-diff review). Local commits on `main`; the push is owner-gated (`scripts/checkActiveJobs.ts` first, then a bare `git push origin main`), then the visual smoke above.

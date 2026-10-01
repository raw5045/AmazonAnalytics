# Ask AI write access (arc 4) — design

**Date:** 2026-10-01. **Owner decisions:** in chat, this day (see §1). **Status:** approved in sections; written for the owner's read before the plan.

## 1. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | What the chat can write | The same eleven workspace tools the external MCP has (arc 3): list/create/update/delete saved views, list/create/update/delete custom categories, list/add/remove watchlist. Same commands, caps, links, notes and logging. |
| 2 | How often the chat asks | Once per chat for changes (create, update, add, remove): the first change shows a card; **Approve** allows changes for the rest of that chat. **Deletes always ask**, one card per delete. A new chat asks again. |
| 3 | Never-ask option | Two account toggles, both off by default: "Changes: always allow" and "Deletes: always allow". Each silences its own cards. |
| 4 | The card's buttons | **Deny**, **Approve**, **Always approve** — as a Claude chat offers. "Always approve" sets the matching toggle; the toggles are the "always" answers remembered, with switches in the chat to turn them off again. |
| 5 | Mechanism | The AI SDK's built-in tool approval (`needsApproval`): the turn pauses with a card, the member answers, the tool runs on the server under the member's account, the model carries on. Not a custom proposal flow, not hand-off buttons. |
| 6 | Audience | Admin-only, like the rest of Ask AI, until the owner has tested it; member access later arrives through the paid (Stripe) arc. Behind its own kill switch. |
| 7 | Not in v1 | A per-turn model switch (today the model is fixed per chat by design), the chat's layout pass, Haiku's cost figure, per-tool "always" (only per kind), mobile card layout beyond what the thread already does. Recorded in §12. |

## 2. Gating

- `ASK_AI_WRITES_ENABLED` (Vercel env, `z.string().optional()` in `lib/env.ts`; `askAiWritesEnabled()` in `lib/ask/config.ts` returns `=== '1'`). Independent of `MCP_WRITE_ENABLED`: the owner can switch either surface off without touching the other. Both flags reach a deployment only on its next deploy.
- Off: the chat registers the five research tools only (today's behaviour, byte for byte); no workspace rules in the prompt; the approval route answers 404; the two switches are not rendered.
- On: the eleven workspace tools are registered for every chat turn of every account the chat admits (today: admins). The approval cards, the switches and the resume path are live.
- Ask AI itself stays `ASK_AI_ENABLED`-gated and admin-only as before; nothing here changes who can open the page.

## 3. Tools in the chat

- `lib/ask/tools.ts` `buildAskTools(research, actor, limits)` becomes `buildAskTools({ research, workspace, actor, limits, writes })` where `writes` is `null` (flag off) or `{ allowChanges: boolean; allowDeletes: boolean }` computed per turn (§6). The research tools are built exactly as today. With `writes` set, every `WORKSPACE_TOOLS` definition is added the same way (`description(limits)`, `inputSchema`, `execute` = `def.run(workspaceService, actor, args)` with the same `{ error }` result on a `ResearchError` and `classifyToolError` otherwise), plus `needsApproval`:
  - list tools (`requiresConfirmation: false`): never.
  - deletes (`delete_saved_view`, `delete_custom_category`): `!writes.allowDeletes`.
  - every other write (`create_*`, `update_*`, `add_to_watchlist`, `remove_from_watchlist` — removal is not permanent): `!writes.allowChanges`.
  The two name sets are one exported constant in `lib/ask/tools.ts` (`DELETE_TOOLS`), with a test that every workspace tool is either a list, a delete or a change and nothing is left unclassified.
- The actor is `{ localUserId, clerkUserId, clientId: 'ask-ai', channel: 'chat' }` as today; the workspace service records usage and bumps `mcp_write` exactly as for the MCP, so the 200-a-day cap is shared across both surfaces and the digest's MCP-writes column counts chat writes too (rename the column later if that proves confusing — §12).
- Cost: eleven more tool definitions ride on every chat turn while the flag is on. Measured after the first smoke (§11); if a question costs materially more than today's ≈3.6¢ on Sonnet 5, the lever is to compact the descriptions, not to drop tools.

## 4. Prompt and guide

- The chat route builds the guide with `workspace: true` when the flag is on (`buildGuide({ …, workspace: askAiWritesEnabled() })` — the research service's own `guide()` keeps its MCP-only rule; the route calls `buildGuide` directly already). The guide's `workspace.rules` (arc 3 §9.1, nine lines) therefore reach the prompt through the JSON the prompt already embeds.
- `buildSystemPrompt(guide)` adds, only when `guide.workspace` is present, a short block after the existing rules:
  - "You can save views, build custom categories and change the watchlist with the workspace tools; follow the workspace rules in the guide."
  - "Before a write the person may be asked to approve it in a card. If they deny it, say so briefly and continue without it; never retry a denied action or try another way to get the same result."
  - "Confirm the exact name with the person before any delete."
  - "After a write, say what was saved or changed and give its Explorer link."
- The server instructions sentence used by the MCP ("clients normally ask the person…") is not reused: here the chat itself asks.

## 5. The approval card

- Rendered in the thread by the assistant message whose tool part is in the SDK's `approval-requested` state; one card per pending call, in order. Not inside the "Used N tools" disclosure — a card is a question to the person, not activity.
- Content: a one-line plain-English summary from the tool's own input, by a per-tool `summarize(input)` in a new `lib/ask/approvalSummaries.ts` (pure, tested, no fetches): "Save a view named ‘Lamps under 500 reviews’" / "Rename the view ‘…’ to ‘…’" / "Replace the filters of the view ‘…’" (an update or delete call carries only an id: the card looks the name up from the member's own lists through the existing GET routes for saved views and custom categories, shows “view …” with the id's last 8 characters until the name arrives, and falls back to that if the lookup fails) / "Create the category ‘Lighting’ from 2 selections" / "Change the category ‘…’: add 3 selections" (the leafMode in words) / "Delete the view ‘…’ — permanent" / "Delete the category ‘…’ — permanent; views that filter on it lose that filter" / "Add 20 keywords to the watchlist: desk lamp, floor lamp, … (+17)" / "Remove 3 keywords from the watchlist: …". Unknown or oversized input never breaks the card: the fallback is the tool's title.
- Buttons: **Deny**, **Approve**, **Always approve**. Always approve answers the current card as approved AND sets the matching toggle in the same request. Labels adapt to the kind: for a change card, Approve reads "Approve for this chat"; for a delete card, "Approve this delete". Always approve reads "Always approve changes" / "Always approve deletes", with a one-line note "You can turn this off in the chat's settings".
- Answered, the card collapses to a one-line record with the summary and "Approved for this chat" / "Approved" / "Always approved" / "Denied", so a reloaded chat shows what happened; the tool's result then appears in the normal tool-activity strip and the model's text follows.
- A pending card is interactive only on the last assistant message of the open chat; older ones are records. While the chat is busy (a turn streaming, or the lock held) the buttons are disabled.

## 6. Flow

**Deciding whether to ask (server, per turn).** When a turn starts, the route loads the account's two toggles and the chat's `changes_approved_at` stamp (both from the rows it already reads) and computes `writes = { allowChanges: toggleChanges || stamp !== null, allowDeletes: toggleDeletes }`. The SDK calls `needsApproval` per tool call; a call that needs none executes at once, as a research tool does. A call that needs approval ends the turn: the assistant message is stored with the tool part in `approval-requested` state (status `complete`, `finishReason` as the SDK reports it), the lock is released, the turn is settled and logged like any other. No stream stays open while the card waits.

**Answering (client → server).** The card's button calls the SDK's `addToolApprovalResponse({ id: approvalId, approved })` on the chat state and then resends through the existing transport, which carries only: `{ conversationId, approval: { approvalId, approved, remember } }` with `remember ∈ { null, 'chat', 'always' }` (`'chat'` only for a change card's Approve; `'always'` for Always approve on either kind). No message text, no tool arguments, no history: the browser's copy is never trusted (arc-2 §13).

**Resuming (server).** The chat route accepts this second body shape (a `z.strictObject` union with today's message shape). Order: kill switches (Ask AI and writes) → same-origin → session → body → gates (the same daily guard, balance and ceiling checks as a send: an approval resume is a model call and is billed like one) → lock the chat → load it → verify: the chat's last message is an assistant message that carries a tool part with this `approvalId` still in `approval-requested` state; anything else (unknown id, already answered, a newer message after it, another member's chat) → bodyless 404 after releasing the lock — never a hint about which. Then: write the response into that stored message's parts (`approval-responded`, `approved`); apply `remember` (`'chat'` → stamp `changes_approved_at = now()` on the chat; `'always'` → set the matching account toggle); and run the turn with no new user message — the history ends with that assistant message, which is what the SDK needs to execute the approved call (or feed an `execution-denied` result) before the model continues. `runTurn` gains an optional `newMessage` for this. The resumed output is stored as a new assistant message. A resume does not count as a new question (no `ask_question` bump, `questions` unchanged) but its tokens settle to the ledger and the month's ceiling as usual.

**A new message while a card is pending.** The route's send path resolves every pending approval on the chat's last assistant message as denied (written into the stored parts) before appending the new user message, so the stored history is always complete and the model is told. The client does the same to its local copy so the record reads "Denied".

**Stop.** Nothing runs while a card waits, so there is nothing to stop; Stop during the resumed turn behaves exactly as today (`stopReason: 'user'`, the partial answer stored as `stopped`).

**Reload.** The stored parts carry the request and, once answered, the response; `storedToUiMessage` passes them through, so a reloaded chat shows a live card (if still pending and on the last message) or the record.

## 7. Storage (migration 0049, hand-numbered, owner-gated like 0048)

```sql
ALTER TABLE ask_accounts
  ADD COLUMN IF NOT EXISTS auto_approve_changes boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_approve_deletes boolean NOT NULL DEFAULT false;
ALTER TABLE ask_conversations
  ADD COLUMN IF NOT EXISTS changes_approved_at timestamptz;
```

- `ask_accounts` rows exist for every account that has used the chat (the admin has one); the toggles are read with the account on each turn and written by the switches and by "Always approve".
- `changes_approved_at` is per chat, never cleared by the app (a chat that was approved stays approved; a new chat starts clean). Deleting the chat removes it.
- The approval request/response live inside the stored assistant message's `parts` jsonb, in the SDK's own part shape, so no new table and no second source of truth. `ask_messages.status` is unchanged.
- No new index: both columns are read by primary key.

## 8. The switches

- Two switches in the chat page's settings strip (next to the model picker; exact placement is the layout pass's call, but they must be visible without opening a menu): "Changes: always allow" and "Deletes: always allow", each with a one-line note ("Ask AI will not ask before saving or changing things" / "…before deleting things — deletes are permanent").
- `PATCH /api/ask/account` with `{ autoApproveChanges?: boolean; autoApproveDeletes?: boolean }` (same-origin, session, kill switches, `z.strictObject`), updating only the fields sent; answers the account's current values. Lives beside the existing account/meter route if there is one, else as a small new route.
- "Always approve" on a card sets the toggle through the resume path (§6), not through this route, so one request does both.
- The admin page (`/admin/ask-ai`) shows nothing new in v1.

## 9. Errors

| Situation | What happens |
|---|---|
| A write fails for a normal reason (cap, duplicate name, not found, invalid filters, category unavailable) | The same `{ error: { code, message, retryable } }` tool result the MCP returns; the model explains or asks for a different name (guide rules). |
| Deny | The SDK's `execution-denied` result; the prompt tells the model to say so and continue; the record reads "Denied". |
| Unexpected failure inside a workspace tool | The workspace service already rethrows a clean `ResearchError` (`DATA_UNAVAILABLE`/pool busy); the chat shows it as a tool result like any other error. Never a raw message. |
| Approval for an unknown, answered or foreign request | Bodyless 404 (`"This chat is no longer available. Reload the page."` on the client, as for a deleted chat). |
| Flag off while a card is pending | The resume route answers 404; the client shows the chat-gone line; the stored request stays `approval-requested` and is resolved as denied by the next send. |
| Daily cap reached by a chat write | `LIMIT_REACHED`-style `RATE_LIMITED` result with the "Daily limit of 200 saves" sentence; the model relays it. |
| Chat full / busy / balance / ceiling on a resume | Exactly the send-path answers (409 / 409 / 402 / 503) with the existing messages. |

Logging: the workspace service's `[workspace]` line per call (tool, outcome, code, userId, durationMs — channel `chat` through the actor) is unchanged; the `[ask turn]` line gains `approvals: { requested, approved, denied }` for the turn and `resume: true` on a resumed turn. Never a name, keyword or path.

## 10. Security

- The actor comes from the Clerk session only; every workspace command is owner-scoped (arc 3). The approval request/response shape from the browser carries ids and booleans only; the tool's arguments are the ones the server stored when the model called it.
- An approval is accepted only for the last assistant message of a chat the member owns, only while that request is unanswered, only under the chat's lock — a replay or a double click answers 404 and runs nothing.
- `remember: 'always'` from the browser can set a toggle, but only as part of a legitimate approval of a card this member is looking at; the switches route needs the same session and origin checks.
- Tool outputs stay untrusted data (arc-2 §13); the model cannot approve on the person's behalf — approval is a server-verified member action, never a tool call.

## 11. Testing

- **Tool wiring** (`lib/ask/tools.test.ts`): flag off → the five research tools only (today's parity test stays); flag on → sixteen tools; `needsApproval` is false for lists, `!allowDeletes` for the two deletes, `!allowChanges` for the other six writes (table-driven over `WORKSPACE_TOOLS`); every workspace tool is classified; a `ResearchError` from a write becomes `{ error }`.
- **Summaries** (`lib/ask/approvalSummaries.test.ts`): one case per tool incl. the keyword list truncation, the leafMode words, the "permanent" suffixes, the fallback on malformed input.
- **Resume path** (`app/api/ask/chat/route.test.ts`): accepts a valid approval and resumes without appending a user message; 404 for an unknown id, an already-answered id, a request that is not on the last message, another member's chat; `remember: 'chat'` stamps the chat and `'always'` sets the right toggle (and nothing else); a Deny writes the denied response; the gates (daily guard, balance, ceiling, busy, full) answer as on a send; a new send with a pending card resolves it as denied first.
- **Turn** (`lib/ask/turn.test.ts`): a resume runs with no new user message and the history's last assistant message; the `[ask turn]` line carries `approvals` and `resume`.
- **Prompt** (`lib/ask/prompt.test.ts`): the writes block appears only with `guide.workspace`.
- **Card** (`app/(app)/ask/ApprovalCard.test.tsx`): the three buttons with kind-specific labels; the summary; collapsed records for each answer; disabled while busy; no card for a non-last message.
- **Switches**: the route's validation and partial update; the component reflects and updates the values.
- **Integration (owner-gated, after 0049)**: the two toggles and the stamp round-trip on real rows; a resumed turn's ledger row.
- **Smoke (owner, admin):** approve a save (card → view in the Explorer dropdown), deny a delete, "Always approve" changes then a second write with no card, turn it off in the switch and see the card return, "Always approve" a delete, reload mid-card and answer it, send a new message with a card pending (record reads Denied), a wide search → the custom-category route from the chat, and the cost per question read from the ledger against today's 3.6¢ (Sonnet 5) and 3.95¢ (Opus 5.5).

## 12. Follow-ups (not this arc)

- Per-turn model switch (the chat keeps its first-send model by design).
- The chat's layout and usability pass (the owner finds the external MCP smoother); the card's mobile layout rides with it.
- Haiku 4.5 cost per question.
- Per-tool "always allow" (v1 is per kind: changes vs deletes).
- Rename the digest's "MCP writes" column once chat writes share it.
- An "Undo" for a just-approved change (a delete has none; the model can recreate from the record).

## 13. Ship

Same discipline as arcs 2–3: local commits on `main`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, no push without the owner's go, `scripts/checkActiveJobs.ts` first, a bare `git push origin main`. Owner steps: confirm 0049 (apply script gated by `APPLY_0049=yes`), set `ASK_AI_WRITES_ENABLED=1` in Vercel Production (reaches the next deployment), run the smoke in §11, then decide when members get the chat at all (paid arc).

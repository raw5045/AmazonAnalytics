/**
 * POST /api/ask/chat — one Ask AI turn (spec §3, §6–§9, §12–§13), including the resume after the
 * member answered approval cards (arc 4: spec 2026-10-01 §6, §9, §10, as amended in its plan).
 * Two bodies, told apart by an `approvals` key:
 * - a send: { conversationId: uuid | null, model?: AskModelId (first send only), message: { text } };
 *   a text that starts with APPROVAL_RESULT_PREFIX is refused (400, judged after the trim), so only
 *   the server writes the hidden outcome channel (lib/ask/approvalResult.ts);
 * - an approval answer: { conversationId: uuid, approvals: [{ approvalId, approved, remember }] },
 *   one answer per card still open on the chat's last assistant message, all at once (prepareResume).
 * Order: kill switch → same-origin → session → body (an approval body also needs the writes switch:
 * off → bodyless 404 before the gates) → gates (a resume skips only the daily question guard) → API
 * key → the request lifetime (below) → conversation: create on a first send (already locked), or
 * lock + load, then a send resolves any open card (stored as denied, reported to the model as
 * superseded) and appends the member's message (prepareFollowUp), and a resume saves `remember`
 * (fail-closed, before any write), runs the approved writes, and records the answers together with
 * the hidden outcome message in one statement (prepareResume) → turn setup AND the turn itself (a
 * throw from `runTurn` before it starts streaming, e.g. convertToModelMessages or its resume guard,
 * answers 503 like any setup failure; see the Task 6 re-review amendment under ### Task 8 in
 * docs/superpowers/plans/2026-09-28-ask-ai.md; on a resume whose answers were already stored, that
 * 503 says `answered: true`, so the thread keeps the cards' records) → stream. Settlement runs in
 * the turn's onEnd BEFORE the answer is saved (money first); a resume settles as a billed turn that
 * is not a question (settleTurn's countQuestion: false).
 *
 * Lifetime (Task 8 review, I3; registered before any lock since the arc-4 Task 6 review):
 * `vercel.json` sets `supportsCancellation` for this route, so a client disconnect (Stop, leaving for
 * the Explorer right after Approve, a closed tab) ends the invocation except for `after()` /
 * `waitUntil` work. `after(() => turnFinished)` is therefore the first statement of the try that
 * opens right after the API-key check, before a chat is created or locked: everything that runs with
 * the lock held — a resume's writes and records included — and the turn's own onEnd (settle, save,
 * unlock) live inside the registered lifetime. `turnFinished` resolves on every exit: onEnd's own
 * `finally` once a stream started, and this function's `finally` for every exit that never streams
 * (a refusal, an early response, the catch), so a refusal never pins the function for `maxDuration`.
 *
 * The turn lock: held from a create or a successful acquire (`held`) until the turn's onEnd releases
 * it. An early response after that releases it first (`released`); a throw reaches the catch, which
 * releases `held`; a refusal before the acquire (gates, key, busy, missing) has none to release. The
 * turn deadline is shortened by the time the request already spent, so a deadline abort still leaves
 * onEnd SETTLE_MARGIN_MS before `maxDuration`.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { createAnthropic } from '@ai-sdk/anthropic';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/AuthError';
import { bumpUserActivity } from '@/lib/activity/bump';
import { mcpAudience } from '@/lib/mcp/config';
import { buildGuide } from '@/lib/research/catalog';
import { researchLimits } from '@/lib/research/limits';
import { defaultResearchService, type ResearchActor } from '@/lib/research/service';
import { loadSnapshotMetaHttp } from '@/lib/research/snapshot';
import { defaultWorkspaceService } from '@/lib/workspace/service';
import { ASK_LIMITS, ASK_MODELS, DEFAULT_MODEL, anthropicApiKey, askAiEnabled, askAiWritesEnabled, type AskModelId } from '@/lib/ask/config';
import { runGates } from '@/lib/ask/gates';
import { isSameOrigin } from '@/lib/ask/sameOrigin';
import { buildSystemPrompt } from '@/lib/ask/prompt';
import { buildAskTools, runWorkspaceTool, toolApprovalFor, type WriteSettings } from '@/lib/ask/tools';
import { writeKind } from '@/lib/ask/writeKinds';
import { APPROVAL_RESULT_PREFIX, approvalOutcomeMessage, pendingApprovals, respondedParts, unreplayedResults, type ApprovalOutcome } from '@/lib/ask/approvals';
import { runTurn, windowHistory, TURN_DEADLINE } from '@/lib/ask/turn';
import { costMicro } from '@/lib/ask/pricing';
import { setAutoApprove, settleTurn, type AskAccount } from '@/lib/ask/ledger';
import { maybeAlertCeiling } from '@/lib/ask/alerts';
import { errFields } from '@/lib/ask/logSafe';
import {
  BAD_REQUEST_MESSAGE, BUSY_MESSAGE, CHAT_CAP_MESSAGE, CHAT_FULL_MESSAGE, CROSS_SITE_MESSAGE, FAILED_MESSAGE, NOT_CONFIGURED_MESSAGE, TOO_LARGE_MESSAGE, TOO_LONG_MESSAGE,
} from '@/lib/ask/messages';
import {
  acquireTurnLock, appendAssistantMessage, appendUserMessage, createConversationWithFirstMessage, loadConversation, recordAnswersAndAppend, releaseTurnLock, stampChangesApproved,
  type AskConversation, type AskUIMessage, type RecordAndAppendResult,
} from '@/lib/ask/conversations';

export const runtime = 'nodejs';
export const maxDuration = 300;
/** What onEnd needs after a deadline abort to settle, save and unlock before maxDuration ends the invocation. */
const SETTLE_MARGIN_MS = 20_000;

const MAX_BODY_BYTES = 64 * 1024;
const MODEL_IDS = ASK_MODELS.map((m) => m.id) as [AskModelId, ...AskModelId[]];
const bodySchema = z.strictObject({
  conversationId: z.uuid().nullable(),
  model: z.enum(MODEL_IDS).optional(),
  message: z.strictObject({
    // Strip NULs and repair lone surrogates before length/emptiness are judged: both pass
    // .trim().min(1) unchanged but Postgres rejects them, which used to reach the DB as an
    // uncaught throw (Task 8 review, I1). A NUL-only message becomes empty here -> 400 below.
    text: z.preprocess(
      (v) => (typeof v === 'string' ? v.replaceAll('\u0000', '').toWellFormed() : v),
      // The refine (spec 2026-10-01 §10) judges the trimmed text, i.e. exactly what would be stored:
      // a member's message never passes for the server's hidden outcome channel.
      z.string().trim().min(1).max(ASK_LIMITS.maxMessageChars).refine((t) => !t.startsWith(APPROVAL_RESULT_PREFIX)),
    ),
  }),
});

/**
 * The most answers one approval body may carry: twice the per-answer tool-call budget the prompt
 * sets. Open cards only ever belong to one step's calls; a step with more than this (a model
 * ignoring the budget) cannot be answered at once, and the member's next message resolves those
 * cards as denied.
 */
const MAX_APPROVALS_PER_TURN = 2 * ASK_LIMITS.maxToolCallsPerTurn;
/** `remember` only with an approval: 'chat' allows changes for the rest of this chat, 'always' sets the account toggle for the card's kind. */
const approvalAnswerSchema = z
  .strictObject({ approvalId: z.string().min(1).max(128), approved: z.boolean(), remember: z.enum(['chat', 'always']).nullable() })
  .refine((a) => a.approved || a.remember === null, { message: 'remember needs an approval' });
/** One answer per pending card on the last assistant message — the thread sends them all at once (the model can pause several calls in one step). */
const approvalBodySchema = z
  .strictObject({ conversationId: z.uuid(), approvals: z.array(approvalAnswerSchema).min(1).max(MAX_APPROVALS_PER_TURN) })
  .refine((b) => new Set(b.approvals.map((a) => a.approvalId)).size === b.approvals.length, { message: 'duplicate approval' });
type ApprovalAnswer = z.infer<typeof approvalAnswerSchema>;

const NO_STORE = { 'cache-control': 'no-store' };
function json(body: unknown, status: number, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });
}
/** Bodyless: never a hint whether the feature, the chat or the card is what is missing. (A response, unlike next/navigation's throwing notFound().) */
const notFoundResponse = (): NextResponse => new NextResponse(null, { status: 404, headers: NO_STORE });
const badRequest = (): NextResponse => json({ error: BAD_REQUEST_MESSAGE, code: 'bad_request' }, 400);
const chatFull = (): NextResponse => json({ error: CHAT_FULL_MESSAGE, code: 'chat_full' }, 409);
const setupFailed = (extra: Record<string, string | boolean> = {}): NextResponse => json({ error: FAILED_MESSAGE, code: 'setup_failed', ...extra }, 503);
let warnedNoKey = false;

/** Every early response between a successful lock acquire and the turn's start goes through here, the lock released first (best effort — a failed release never replaces the answer). A throw is released by POST's catch instead. */
async function released(conversationId: string, response: NextResponse): Promise<NextResponse> {
  await releaseTurnLock(conversationId).catch(() => {});
  return response;
}

/**
 * Spec 2026-10-01 §6: which writes may run without a card on this turn; null when writes are off
 * (no workspace tools at all). Changes: the account's toggle or the chat's stamp; deletes: the
 * toggle only. `conversation` is null on a first send (no chat to have been stamped yet).
 */
function writesFor(account: Pick<AskAccount, 'autoApproveChanges' | 'autoApproveDeletes'>, conversation: Pick<AskConversation, 'changesApprovedAt'> | null): WriteSettings | null {
  if (!askAiWritesEnabled()) return null;
  const stamped = conversation !== null && conversation.changesApprovedAt !== null;
  return { allowChanges: account.autoApproveChanges || stamped, allowDeletes: account.autoApproveDeletes };
}

export async function POST(req: Request) {
  // When the request began: the turn deadline is budgeted against maxDuration from here.
  const requestStartedAt = Date.now();
  if (!askAiEnabled()) return notFoundResponse();
  if (!isSameOrigin(req)) return json({ error: CROSS_SITE_MESSAGE }, 403);
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.code === 'UNAUTHENTICATED' ? 401 : 403);
    throw e;
  }

  // content-length is a hint, not proof (it can be absent or wrong), so it only lets an obviously
  // oversized request skip buffering the body; Buffer.byteLength on the real text is authoritative
  // (raw.length would count UTF-16 code units, not bytes — Task 8 review, M3).
  const contentLength = req.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) return json({ error: TOO_LARGE_MESSAGE }, 413);
  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return json({ error: TOO_LARGE_MESSAGE }, 413);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return badRequest();
  }
  let body: { kind: 'send'; data: z.infer<typeof bodySchema> } | { kind: 'approval'; data: z.infer<typeof approvalBodySchema> };
  if (typeof parsedJson === 'object' && parsedJson !== null && 'approvals' in parsedJson) {
    // The writes kill switch (spec 2026-10-01 §2): off, there is no card to answer — the same
    // bodyless 404 as the Ask AI switch, before the gates run or anything is locked.
    if (!askAiWritesEnabled()) return notFoundResponse();
    const approval = approvalBodySchema.safeParse(parsedJson);
    if (!approval.success) return badRequest();
    body = { kind: 'approval', data: approval.data };
  } else {
    const send = bodySchema.safeParse(parsedJson);
    if (!send.success) {
      // Only an empty/too-long message text gets the member-facing length copy; every other shape
      // failure (bad JSON already handled above, unknown model, unknown keys, a bad conversationId)
      // gets the generic bad-request line — that line used to say "Keep it under 4,000 characters."
      // for all of these, which made no sense for a bad id (Task 8 review, M4).
      const tooLong = send.error.issues.some((i) => i.path.join('.') === 'message.text' && (i.code === 'too_big' || i.code === 'too_small'));
      return json({ error: tooLong ? TOO_LONG_MESSAGE : BAD_REQUEST_MESSAGE, code: 'bad_request' }, 400);
    }
    body = { kind: 'send', data: send.data };
  }
  const isResume = body.kind === 'approval';

  const now = new Date();
  // A resume is a model call but not a new question (spec 2026-10-01 §6): it takes no daily question
  // slot; every other gate (eligibility, period reset, balance, the global ceiling) applies as for a send.
  const gate = await runGates({ user, now }, { countQuestion: !isResume });
  if (!gate.ok) {
    const { status, code, message, retryAfterSeconds } = gate.refusal;
    if (status === 404) return notFoundResponse();
    return json({ error: message, code }, status, retryAfterSeconds ? { 'retry-after': String(retryAfterSeconds) } : {});
  }
  const apiKey = anthropicApiKey();
  if (!apiKey) {
    if (!warnedNoKey) { warnedNoKey = true; console.warn('[ask chat] ASK_AI_ENABLED is set but ANTHROPIC_API_KEY is not'); }
    return json({ error: NOT_CONFIGURED_MESSAGE, code: 'not_configured' }, 503);
  }

  // From here on every exit goes through the try below, whose first statement registers the request
  // lifetime — before any chat is created or locked (see the file header).
  let streaming = false;
  // The chat whose turn lock this request holds, set on a create or a successful acquire. The catch
  // releases only this: the lock has no holder token, so releasing a chat this request never locked
  // (a throw in the busy-vs-missing lookup, say) would end another request's turn lock early.
  let held: string | null = null;
  let created = false;
  // A resume's answers and hidden outcome message are stored (prepareResume returned, so
  // recordAnswersAndAppend answered 'ok'): a setup failure after that says `answered: true`, and the
  // thread keeps the records instead of reopening cards a retry could only get a 404 for.
  let answersRecorded = false;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const { promise: turnFinished, resolve: finishTurn } = Promise.withResolvers<void>();
  try {
    // The first statement inside the try (not before it): a throw from after() itself — e.g. a host
    // without waitUntil support — still reaches the catch below (Task 8 re-review).
    after(() => turnFinished);
    // The listener only catches an abort from this point forward; a disconnect that already
    // happened earlier (during gates) is not missed — it is caught by the aborted-already check on
    // the next line instead (Task 8 review, I3a).
    req.signal.addEventListener('abort', () => controller.abort(req.signal.reason), { once: true });
    if (req.signal.aborted) controller.abort(req.signal.reason);

    const actor: ResearchActor = { localUserId: user.id, clerkUserId: user.clerkUserId, clientId: 'ask-ai', channel: 'chat', isAdmin: user.role === 'admin' };
    let conversationId: string;
    let model: AskModelId;
    let history: AskUIMessage[] = [];
    // The member's message on a send. A resume has none: it continues from the hidden outcome
    // message, which prepareResume puts last in `history` (runTurn refuses anything else).
    let newMessage: AskUIMessage | undefined;
    let writes: WriteSettings | null;
    if (body.kind === 'approval') {
      const locked = await lockAndLoad(user.id, body.data.conversationId);
      if ('response' in locked) return locked.response;
      conversationId = locked.loaded.conversation.id;
      held = conversationId;
      const resumed = await prepareResume({ userId: user.id, account: gate.account, actor, loaded: locked.loaded, answers: body.data.approvals, now });
      if ('response' in resumed) return resumed.response;
      answersRecorded = true;
      model = locked.loaded.conversation.model;
      history = resumed.history;
      writes = resumed.writes;
    } else {
      const userMessage: AskUIMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: body.data.message.text }] };
      newMessage = userMessage;
      if (body.data.conversationId === null) {
        model = body.data.model ?? DEFAULT_MODEL;
        // Created already locked (in_flight_since = now()), so no acquireTurnLock round trip here.
        let r: Awaited<ReturnType<typeof createConversationWithFirstMessage>>;
        try {
          r = await createConversationWithFirstMessage({ userId: user.id, model, message: userMessage, now });
        } catch (e) {
          // No lock exists yet on this path (the insert itself failed) — nothing to release.
          console.error('[ask chat]', JSON.stringify({ outcome: 'create_failed', userId: user.id, ...errFields(e) }));
          return setupFailed();
        }
        if (r === 'cap') return json({ error: CHAT_CAP_MESSAGE, code: 'chat_cap' }, 409);
        conversationId = r.conversationId;
        held = conversationId;
        created = true;
        writes = writesFor(gate.account, null);
      } else {
        const locked = await lockAndLoad(user.id, body.data.conversationId);
        if ('response' in locked) return locked.response;
        conversationId = locked.loaded.conversation.id;
        held = conversationId;
        const followed = await prepareFollowUp({ userId: user.id, loaded: locked.loaded, message: userMessage, now });
        if ('response' in followed) return followed.response;
        model = locked.loaded.conversation.model;
        history = followed.history;
        writes = writesFor(gate.account, locked.loaded.conversation);
      }
    }
    const cid = conversationId;
    const chosen = model;
    // A resume is a billed turn but not a new question (spec 2026-10-01 §6).
    if (!isResume) void bumpUserActivity(user.id, 'ask_question');

    const meta = await loadSnapshotMetaHttp();
    const limits = researchLimits();
    // The guide's workspace rules reach the prompt only while writes are on (spec 2026-10-01 §4).
    const guide = buildGuide({ datasetWeek: meta?.currentWeekEndDate ?? null, audience: mcpAudience(), limits, workspace: writes !== null });
    const anthropic = createAnthropic({ apiKey });
    // The turn deadline, shortened by what this request already spent (a resume's writes, a slow
    // lock or load), so a deadline abort still leaves onEnd SETTLE_MARGIN_MS before maxDuration.
    const deadlineMs = Math.max(0, Math.min(ASK_LIMITS.turnDeadlineMs, maxDuration * 1000 - SETTLE_MARGIN_MS - (Date.now() - requestStartedAt)));
    timer = setTimeout(() => controller.abort(new Error(TURN_DEADLINE)), deadlineMs);
    // Measured from just before runTurn (Task 8 review, M1); declared ahead of turnInput purely so
    // the onEnd closure below reads as a normal forward reference, not a temporal-dead-zone one.
    const turnStartedAt = Date.now();
    const turnInput: Parameters<typeof runTurn>[0] = {
      model: anthropic(chosen),
      modelId: chosen,
      instructions: buildSystemPrompt(guide),
      // Spec 2026-10-01 §3, §6: the workspace tools ride along only while writes are on; the
      // approval map lists the writes that must pause for a card on this turn.
      tools: buildAskTools(defaultResearchService(), actor, limits, writes ? defaultWorkspaceService() : null),
      toolApproval: toolApprovalFor(writes),
      // windowHistory only ever drops from the front, so a resume's outcome message stays last.
      history: windowHistory(history),
      newMessage,
      abortSignal: controller.signal,
      generateMessageId: () => randomUUID(),
      startMetadata: created ? { conversationId: cid } : undefined,
      onEnd: async ({ assistant, status, usage, steps, finishReason, stopReason, approvalsRequested }) => {
        clearTimeout(timer);
        // One timestamp for both the settle and the alert (Task 10 review, C-m2): a month-boundary
        // crossing mid-onEnd could otherwise settle into one month but mark/alert the next.
        const settledAt = new Date();
        let cost: number | undefined;
        let settledResult: Awaited<ReturnType<typeof settleTurn>> | undefined;
        // Money first (spec §8 amendment): the settle must never depend on the answer being saved.
        try {
          cost = costMicro(chosen, usage);
          // A resume is billed like any turn but is not a question (spec 2026-10-01 §6).
          settledResult = await settleTurn({ userId: user.id, conversationId: cid, messageId: assistant?.id ?? null, model: chosen, usage, costMicro: cost, now: settledAt }, { countQuestion: !isResume });
          // finishReason/stopReason (Minor 7, final review) let ops tell a deadline stop from a
          // member Stop and spot a cut-off answer (finishReason: 'length') without opening the chat
          // — JSON.stringify drops each key when it's undefined, so stopReason only appears when the
          // turn actually stopped. `resume` and `approvalsRequested` (the cards this answer left
          // open) are arc 4's (spec 2026-10-01 §9).
          console.log('[ask turn]', JSON.stringify({
            outcome: status, userId: user.id, conversationId: cid, model: chosen, steps, finishReason, stopReason, resume: isResume, approvalsRequested, ...usage, costMicro: cost,
            absorbedMicro: settledResult.absorbedMicro, globalCostMicro: settledResult.globalCostMicro, durationMs: Date.now() - turnStartedAt,
          }));
        } catch (e) {
          // Everything needed to reconcile this turn by hand, since it was never billed.
          console.error('[ask turn]', JSON.stringify({
            outcome: 'settle_failed', userId: user.id, conversationId: cid, messageId: assistant?.id ?? null, model: chosen, status, resume: isResume, ...usage, costMicro: cost, ...errFields(e),
          }));
        }
        try {
          if (assistant) {
            const saved = await appendAssistantMessage({ conversationId: cid, message: assistant, status, now: new Date() });
            if (!saved) console.error('[ask turn]', JSON.stringify({ outcome: 'answer_not_saved', userId: user.id, conversationId: cid }));
          }
        } catch (e) {
          console.error('[ask turn]', JSON.stringify({ outcome: 'save_failed', userId: user.id, conversationId: cid, ...errFields(e) }));
        } finally {
          await releaseTurnLock(cid).catch(() => {});
          // Task 10 review, C4: the alert is started un-awaited so onEnd can return right after the
          // lock is released — the AI SDK waits for onEnd before closing the member's stream, and a
          // stalled Resend call (no built-in timeout in resend 6.12.3) must not delay the stream,
          // the save above, or this lock release. The route's own after(() => turnFinished) keeps
          // the function alive until the alert settles (bounded to 10s inside maybeAlertCeiling
          // itself, S6), which is why finishTurn is chained here instead of called directly.
          const alert = settledResult ? maybeAlertCeiling(settledResult.globalCostMicro, settledAt, settledResult.globalQuestions) : Promise.resolve();
          void alert.catch((e) => console.error('[ask turn]', JSON.stringify({ outcome: 'alert_failed', userId: user.id, conversationId: cid, ...errFields(e) }))).finally(finishTurn);
        }
      },
    };
    const response = await runTurn(turnInput);
    // A disconnect that landed exactly here (after runTurn returned a stream, before the browser
    // ever reads it) leaves nothing else to cancel the body — drive it ourselves so the SDK's own
    // cancel handling runs onEnd (Task 8 review, I3b).
    if (req.signal.aborted) void response.body?.cancel().catch(() => {});
    streaming = true;
    return response;
  } catch (e) {
    clearTimeout(timer);
    controller.abort();
    console.error('[ask chat]', JSON.stringify({ outcome: 'setup_failed', userId: user.id, conversationId: held ?? body.data.conversationId, resume: isResume, ...errFields(e) }));
    if (held) await releaseTurnLock(held).catch(() => {});
    // On a first send (Task 9 fix round 2, item 4) the chat and its question were already stored
    // before this failure — the id goes in the body so the client can stay in that chat instead of
    // resending with conversationId: null and creating an orphaned second one. A follow-up already
    // has the id client-side (it's `open`), so its body is unchanged. A resume whose answers were
    // already stored (`answersRecorded`) says `answered: true` (arc 4): the thread keeps those cards'
    // records instead of reopening them.
    return setupFailed({ ...(created && held ? { conversationId: held } : {}), ...(answersRecorded ? { answered: true } : {}) });
  } finally {
    if (!streaming) finishTurn();
  }
}

// --- The steps before a turn on an existing chat: lock + load, then a follow-up send or a resume ---

type LoadedChat = NonNullable<Awaited<ReturnType<typeof loadConversation>>>;

/**
 * Locks the chat, then loads its history window. Lock before load (Minor 8, final review): loading
 * the history window first and acquiring the lock second let a resend right after the 2s Stop
 * cooldown read a window that was still missing the previous turn's partial answer — that answer's
 * own onEnd was still saving it under the very lock this acquire is about to take. Acquiring first
 * means the load always sees whatever the previous turn managed to save before it released the lock.
 *
 * `{ loaded }` comes back with the lock HELD (POST records it as `held`): every early response
 * releases it until the turn's own onEnd takes over. `{ response }` comes back with no lock held —
 * never acquired (busy, or a chat that is missing or not this member's) or released here (a failed
 * load, a chat deleted in between). A throw (the busy-vs-missing lookup is not caught here) holds no
 * lock either and reaches POST's catch.
 */
async function lockAndLoad(userId: string, id: string): Promise<{ loaded: LoadedChat } | { response: NextResponse }> {
  if (!(await acquireTurnLock(userId, id))) {
    // Not acquired means either busy (another turn holds it) or the conversation doesn't exist /
    // isn't owned by this user — a cheap single-row lookup (not the full history window) tells
    // them apart without paying for the common busy case's full load.
    const exists = await loadConversation(userId, id, { lastN: 1 });
    return { response: exists ? json({ error: BUSY_MESSAGE, code: 'busy' }, 409) : notFoundResponse() };
  }
  let loaded: Awaited<ReturnType<typeof loadConversation>>;
  try {
    loaded = await loadConversation(userId, id, { lastN: ASK_LIMITS.historyWindowMessages });
  } catch (e) {
    // A transient Neon error, or toConv() throwing on a model id the code no longer recognizes,
    // used to escape unhandled here (Must-fix 1, final re-review) — with the lock never released,
    // every retry for up to 5 minutes got 409 busy instead of ever reaching a real answer.
    console.error('[ask chat]', JSON.stringify({ outcome: 'load_failed', userId, conversationId: id, ...errFields(e) }));
    return { response: await released(id, setupFailed()) };
  }
  // Deleted in the gap between the acquire above and this load — nothing left to answer into.
  if (!loaded) return { response: await released(id, notFoundResponse()) };
  return { loaded };
}

// Fixed strings (errFields logs an Error's message): what failed, never what was in it.
/** recordAnswersAndAppend found no assistant message by that id in this member's chat. */
const NOT_RECORDED = 'recordAnswersAndAppend: the stored assistant message is gone';
/** stampChangesApproved found no chat, or setAutoApprove no account row, to save the answer on. */
const NOT_REMEMBERED = 'remember: nothing to save it on';

/**
 * A follow-up send, with the chat locked and loaded: first resolves every card still open on the
 * last assistant message — its stored parts become output-denied (the record reads "Denied") and
 * ONE hidden message, one line per card, goes in ahead of the member's (spec 2026-10-01 §6) — then
 * appends the member's message. The hidden lines report each card as superseded, not denied: the
 * prompt's no-retry rule covers only a denial given in a card, so a member who types "yes, save it"
 * instead of clicking can still be served. Like a resume's, the message also reports the calls that
 * ran without a card after the paused message's last text (unreplayedResults): the history replay
 * drops that part of the message here too. Regardless of the writes switch: a card left open when it
 * went off is still resolved (§9), and the resolution touches no workspace data. Returns the history
 * for the turn (without the member's message, which runTurn adds), or an early response with the
 * lock released.
 */
async function prepareFollowUp(a: { userId: string; loaded: LoadedChat; message: AskUIMessage; now: Date }): Promise<{ history: AskUIMessage[] } | { response: NextResponse }> {
  const { conversation, messages } = a.loaded;
  const cid = conversation.id;
  const last = messages.at(-1);
  // The stored parts are data: one that cannot be read throws here, and POST's catch releases the lock.
  const pending = last ? pendingApprovals(last) : [];
  // Room for every append this send makes (the denial when cards are open, then the message),
  // checked before any is made: a send refused as full changes nothing, and an open card stays
  // answerable on its own. The writes' own 'full' results below still answer the same 409.
  if (conversation.messageCount + (pending.length > 0 ? 2 : 1) > ASK_LIMITS.maxMessagesPerChat) return { response: await released(cid, chatFull()) };
  let history = messages;
  if (last && pending.length > 0) {
    let parts = last.parts;
    for (const p of pending) parts = respondedParts(parts, p.approvalId, false);
    const denial = approvalOutcomeMessage(pending.map((p) => ({ toolName: p.toolName, approved: false, superseded: true })), unreplayedResults(last));
    try {
      // The resolved parts and the hidden message, in one statement (recordAnswersAndAppend).
      const recorded = await recordAnswersAndAppend({ conversationId: cid, userId: a.userId, messageId: last.id, parts, message: denial, now: a.now });
      if (recorded === 'full') return { response: await released(cid, chatFull()) };
      if (recorded === 'missing') throw new Error(NOT_RECORDED);
    } catch (e) {
      console.error('[ask chat]', JSON.stringify({ outcome: 'pending_denied_failed', userId: a.userId, conversationId: cid, ...errFields(e) }));
      return { response: await released(cid, setupFailed()) };
    }
    history = [...messages.slice(0, -1), { ...last, parts }, denial];
  }
  // Inside a try like every write here (Task 8 review, I1 — appendUserMessage used to run outside
  // one and could leave the chat locked for the full 5-minute expiry on something as simple as a bad
  // character).
  try {
    if ((await appendUserMessage({ conversationId: cid, userId: a.userId, message: a.message, now: a.now })) === 'full') return { response: await released(cid, chatFull()) };
  } catch (e) {
    console.error('[ask chat]', JSON.stringify({ outcome: 'append_failed', userId: a.userId, conversationId: cid, ...errFields(e) }));
    return { response: await released(cid, setupFailed()) };
  }
  return { history };
}

/**
 * The approval resume (spec 2026-10-01 §6, as amended in its plan), with the chat locked and loaded
 * — ownership comes from the lock and the owner-scoped load, never from the body. In order:
 * 1. Verify, before anything is saved or run. The answers must be exactly the cards still open on
 *    the chat's last assistant message: an id with nothing open by it (unknown, already answered,
 *    not on the last message) → bodyless 404, never a hint which. Fail closed with 400: an
 *    incomplete set (the thread always sends the whole set), an open card on a tool that is not a
 *    write (cannot exist), 'chat' on a card that is not a change (a stamp allows changes, so only a
 *    change card offers it). No room left for the outcome message → 409 chat_full.
 * 2. `remember`, saved fail-closed: if it cannot be saved, nothing has run, the cards stay open, and
 *    the member's next click retries cleanly (both saves are idempotent). Merged: any 'chat' stamps
 *    the chat once (skipped when it is stamped already: the first stamp is kept anyway); 'always'
 *    sets the toggle of each kind it answered, in one call. A preference saved here stays saved when
 *    a later step answers 503 (the writes' record, the turn's setup): benign — the member chose it,
 *    and the retry saves it again idempotently.
 * 3. The writes, in part order, from the input the server stored when the model asked
 *    (runWorkspaceTool re-validates it and never throws; the paused call itself is never replayed to
 *    the model), then the answers and ONE hidden outcome message, one line per card, written
 *    together (recordAnswersAndAppend). The message also carries a line per call that ran without
 *    a card after the paused message's last text (unreplayedResults): the history replay drops
 *    that part of the message, so the model would otherwise never see those results.
 * So a resume that answers 200 has its writes, their record and the preferences all landed. Returns
 * the turn's history (ending with the outcome message) and its writes decision, or an early
 * response with the lock released.
 */
async function prepareResume(a: {
  userId: string; account: Pick<AskAccount, 'autoApproveChanges' | 'autoApproveDeletes'>; actor: ResearchActor; loaded: LoadedChat; answers: ApprovalAnswer[]; now: Date;
}): Promise<{ history: AskUIMessage[]; writes: WriteSettings | null } | { response: NextResponse }> {
  const { conversation, messages } = a.loaded;
  const cid = conversation.id;
  const last = messages.at(-1);
  // The stored parts are data: one that cannot be read throws here, and POST's catch releases the lock.
  const pending = last ? pendingApprovals(last) : [];
  const open = new Set(pending.map((p) => p.approvalId));
  const answers = new Map(a.answers.map((x) => [x.approvalId, x]));
  if (!last || a.answers.some((x) => !open.has(x.approvalId))) return { response: await released(cid, notFoundResponse()) };
  const refused = pending.some((p) => {
    const answer = answers.get(p.approvalId);
    const kind = writeKind(p.toolName);
    return !answer || kind === null || (answer.remember === 'chat' && kind !== 'change');
  });
  if (refused) return { response: await released(cid, badRequest()) };
  if (conversation.messageCount + 1 > ASK_LIMITS.maxMessagesPerChat) return { response: await released(cid, chatFull()) };
  // Read with the rest of the verification, before anything is saved or run: stored parts that cannot
  // be read throw here (POST's catch releases the lock), never inside the double-run window below.
  const alsoRan = unreplayedResults(last);

  const remember = { chat: false, changes: false, deletes: false };
  for (const p of pending) {
    const answer = answers.get(p.approvalId)!;
    if (answer.approved && answer.remember === 'chat') remember.chat = true;
    if (answer.approved && answer.remember === 'always') remember[writeKind(p.toolName) === 'delete' ? 'deletes' : 'changes'] = true;
  }
  let account = a.account;
  let changesApprovedAt = conversation.changesApprovedAt;
  try {
    if (remember.chat && changesApprovedAt === null) {
      if (!(await stampChangesApproved(a.userId, cid, a.now))) throw new Error(NOT_REMEMBERED);
      changesApprovedAt = a.now;
    }
    if (remember.changes || remember.deletes) {
      const saved = await setAutoApprove(a.userId, { ...(remember.changes ? { changes: true } : {}), ...(remember.deletes ? { deletes: true } : {}) });
      if (!saved) throw new Error(NOT_REMEMBERED);
      account = saved;
    }
  } catch (e) {
    console.error('[ask chat]', JSON.stringify({ outcome: 'approval_remember_failed', userId: a.userId, conversationId: cid, ...errFields(e) }));
    return { response: await released(cid, setupFailed()) };
  }

  // The writes run before the one statement that records them. If that statement fails (or the
  // invocation dies in between), the writes are done but the cards still read as open, and
  // answering them again runs the writes again. Mostly harmless (the workspace's own checks refuse a
  // duplicate name or an id already gone), but two effects are worse: a retried Approve reports
  // DUPLICATE_NAME or NOT_FOUND for a write that in fact succeeded, and a retried Deny stores
  // "denied" for a delete that already ran. A two-phase record (mark the answers before running) is
  // a recorded follow-up.
  let parts = last.parts;
  const outcomes: ApprovalOutcome[] = [];
  let ran = 0;
  let outcome: AskUIMessage;
  let recorded: RecordAndAppendResult;
  try {
    const workspace = defaultWorkspaceService();
    for (const p of pending) {
      const { approved } = answers.get(p.approvalId)!;
      const output = approved ? await runWorkspaceTool(workspace, a.actor, p.toolName, p.input) : undefined;
      if (approved) ran += 1;
      parts = respondedParts(parts, p.approvalId, approved, output);
      outcomes.push({ toolName: p.toolName, approved, output });
    }
    outcome = approvalOutcomeMessage(outcomes, alsoRan);
    recorded = await recordAnswersAndAppend({ conversationId: cid, userId: a.userId, messageId: last.id, parts, message: outcome, now: a.now });
    if (recorded === 'missing') throw new Error(NOT_RECORDED);
  } catch (e) {
    console.error('[ask chat]', JSON.stringify({ outcome: 'approval_record_failed', userId: a.userId, conversationId: cid, ran, ...errFields(e) }));
    return { response: await released(cid, setupFailed()) };
  }
  if (recorded === 'full') {
    // The count check above normally answers this first; logged, because the writes already ran.
    console.error('[ask chat]', JSON.stringify({ outcome: 'approval_record_failed', userId: a.userId, conversationId: cid, ran, reason: 'chat_full' }));
    return { response: await released(cid, chatFull()) };
  }
  return { history: [...messages.slice(0, -1), { ...last, parts }, outcome], writes: writesFor(account, { changesApprovedAt }) };
}

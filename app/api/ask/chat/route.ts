/**
 * POST /api/ask/chat — one Ask AI turn (spec §3, §6–§9, §12–§13).
 * Body: { conversationId: uuid | null, model?: AskModelId (first send only), message: { text } }.
 * Order: kill switch → same-origin → session → body → gates → API key → conversation (create on
 * first send, already locked | load + lock + append) → turn setup AND the turn itself (both
 * inside one try — a throw from `runTurn` before it starts streaming, e.g. convertToModelMessages,
 * releases the lock and answers 503 exactly like a setup failure; see the Task 6 re-review
 * amendment under ### Task 8 in the plan) → stream. Settlement runs in the turn's onEnd BEFORE the
 * answer is saved (money first).
 *
 * Lifetime past the point the lock is held (Task 8 review, I3): the invocation must survive a
 * client disconnect long enough for onEnd to settle, save and unlock, so `after(() => turnFinished)`
 * is registered once both setup paths converge and the lock is confirmed held — never earlier, or
 * every 4xx refusal above this point would pin the function for up to `maxDuration` — and
 * `turnFinished` resolves on every exit from here on: onEnd's own `finally`, and this function's
 * `finally` for any exit that never reaches streaming (the setup catch, in particular). On Vercel
 * this only matters once `vercel.json`'s `functions["app/api/ask/chat/route.ts"].supportsCancellation`
 * is on — see that file and the spec §6 amendment.
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
import { ASK_LIMITS, ASK_MODELS, DEFAULT_MODEL, anthropicApiKey, askAiEnabled, type AskModelId } from '@/lib/ask/config';
import { runGates } from '@/lib/ask/gates';
import { isSameOrigin } from '@/lib/ask/sameOrigin';
import { buildSystemPrompt } from '@/lib/ask/prompt';
import { buildAskTools } from '@/lib/ask/tools';
import { runTurn, windowHistory, TURN_DEADLINE } from '@/lib/ask/turn';
import { costMicro } from '@/lib/ask/pricing';
import { settleTurn } from '@/lib/ask/ledger';
import { maybeAlertCeiling } from '@/lib/ask/alerts';
import { errFields } from '@/lib/ask/logSafe';
import {
  BAD_REQUEST_MESSAGE, BUSY_MESSAGE, CHAT_CAP_MESSAGE, CHAT_FULL_MESSAGE, CROSS_SITE_MESSAGE, FAILED_MESSAGE, NOT_CONFIGURED_MESSAGE, TOO_LARGE_MESSAGE, TOO_LONG_MESSAGE,
} from '@/lib/ask/messages';
import {
  acquireTurnLock, appendAssistantMessage, appendUserMessage, createConversationWithFirstMessage, loadConversation, releaseTurnLock, type AskUIMessage,
} from '@/lib/ask/conversations';

export const runtime = 'nodejs';
export const maxDuration = 300;

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
      z.string().trim().min(1).max(ASK_LIMITS.maxMessageChars),
    ),
  }),
});

const NO_STORE = { 'cache-control': 'no-store' };
function json(body: unknown, status: number, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });
}
let warnedNoKey = false;

export async function POST(req: Request) {
  if (!askAiEnabled()) return new NextResponse(null, { status: 404, headers: NO_STORE });
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
    return json({ error: BAD_REQUEST_MESSAGE, code: 'bad_request' }, 400);
  }
  const body = bodySchema.safeParse(parsedJson);
  if (!body.success) {
    // Only an empty/too-long message text gets the member-facing length copy; every other shape
    // failure (bad JSON already handled above, unknown model, unknown keys, a bad conversationId)
    // gets the generic bad-request line — that line used to say "Keep it under 4,000 characters."
    // for all of these, which made no sense for a bad id (Task 8 review, M4).
    const tooLong = body.error.issues.some((i) => i.path.join('.') === 'message.text' && (i.code === 'too_big' || i.code === 'too_small'));
    return json({ error: tooLong ? TOO_LONG_MESSAGE : BAD_REQUEST_MESSAGE, code: 'bad_request' }, 400);
  }

  const now = new Date();
  const gate = await runGates({ user, now });
  if (!gate.ok) {
    const { status, code, message, retryAfterSeconds } = gate.refusal;
    if (status === 404) return new NextResponse(null, { status: 404, headers: NO_STORE });
    return json({ error: message, code }, status, retryAfterSeconds ? { 'retry-after': String(retryAfterSeconds) } : {});
  }
  const apiKey = anthropicApiKey();
  if (!apiKey) {
    if (!warnedNoKey) { warnedNoKey = true; console.warn('[ask chat] ASK_AI_ENABLED is set but ANTHROPIC_API_KEY is not'); }
    return json({ error: NOT_CONFIGURED_MESSAGE, code: 'not_configured' }, 503);
  }

  const userMessage: AskUIMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: body.data.message.text }] };
  let conversationId: string;
  let model: AskModelId;
  let history: AskUIMessage[] = [];
  let created = false;
  if (body.data.conversationId === null) {
    model = body.data.model ?? DEFAULT_MODEL;
    // Created already locked (in_flight_since = now()), so no acquireTurnLock round trip here.
    let r: Awaited<ReturnType<typeof createConversationWithFirstMessage>>;
    try {
      r = await createConversationWithFirstMessage({ userId: user.id, model, message: userMessage, now });
    } catch (e) {
      // No lock exists yet on this path (the insert itself failed) — nothing to release.
      console.error('[ask chat]', JSON.stringify({ outcome: 'create_failed', userId: user.id, ...errFields(e) }));
      return json({ error: FAILED_MESSAGE, code: 'setup_failed' }, 503);
    }
    if (r === 'cap') return json({ error: CHAT_CAP_MESSAGE, code: 'chat_cap' }, 409);
    conversationId = r.conversationId;
    created = true;
  } else {
    const loaded = await loadConversation(user.id, body.data.conversationId, { lastN: ASK_LIMITS.historyWindowMessages });
    if (!loaded) return new NextResponse(null, { status: 404, headers: NO_STORE });
    if (loaded.conversation.messageCount >= ASK_LIMITS.maxMessagesPerChat) return json({ error: CHAT_FULL_MESSAGE, code: 'chat_full' }, 409);
    if (!(await acquireTurnLock(user.id, loaded.conversation.id))) return json({ error: BUSY_MESSAGE, code: 'busy' }, 409);
    // The lock is held from here on in this branch: a throw or a full chat must release it before
    // returning (Task 8 review, I1 — appendUserMessage used to run outside this try and could
    // leave the chat locked for the full 5-minute expiry on something as simple as a bad character).
    try {
      const appended = await appendUserMessage({ conversationId: loaded.conversation.id, userId: user.id, message: userMessage, now });
      if (appended === 'full') {
        await releaseTurnLock(loaded.conversation.id).catch(() => {});
        return json({ error: CHAT_FULL_MESSAGE, code: 'chat_full' }, 409);
      }
    } catch (e) {
      console.error('[ask chat]', JSON.stringify({ outcome: 'append_failed', userId: user.id, conversationId: loaded.conversation.id, ...errFields(e) }));
      await releaseTurnLock(loaded.conversation.id).catch(() => {});
      return json({ error: FAILED_MESSAGE, code: 'setup_failed' }, 503);
    }
    conversationId = loaded.conversation.id;
    model = loaded.conversation.model;
    history = loaded.messages;
  }
  const cid = conversationId;
  const chosen = model;
  void bumpUserActivity(user.id, 'ask_question');

  // Everything from here until the stream starts runs with the lock held: release it on any
  // failure, including a throw from runTurn itself before it begins streaming. See the file header
  // for why after() is registered exactly here.
  let streaming = false;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const { promise: turnFinished, resolve: finishTurn } = Promise.withResolvers<void>();
  try {
    // Registered as the first statement inside the try (not before it): a throw from after()
    // itself — e.g. a host without waitUntil support — must still reach the catch below and
    // release the lock, rather than escaping the function with the lock held (Task 8 re-review).
    after(() => turnFinished);
    // The listener only catches an abort from this point forward; a disconnect that already
    // happened earlier (during gates/setup) is not missed — it is caught by the aborted-already
    // check on the next line instead (Task 8 review, I3a).
    req.signal.addEventListener('abort', () => controller.abort(req.signal.reason), { once: true });
    if (req.signal.aborted) controller.abort(req.signal.reason);
    const actor: ResearchActor = { localUserId: user.id, clerkUserId: user.clerkUserId, clientId: 'ask-ai', channel: 'chat' };
    const meta = await loadSnapshotMetaHttp();
    const guide = buildGuide({ datasetWeek: meta?.currentWeekEndDate ?? null, audience: mcpAudience(), limits: researchLimits() });
    const anthropic = createAnthropic({ apiKey });
    timer = setTimeout(() => controller.abort(new Error(TURN_DEADLINE)), ASK_LIMITS.turnDeadlineMs);
    // Measured from just before runTurn (Task 8 review, M1); declared ahead of turnInput purely so
    // the onEnd closure below reads as a normal forward reference, not a temporal-dead-zone one.
    const turnStartedAt = Date.now();
    const turnInput: Parameters<typeof runTurn>[0] = {
      model: anthropic(chosen),
      modelId: chosen,
      instructions: buildSystemPrompt(guide),
      tools: buildAskTools(defaultResearchService(), actor),
      history: windowHistory(history),
      newMessage: userMessage,
      abortSignal: controller.signal,
      generateMessageId: () => randomUUID(),
      startMetadata: created ? { conversationId: cid } : undefined,
      onEnd: async ({ assistant, status, usage, steps }) => {
        clearTimeout(timer);
        let cost: number | undefined;
        // Money first (spec §8 amendment): the settle must never depend on the answer being saved.
        try {
          cost = costMicro(chosen, usage);
          const settled = await settleTurn({ userId: user.id, conversationId: cid, messageId: assistant?.id ?? null, model: chosen, usage, costMicro: cost, now: new Date() });
          console.log('[ask turn]', JSON.stringify({
            outcome: status, userId: user.id, conversationId: cid, model: chosen, steps, ...usage, costMicro: cost,
            absorbedMicro: settled.absorbedMicro, globalCostMicro: settled.globalCostMicro, durationMs: Date.now() - turnStartedAt,
          }));
          // Its own try: an alert failure (Resend, Task 10) must never read as an unbilled turn on
          // the settle_failed line above (Task 8 review, M1) — the settle already succeeded.
          try {
            await maybeAlertCeiling(settled.globalCostMicro, new Date(), settled.globalQuestions);
          } catch (e) {
            console.error('[ask turn]', JSON.stringify({ outcome: 'alert_failed', userId: user.id, conversationId: cid, ...errFields(e) }));
          }
        } catch (e) {
          // Everything needed to reconcile this turn by hand, since it was never billed.
          console.error('[ask turn]', JSON.stringify({
            outcome: 'settle_failed', userId: user.id, conversationId: cid, messageId: assistant?.id ?? null, model: chosen, status, ...usage, costMicro: cost, ...errFields(e),
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
          finishTurn();
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
    console.error('[ask chat]', JSON.stringify({ outcome: 'setup_failed', userId: user.id, conversationId: cid, ...errFields(e) }));
    await releaseTurnLock(cid).catch(() => {});
    return json({ error: FAILED_MESSAGE, code: 'setup_failed' }, 503);
  } finally {
    if (!streaming) finishTurn();
  }
}

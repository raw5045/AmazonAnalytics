/**
 * POST /api/ask/chat — one Ask AI turn (spec §3, §6–§9, §12–§13).
 * Body: { conversationId: uuid | null, model?: AskModelId (first send only), message: { text } }.
 * Order: kill switch → same-origin → session → body → gates → API key → conversation (create on
 * first send, already locked | load + lock + append) → turn setup AND the turn itself (both
 * inside one try — a throw from `runTurn` before it starts streaming, e.g. convertToModelMessages,
 * releases the lock and answers 503 exactly like a setup failure; see the Task 6 re-review
 * amendment under ### Task 8 in the plan) → stream. Settlement runs in the turn's onEnd BEFORE the
 * answer is saved (money first).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
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
import { runTurn, windowHistory } from '@/lib/ask/turn';
import { costMicro } from '@/lib/ask/pricing';
import { settleTurn } from '@/lib/ask/ledger';
import { maybeAlertCeiling } from '@/lib/ask/alerts';
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
  message: z.strictObject({ text: z.string().trim().min(1).max(ASK_LIMITS.maxMessageChars) }),
});

const NO_STORE = { 'cache-control': 'no-store' };
function json(body: unknown, status: number, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });
}
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
let warnedNoKey = false;

export async function POST(req: Request) {
  if (!askAiEnabled()) return new NextResponse(null, { status: 404 });
  if (!isSameOrigin(req)) return json({ error: 'Cross-site requests are not allowed.' }, 403);
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.code === 'UNAUTHENTICATED' ? 401 : 403);
    throw e;
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'Request too large.' }, 413);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return json({ error: 'Keep it under 4,000 characters.', code: 'bad_request' }, 400);
  }
  const body = bodySchema.safeParse(parsedJson);
  if (!body.success) return json({ error: 'Keep it under 4,000 characters.', code: 'bad_request' }, 400);

  const now = new Date();
  const gate = await runGates({ user, now });
  if (!gate.ok) {
    const { status, code, message, retryAfterSeconds } = gate.refusal;
    if (status === 404) return new NextResponse(null, { status: 404 });
    return json({ error: message, code }, status, retryAfterSeconds ? { 'retry-after': String(retryAfterSeconds) } : {});
  }
  const apiKey = anthropicApiKey();
  if (!apiKey) {
    if (!warnedNoKey) { warnedNoKey = true; console.warn('[ask chat] ASK_AI_ENABLED is set but ANTHROPIC_API_KEY is not'); }
    return json({ error: "Ask AI isn't configured yet.", code: 'not_configured' }, 503);
  }

  const userMessage: AskUIMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: body.data.message.text }] };
  let conversationId: string;
  let model: AskModelId;
  let history: AskUIMessage[] = [];
  let created = false;
  if (body.data.conversationId === null) {
    model = body.data.model ?? DEFAULT_MODEL;
    // Created already locked (in_flight_since = now()), so no acquireTurnLock round trip here.
    const r = await createConversationWithFirstMessage({ userId: user.id, model, message: userMessage, now });
    if (r === 'cap') return json({ error: 'You have 5 chats. Delete one to start another.', code: 'chat_cap' }, 409);
    conversationId = r.conversationId;
    created = true;
  } else {
    const loaded = await loadConversation(user.id, body.data.conversationId, { lastN: ASK_LIMITS.historyWindowMessages });
    if (!loaded) return new NextResponse(null, { status: 404 });
    if (loaded.conversation.messageCount >= ASK_LIMITS.maxMessagesPerChat) return json({ error: 'This chat is full. Start a new one.', code: 'chat_full' }, 409);
    if (!(await acquireTurnLock(user.id, loaded.conversation.id))) return json({ error: 'Wait for the current answer to finish.', code: 'busy' }, 409);
    const appended = await appendUserMessage({ conversationId: loaded.conversation.id, userId: user.id, message: userMessage, now });
    if (appended === 'full') {
      await releaseTurnLock(loaded.conversation.id);
      return json({ error: 'This chat is full. Start a new one.', code: 'chat_full' }, 409);
    }
    conversationId = loaded.conversation.id;
    model = loaded.conversation.model;
    history = loaded.messages;
  }
  const cid = conversationId;
  const chosen = model;
  void bumpUserActivity(user.id, 'ask_question');

  // Everything from here until the stream starts runs with the lock held: release it on any
  // failure, including a throw from runTurn itself before it begins streaming.
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const actor: ResearchActor = { localUserId: user.id, clerkUserId: user.clerkUserId, clientId: 'ask-ai', channel: 'chat' };
    const meta = await loadSnapshotMetaHttp();
    const guide = buildGuide({ datasetWeek: meta?.currentWeekEndDate ?? null, audience: mcpAudience(), limits: researchLimits() });
    const anthropic = createAnthropic({ apiKey });
    timer = setTimeout(() => controller.abort(new Error('turn deadline')), ASK_LIMITS.turnDeadlineMs);
    req.signal.addEventListener('abort', () => controller.abort(req.signal.reason), { once: true });
    const turnInput: Parameters<typeof runTurn>[0] = {
      model: anthropic(chosen),
      instructions: buildSystemPrompt(guide),
      tools: buildAskTools(defaultResearchService(), actor),
      history: windowHistory(history),
      newMessage: userMessage,
      abortSignal: controller.signal,
      generateMessageId: () => randomUUID(),
      startMetadata: created ? { conversationId: cid } : undefined,
      onEnd: async ({ assistant, status, usage, steps }) => {
        clearTimeout(timer);
        const cost = costMicro(chosen, usage);
        // Money first (spec §8 amendment): the settle must never depend on the answer being saved.
        try {
          const settled = await settleTurn({ userId: user.id, conversationId: cid, messageId: assistant?.id ?? null, model: chosen, usage, costMicro: cost, now: new Date() });
          console.log('[ask turn]', JSON.stringify({ outcome: status, userId: user.id, conversationId: cid, model: chosen, steps, ...usage, costMicro: cost, absorbedMicro: settled.absorbedMicro, globalCostMicro: settled.globalCostMicro }));
          await maybeAlertCeiling(settled.globalCostMicro, new Date());
        } catch (e) {
          console.error('[ask turn]', JSON.stringify({ outcome: 'settle_failed', userId: user.id, conversationId: cid, message: describe(e) }));
        }
        try {
          if (assistant) {
            const saved = await appendAssistantMessage({ conversationId: cid, message: assistant, status, now: new Date() });
            if (!saved) console.error('[ask turn]', JSON.stringify({ outcome: 'answer_not_saved', userId: user.id, conversationId: cid }));
          }
        } catch (e) {
          console.error('[ask turn]', JSON.stringify({ outcome: 'save_failed', userId: user.id, conversationId: cid, message: describe(e) }));
        } finally {
          await releaseTurnLock(cid).catch(() => {});
        }
      },
    };
    return await runTurn(turnInput);
  } catch (e) {
    clearTimeout(timer);
    console.error('[ask chat]', JSON.stringify({ outcome: 'setup_failed', userId: user.id, conversationId: cid, message: describe(e) }));
    await releaseTurnLock(cid).catch(() => {});
    return json({ error: 'Something went wrong on our side. Try again in a minute.', code: 'setup_failed' }, 503);
  }
}

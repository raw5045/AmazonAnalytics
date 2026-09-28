import {
  convertToModelMessages, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream,
  type LanguageModel, type ModelMessage, type ToolSet,
} from 'ai';
import { ASK_LIMITS } from './config';
import { addUsage, usageFromSdk, ZERO_USAGE, type TurnUsage } from './pricing';
import type { AskUIMessage, MessageStatus } from './conversations';

/** Spec §6. One turn: bounded loop, streamed to the browser, persisted and settled through `onEnd`. */
export interface TurnInput {
  model: LanguageModel;
  instructions: string;
  tools: ToolSet;
  /** Already windowed by the caller (windowHistory). */
  history: AskUIMessage[];
  newMessage: AskUIMessage;
  abortSignal: AbortSignal;
  generateMessageId: () => string;
  /** Attached to the assistant message when the stream starts — the new conversation's id on a first send. */
  startMetadata?: AskUIMessage['metadata'];
  onEnd: (outcome: { assistant: AskUIMessage | null; status: MessageStatus; usage: TurnUsage; steps: number }) => Promise<void>;
}

const CACHE = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

/** Last 20 stored messages, then drop the oldest while the estimate exceeds the token guard (spec §6). */
export function windowHistory(history: AskUIMessage[], limits: Pick<typeof ASK_LIMITS, 'historyWindowMessages' | 'historyWindowTokens'> = ASK_LIMITS): AskUIMessage[] {
  let out = history.slice(-limits.historyWindowMessages);
  while (out.length > 1 && estimateTokens(out) > limits.historyWindowTokens) out = out.slice(1);
  return out;
}

export function statusFor(f: { isAborted: boolean; errored: boolean }): MessageStatus {
  if (f.isAborted) return 'stopped';
  return f.errored ? 'failed' : 'complete';
}

export async function runTurn(input: TurnInput): Promise<Response> {
  let usage: TurnUsage = { ...ZERO_USAGE };
  let steps = 0;
  let errored = false;
  const original = [...input.history, input.newMessage];
  const messages: ModelMessage[] = await convertToModelMessages(original, { tools: input.tools, ignoreIncompleteToolCalls: true });
  const last = messages[messages.length - 1];
  if (last) messages[messages.length - 1] = { ...last, providerOptions: CACHE } as ModelMessage;

  const result = streamText({
    model: input.model,
    instructions: [{ role: 'system', content: input.instructions, providerOptions: CACHE }],
    messages,
    tools: input.tools,
    stopWhen: isStepCount(ASK_LIMITS.maxSteps),
    maxOutputTokens: ASK_LIMITS.maxOutputTokens,
    abortSignal: input.abortSignal,
    onStepEnd: ({ usage: stepUsage }) => {
      usage = addUsage(usage, usageFromSdk(stepUsage));
      steps += 1;
    },
    onError: ({ error }) => {
      errored = true;
      const e = error as { name?: unknown; message?: unknown } | undefined;
      console.error('[ask turn]', JSON.stringify({ outcome: 'model_error', name: e?.name, message: e?.message }));
    },
  });

  return createUIMessageStreamResponse({
    headers: { 'cache-control': 'no-store' },
    stream: toUIMessageStream({
      stream: result.stream,
      tools: input.tools,
      originalMessages: original,
      generateMessageId: input.generateMessageId,
      messageMetadata: ({ part }) => (part.type === 'start' && input.startMetadata ? input.startMetadata : undefined),
      // never leak provider error text to the browser
      onError: () => 'The AI hit a problem. Try again in a minute.',
      onEnd: async ({ messages: all, isAborted }) => {
        const tail = all[all.length - 1];
        const assistant = tail && tail.role === 'assistant' && tail.parts.length > 0 ? (tail as AskUIMessage) : null;
        await input.onEnd({ assistant, status: statusFor({ isAborted, errored }), usage, steps });
      },
    }),
  });
}

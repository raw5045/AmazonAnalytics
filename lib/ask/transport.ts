import { DefaultChatTransport } from 'ai';
import type { AskUIMessage } from './conversations';

/**
 * The last user message's text, joined across its text parts. Spec §13: the browser's copy of the
 * conversation is not trusted — the request carries only the newest message's text (plus the chat
 * id, and the model on a first send); the server loads history itself.
 */
function lastUserText(messages: AskUIMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return last?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
}

/**
 * The chat transport for POST /api/ask/chat (Task 9 D5). The route's body schema is a strict zod
 * object accepting exactly `{ conversationId, model?, message: { text } }` — an unknown key is a
 * 400. `DefaultChatTransport`'s own default wire body additionally carries `id`, `messages`,
 * `trigger` and `messageId`; returning a `body` from `prepareSendMessagesRequest` REPLACES that
 * default wholesale rather than merging with it (node_modules/ai/dist/index.js,
 * HttpChatTransport#sendMessages: `preparedRequest?.body !== void 0 ? preparedRequest.body : {
 * ...resolvedBody, ...options.body, id, messages, trigger, messageId }`), so returning exactly the
 * three allowed keys here is what keeps the wire body strict-schema-clean — see transport.test.ts,
 * which asserts the parsed request body deep-equals the route's accepted shape.
 */
export function createAskTransport(): DefaultChatTransport<AskUIMessage> {
  return new DefaultChatTransport<AskUIMessage>({
    api: '/api/ask/chat',
    prepareSendMessagesRequest: ({ messages, body }) => ({ body: { ...(body ?? {}), message: { text: lastUserText(messages) } } }),
  });
}

/**
 * The approval lifecycle on stored messages (spec 2026-10-01 §6, as amended in the plan): the
 * member's answers to the cards never replay the paused tool calls to the model. The chat route
 * (arc 4 Task 6) runs or declines each tool itself, records the outcomes on the stored assistant
 * message (respondedParts) and tells the model through the hidden outcome message
 * (approvalOutcomeMessage); ./approvalResult describes that channel.
 *
 * Server-only (the marker below; `randomUUID` is node:crypto's, as in app/api/ask/chat/route.ts):
 * the chat route (arc 4 Task 6) imports this module. Browser code imports ./approvalResult instead;
 * its two names are re-exported here so server code keeps one import path. No logging here.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { getToolName, isToolUIPart } from 'ai';
import { APPROVAL_RESULT_PREFIX } from './approvalResult';
import type { AskUIMessage } from './conversations';

export { APPROVAL_RESULT_PREFIX, isApprovalResultMessage } from './approvalResult';

const MAX_RESULT_CHARS = 20_000;
/**
 * U+0085, U+2028, U+2029: JSON.stringify escapes \n and the other C0 controls but leaves these
 * three line breaks raw. Built from char codes so this source holds no raw separator.
 */
const RAW_LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g');

type Part = AskUIMessage['parts'][number];

export interface PendingApproval { messageId: string; toolCallId: string; approvalId: string; toolName: string; input: unknown }

/** The approval-requested tool parts of an assistant message, in part order (empty for any other message). The model can pause several calls in one step. */
export function pendingApprovals(m: Pick<AskUIMessage, 'id' | 'role' | 'parts'>): PendingApproval[] {
  if (m.role !== 'assistant') return [];
  const out: PendingApproval[] = [];
  for (const p of m.parts) {
    if (!isToolUIPart(p) || p.state !== 'approval-requested') continue;
    out.push({ messageId: m.id, toolCallId: p.toolCallId, approvalId: p.approval.id, toolName: getToolName(p), input: p.input });
  }
  return out;
}

/**
 * The stored parts with one approval answered: approved → output-available with the tool's result;
 * denied → output-denied. Other parts untouched. Both are the SDK's own answered shapes (no cast:
 * the narrowed request spreads into them), and the approval record keeps every field of the
 * request (its id, any signature, …) plus the answer.
 */
export function respondedParts(parts: AskUIMessage['parts'], approvalId: string, approved: boolean, output?: unknown): AskUIMessage['parts'] {
  return parts.map((p): Part => {
    if (!isToolUIPart(p) || p.state !== 'approval-requested' || p.approval.id !== approvalId) return p;
    return approved
      ? { ...p, state: 'output-available', output, approval: { ...p.approval, approved: true } }
      : { ...p, state: 'output-denied', approval: { ...p.approval, approved: false } };
  });
}

export interface ApprovalOutcome { toolName: string; approved: boolean; output?: unknown }

function outcomeLine(a: ApprovalOutcome): string {
  if (!a.approved) return `The person denied ${a.toolName}. Continue without it and do not retry it or try another way to get the same result.`;
  // runWorkspaceTool answers `{ error }` for a refusal or a failed write (DUPLICATE_NAME, LIMIT_REACHED, …): report it as a failure.
  const failed = typeof a.output === 'object' && a.output !== null && 'error' in a.output;
  let result = JSON.stringify((failed ? (a.output as { error: unknown }).error : a.output) ?? null);
  // A member-authored name could otherwise start a fake outcome line for a reader that honours
  // Unicode line breaks; the \uXXXX escape keeps the result valid JSON. Done before the cut.
  result = result.replace(RAW_LINE_BREAKS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  // The cut counts UTF-16 units, so it can split an emoji; toWellFormed() repairs the lone half
  // (not valid UTF-8 — the same repair conversations.ts applies before Postgres sees a string).
  if (result.length > MAX_RESULT_CHARS) result = `${result.slice(0, MAX_RESULT_CHARS).toWellFormed()}…`;
  return failed ? `The person approved ${a.toolName} but it failed: ${result}` : `The person approved ${a.toolName} and it ran. Result: ${result}`;
}

/** The hidden user message the model continues from: one line per answered card, in the order given (the route passes part order). */
export function approvalOutcomeMessage(outcomes: ApprovalOutcome[]): AskUIMessage {
  return { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: `${APPROVAL_RESULT_PREFIX} ${outcomes.map(outcomeLine).join('\n')}` }] };
}

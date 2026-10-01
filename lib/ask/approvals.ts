import { randomUUID } from 'node:crypto';
import { getToolName, isToolUIPart } from 'ai';
import type { AskUIMessage } from './conversations';

/**
 * Spec 2026-10-01 §6 (as amended in the plan): the member's answers to the cards never replay
 * the paused tool calls to the model. The server runs (or declines) each tool itself, records
 * the outcomes on the stored assistant message, and tells the model through ONE hidden user
 * message carrying this prefix. The thread hides such messages; the prompt explains them; the
 * chat route refuses a member message that starts with it (only the server writes this channel).
 *
 * Server-only: `randomUUID` is node:crypto's (as in app/api/ask/chat/route.ts), so browser code
 * never imports this module. No logging here.
 */
export const APPROVAL_RESULT_PREFIX = '[approval-result]';
const MAX_RESULT_CHARS = 20_000;

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
  // The cut counts UTF-16 units, so it can split an emoji; toWellFormed() repairs the lone half
  // (not valid UTF-8 — the same repair conversations.ts applies before Postgres sees a string).
  if (result.length > MAX_RESULT_CHARS) result = `${result.slice(0, MAX_RESULT_CHARS).toWellFormed()}…`;
  return failed ? `The person approved ${a.toolName} but it failed: ${result}` : `The person approved ${a.toolName} and it ran. Result: ${result}`;
}

/** The hidden user message the model continues from: one line per answered card, in part order. */
export function approvalOutcomeMessage(outcomes: ApprovalOutcome[]): AskUIMessage {
  return { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: `${APPROVAL_RESULT_PREFIX} ${outcomes.map(outcomeLine).join('\n')}` }] };
}

/** True only for the server's hidden outcome message: a user message whose first part is text starting with the prefix. */
export function isApprovalResultMessage(m: Pick<AskUIMessage, 'role' | 'parts'>): boolean {
  const first = m.parts[0];
  return m.role === 'user' && first?.type === 'text' && first.text.startsWith(APPROVAL_RESULT_PREFIX);
}

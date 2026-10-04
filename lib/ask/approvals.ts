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

export interface ApprovalOutcome {
  toolName: string; approved: boolean; output?: unknown;
  /**
   * The card was left for a new member message (the route's send path), not denied in the card:
   * reported as superseded, so the prompt's no-retry rule (a denial given in a card) does not stop
   * the model when that message asks for the same write again (spec 2026-10-01 §6).
   */
  superseded?: boolean;
}

/** A call that ran without a card in the paused message, after its last text (unreplayedResults): its result, or its failure. */
export interface StepResult { toolName: string; output?: unknown; errorText?: string }

/**
 * The tool calls that ran without a card after the paused message's last text, in part order. On a
 * resume the history replay (trimHistoryForReplay in ./turn) cuts an assistant message after its
 * last text, so the model would never see these results unless the outcome message reports them;
 * calls before that text are replayed already and are not repeated (a search's rows can be large).
 */
export function unreplayedResults(m: Pick<AskUIMessage, 'parts'>): StepResult[] {
  const lastText = m.parts.findLastIndex((p) => p.type === 'text' && p.text.trim() !== '');
  const out: StepResult[] = [];
  for (const p of m.parts.slice(lastText + 1)) {
    if (!isToolUIPart(p) || p.approval) continue;
    if (p.state === 'output-available') out.push({ toolName: getToolName(p), output: p.output });
    else if (p.state === 'output-error') out.push({ toolName: getToolName(p), errorText: p.errorText });
  }
  return out;
}

/** JSON as it goes into the hidden message: on one line, at most MAX_RESULT_CHARS, well-formed. */
function fit(json: string): string {
  // A member-authored name could otherwise start a fake outcome line for a reader that honours
  // Unicode line breaks; the \uXXXX escape keeps the result valid JSON. Done before the cut.
  let result = json.replace(RAW_LINE_BREAKS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  // The cut counts UTF-16 units, so it can split an emoji; toWellFormed() repairs the lone half
  // (not valid UTF-8 — the same repair conversations.ts applies before Postgres sees a string).
  if (result.length > MAX_RESULT_CHARS) result = `${result.slice(0, MAX_RESULT_CHARS).toWellFormed()}…`;
  return result;
}

/** A result that answers `{ error }` (runWorkspaceTool for a refusal or a failed write — DUPLICATE_NAME, LIMIT_REACHED, … — and the research tools alike) is a failure, never "it ran". */
function errorOf(output: unknown): { error: unknown } | null {
  return typeof output === 'object' && output !== null && 'error' in output ? (output as { error: unknown }) : null;
}

function outcomeLine(a: ApprovalOutcome): string {
  if (a.superseded) return `The person sent a new message instead of answering the card for ${a.toolName}, so it did not run. Follow their new message; call the tool again only if that message asks for this (a new card will ask).`;
  if (!a.approved) return `The person denied ${a.toolName}. Continue without it and do not retry it or try another way to get the same result.`;
  const failed = errorOf(a.output);
  const result = fit(JSON.stringify((failed ? failed.error : a.output) ?? null));
  return failed ? `The person approved ${a.toolName} but it failed: ${result}` : `The person approved ${a.toolName} and it ran. Result: ${result}`;
}

/** An output-error's text goes in as a JSON string, so a line break in it cannot start a line of its own. */
function alsoRanLine(r: StepResult): string {
  const failed = r.errorText !== undefined ? { error: r.errorText } : errorOf(r.output);
  const result = fit(JSON.stringify((failed ? failed.error : r.output) ?? null));
  return failed ? `Also ran in the same step: ${r.toolName} but it failed: ${result}` : `Also ran in the same step: ${r.toolName}. Result: ${result}`;
}

/**
 * The hidden user message the model continues from: one line per answered card, in the order given
 * (the route passes part order), then one line per call that ran without a card in the paused step
 * (`alsoRan`, a resume only: unreplayedResults).
 */
export function approvalOutcomeMessage(outcomes: ApprovalOutcome[], alsoRan: StepResult[] = []): AskUIMessage {
  const lines = [...outcomes.map(outcomeLine), ...alsoRan.map(alsoRanLine)];
  return { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: `${APPROVAL_RESULT_PREFIX} ${lines.join('\n')}` }] };
}

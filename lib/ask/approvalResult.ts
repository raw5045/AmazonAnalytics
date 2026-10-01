/**
 * The hidden approval-outcome channel (spec 2026-10-01 §6, as amended in the plan): the server
 * tells the model how the member answered the cards through ONE hidden user message that starts
 * with APPROVAL_RESULT_PREFIX (built by approvalOutcomeMessage in ./approvals). The thread hides
 * such messages; the prompt explains them; the chat route refuses a member message that starts
 * with the prefix (only the server writes this channel).
 *
 * Imported by browser code (Thread.tsx hides these messages), so this module must stay free of
 * runtime imports, like lib/ask/writeKinds.ts: the one import below is type-only and erased.
 * approvalResult.test.ts fails if a runtime import is added. ./approvals (server-only) re-exports
 * both names, so server code keeps one import path.
 */
import type { AskUIMessage } from './conversations';

export const APPROVAL_RESULT_PREFIX = '[approval-result]';

/** True for a hidden outcome message: a user message whose first part is text starting with the prefix. */
export function isApprovalResultMessage(m: Pick<AskUIMessage, 'role' | 'parts'>): boolean {
  const first = m.parts[0];
  return m.role === 'user' && first?.type === 'text' && first.text.startsWith(APPROVAL_RESULT_PREFIX);
}

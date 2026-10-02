'use client';
import { useId } from 'react';
import { getToolName, type ToolUIPart } from 'ai';
import { summarizeApproval, type ApprovalNames } from '@/lib/ask/approvalSummaries';
// Pure modules only (client-safety rule): never '@/lib/ask/tools', '@/lib/workspace/tools' or
// '@/lib/ask/approvals' here — each pulls server code into the page bundle.
import { writeKind } from '@/lib/ask/writeKinds';

/** One answer to one card, exactly as the chat route's approval body takes it (spec 2026-10-01 §6). */
export interface ApprovalAnswer { approvalId: string; approved: boolean; remember: 'chat' | 'always' | null }

// Composer's button classes.
const BUTTON = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50';
const SECONDARY = `${BUTTON} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50`;

/**
 * Spec 2026-10-01 §5: one card per write that paused for the member's approval, with the call's
 * plain-English summary. Live only on the open chat's last answer (`interactive`); a pending card
 * anywhere else is a "Waiting for an answer" line. Answered, it collapses to a one-line record.
 * Approve on a change card also allows the chat's later changes ('chat'); deletes always ask, so a
 * delete's Approve remembers nothing. Always approve sets the account toggle for the card's kind.
 * Every line that shows the summary wraps anywhere: a keyword sample can reach ~1.5 KB, and a single
 * 512-character keyword has no spaces. A live card's group is named by its own summary (so two
 * cards are told apart) and carries `data-approval-id`, which the thread uses to move focus to the
 * next open card after an answer.
 */
export function ApprovalCard({ part, names, interactive, busy, onAnswer, record }: {
  part: ToolUIPart; names: ApprovalNames; interactive: boolean; busy: boolean; onAnswer: (a: ApprovalAnswer) => void;
  /** What the member chose, known only to the tab that clicked (the server stores the outcome, not the remember choice). */
  record?: 'chat' | 'always' | null;
}) {
  const summaryId = useId(); // before any early return (rules of hooks)
  const approval = part.approval;
  if (!approval) return null;
  const approvalId = approval.id;
  const toolName = getToolName(part);
  const isDelete = writeKind(toolName) === 'delete';
  const summary = summarizeApproval(toolName, part.input, names);
  if (part.state !== 'approval-requested') {
    const label = part.state === 'output-denied' || approval.approved === false
      ? 'Denied'
      : record === 'chat' ? 'Approved for this chat' : record === 'always' ? 'Always approved' : 'Approved';
    return <p className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 wrap-anywhere"><span className="font-medium">{label}</span> — {summary}</p>;
  }
  if (!interactive) {
    return <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 wrap-anywhere"><span className="font-medium">Waiting for an answer</span> — {summary}</p>;
  }
  return (
    <div role="group" aria-labelledby={summaryId} data-approval-id={approvalId} className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-slate-800">
      <p id={summaryId} className="wrap-anywhere">{summary}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => onAnswer({ approvalId, approved: false, remember: null })} className={SECONDARY}>Deny</button>
        <button type="button" disabled={busy} onClick={() => onAnswer({ approvalId, approved: true, remember: isDelete ? null : 'chat' })} className={`${BUTTON} bg-[#0B1E3A] text-white`}>
          {isDelete ? 'Approve this delete' : 'Approve for this chat'}
        </button>
        <button type="button" disabled={busy} onClick={() => onAnswer({ approvalId, approved: true, remember: 'always' })} className={SECONDARY}>
          {isDelete ? 'Always approve deletes' : 'Always approve changes'}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">You can turn this off in the chat&apos;s settings.</p>
    </div>
  );
}

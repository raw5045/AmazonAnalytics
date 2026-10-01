import { describe, it, expect } from 'vitest';
import { APPROVAL_RESULT_PREFIX, approvalOutcomeMessage, isApprovalResultMessage, pendingApprovals, respondedParts } from './approvals';
import type { AskUIMessage } from './conversations';

// Fixtures are checked against the SDK's part union (`satisfies`, never `as never`), so one that
// drifts from the shape the turn stores fails typecheck instead of passing on a made-up shape.
type Part = AskUIMessage['parts'][number];

const requested = {
  type: 'tool-create_saved_view', toolCallId: 'call_1', state: 'approval-requested',
  input: { name: 'Lamps', search: {} }, approval: { id: 'ap_1' },
} satisfies Part;
const assistant: AskUIMessage = { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Saving that now.' }, requested] };

describe('pendingApprovals', () => {
  it('lists the approval-requested tool parts of an assistant message, with their ids and inputs, in part order', () => {
    expect(pendingApprovals(assistant)).toEqual([{ messageId: 'm2', toolCallId: 'call_1', approvalId: 'ap_1', toolName: 'create_saved_view', input: { name: 'Lamps', search: {} } }]);
    const second = { ...requested, type: 'tool-add_to_watchlist', toolCallId: 'call_2', input: { keywords: ['desk lamp'], searchTermIds: [] }, approval: { id: 'ap_2' } } satisfies Part;
    expect(pendingApprovals({ ...assistant, parts: [...assistant.parts, second] }).map((p) => p.approvalId)).toEqual(['ap_1', 'ap_2']);
  });
  it('is empty for a user message, a text-only answer, or a part already answered', () => {
    expect(pendingApprovals({ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] })).toEqual([]);
    expect(pendingApprovals({ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'done' }] })).toEqual([]);
    expect(pendingApprovals({ ...assistant, parts: [{ ...requested, state: 'output-denied', approval: { id: 'ap_1', approved: false } }] })).toEqual([]);
  });
});

describe('respondedParts', () => {
  it('an approved answer with its output becomes output-available and keeps the approval record', () => {
    const parts = respondedParts(assistant.parts, 'ap_1', true, { view: { id: 'v1' } });
    expect(parts[1]).toEqual({ ...requested, state: 'output-available', output: { view: { id: 'v1' } }, approval: { id: 'ap_1', approved: true } });
    expect(parts[0]).toEqual(assistant.parts[0]);
  });
  it('a denied answer becomes output-denied', () => {
    expect(respondedParts(assistant.parts, 'ap_1', false)[1]).toEqual({ ...requested, state: 'output-denied', approval: { id: 'ap_1', approved: false } });
  });
  it('leaves other parts and other approval ids untouched', () => {
    expect(respondedParts(assistant.parts, 'ap_other', true, {})).toEqual(assistant.parts);
  });
});

describe('the hidden outcome message', () => {
  it('reports an approved run with the tool name and its result, under the prefix', () => {
    const m = approvalOutcomeMessage([{ toolName: 'create_saved_view', approved: true, output: { view: { id: 'v1', name: 'Lamps' } } }]);
    expect(m.role).toBe('user');
    expect(m.parts).toEqual([{ type: 'text', text: `${APPROVAL_RESULT_PREFIX} The person approved create_saved_view and it ran. Result: {"view":{"id":"v1","name":"Lamps"}}` }]);
    expect(isApprovalResultMessage(m)).toBe(true);
  });
  it('reports a denial and tells the model not to retry', () => {
    const m = approvalOutcomeMessage([{ toolName: 'delete_saved_view', approved: false }]);
    expect(m.parts).toEqual([{ type: 'text', text: `${APPROVAL_RESULT_PREFIX} The person denied delete_saved_view. Continue without it and do not retry it or try another way to get the same result.` }]);
  });
  it('reports an approved run whose tool answered with an error as a failure, never as "it ran"', () => {
    const m = approvalOutcomeMessage([{ toolName: 'create_saved_view', approved: true, output: { error: { code: 'DUPLICATE_NAME', message: 'You already have a view named "Lamps".', retryable: false } } }]);
    expect((m.parts[0] as { text: string }).text).toBe(`${APPROVAL_RESULT_PREFIX} The person approved create_saved_view but it failed: ${JSON.stringify({ code: 'DUPLICATE_NAME', message: 'You already have a view named "Lamps".', retryable: false })}`);
  });
  it('lists several outcomes, one line each, in the order given (the model can pause several calls in one step)', () => {
    const m = approvalOutcomeMessage([{ toolName: 'delete_saved_view', approved: true, output: { deleted: true } }, { toolName: 'delete_custom_category', approved: false }]);
    expect((m.parts[0] as { text: string }).text.split('\n')).toEqual([
      `${APPROVAL_RESULT_PREFIX} The person approved delete_saved_view and it ran. Result: {"deleted":true}`,
      'The person denied delete_custom_category. Continue without it and do not retry it or try another way to get the same result.',
    ]);
    expect(isApprovalResultMessage(m)).toBe(true);
  });
  it('caps a huge result at 20,000 characters', () => {
    const m = approvalOutcomeMessage([{ toolName: 'add_to_watchlist', approved: true, output: { big: 'x'.repeat(30_000) } }]);
    expect((m.parts[0] as { text: string }).text.length).toBeLessThanOrEqual(20_000 + 200);
    expect((m.parts[0] as { text: string }).text.endsWith('…')).toBe(true);
  });
  it('never leaves half an emoji at the cut (a lone surrogate is not valid UTF-8)', () => {
    // `{"kk":"` is 7 UTF-16 units, so the 20,000-unit cut lands between the two halves of an emoji.
    const m = approvalOutcomeMessage([{ toolName: 'add_to_watchlist', approved: true, output: { kk: '😀'.repeat(15_000) } }]);
    const text = (m.parts[0] as { text: string }).text;
    expect(text.isWellFormed()).toBe(true);
    expect(text.endsWith('…')).toBe(true);
  });
  it('isApprovalResultMessage is false for an ordinary user message and for an assistant message', () => {
    expect(isApprovalResultMessage({ role: 'user', parts: [{ type: 'text', text: 'please save it' }] })).toBe(false);
    expect(isApprovalResultMessage({ role: 'assistant', parts: [{ type: 'text', text: `${APPROVAL_RESULT_PREFIX} x` }] })).toBe(false);
  });
});

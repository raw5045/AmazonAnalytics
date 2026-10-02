import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApprovalCard } from './ApprovalCard';

const names = { views: {}, categories: {} };
const requested = { type: 'tool-create_saved_view', toolCallId: 'c1', state: 'approval-requested', input: { name: 'Lamps', search: {} }, approval: { id: 'ap_1' } } as never;
const del = { type: 'tool-delete_saved_view', toolCallId: 'c2', state: 'approval-requested', input: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, approval: { id: 'ap_2' } } as never;

describe('ApprovalCard (spec 2026-10-01 §5)', () => {
  it('a change card: summary, Deny / Approve for this chat / Always approve changes, and the answers it sends', () => {
    const onAnswer = vi.fn();
    render(<ApprovalCard part={requested} names={names} interactive busy={false} onAnswer={onAnswer} />);
    expect(screen.getByText('Save a view named ‘Lamps’')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve for this chat' }));
    expect(onAnswer).toHaveBeenLastCalledWith({ approvalId: 'ap_1', approved: true, remember: 'chat' });
    fireEvent.click(screen.getByRole('button', { name: 'Always approve changes' }));
    expect(onAnswer).toHaveBeenLastCalledWith({ approvalId: 'ap_1', approved: true, remember: 'always' });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onAnswer).toHaveBeenLastCalledWith({ approvalId: 'ap_1', approved: false, remember: null });
    expect(screen.getByText('You can turn this off in the chat\'s settings.')).toBeInTheDocument();
  });
  it('a delete card: Approve this delete sends no remember; Always approve deletes sends always; the name comes from the lookup', () => {
    const onAnswer = vi.fn();
    render(<ApprovalCard part={del} names={{ views: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'Lamps' }, categories: {} }} interactive busy={false} onAnswer={onAnswer} />);
    expect(screen.getByText('Delete the view ‘Lamps’ — permanent')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve this delete' }));
    expect(onAnswer).toHaveBeenLastCalledWith({ approvalId: 'ap_2', approved: true, remember: null });
    fireEvent.click(screen.getByRole('button', { name: 'Always approve deletes' }));
    expect(onAnswer).toHaveBeenLastCalledWith({ approvalId: 'ap_2', approved: true, remember: 'always' });
  });
  it('disabled while busy, and read-only (no buttons) when not interactive', () => {
    const { rerender } = render(<ApprovalCard part={requested} names={names} interactive busy onAnswer={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
    rerender(<ApprovalCard part={requested} names={names} interactive={false} busy={false} onAnswer={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Waiting for an answer')).toBeInTheDocument();
  });
  it('collapses to a record once answered', () => {
    const answered = (state: string, approved: boolean, extra: Record<string, unknown> = {}) => ({ ...(requested as object), state, approval: { id: 'ap_1', approved }, ...extra }) as never;
    const { rerender } = render(<ApprovalCard part={answered('approval-responded', true)} names={names} interactive busy={false} onAnswer={vi.fn()} record="chat" />);
    expect(screen.getByText('Approved for this chat')).toBeInTheDocument();
    rerender(<ApprovalCard part={answered('output-available', true, { output: {} })} names={names} interactive busy={false} onAnswer={vi.fn()} />);
    expect(screen.getByText('Approved')).toBeInTheDocument();
    rerender(<ApprovalCard part={answered('output-denied', false)} names={names} interactive busy={false} onAnswer={vi.fn()} />);
    expect(screen.getByText('Denied')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('a Deny answered here (approval-responded, approved: false) reads "Denied" before the server records it', () => {
    const deniedHere = { ...(requested as object), state: 'approval-responded', approval: { id: 'ap_1', approved: false } } as never;
    render(<ApprovalCard part={deniedHere} names={names} interactive busy={false} onAnswer={vi.fn()} record={null} />);
    expect(screen.getByText('Denied')).toBeInTheDocument();
    expect(screen.queryByText(/Approved/)).toBeNull();
  });
  it('the live card\'s group is labelled by its own summary, so two cards are told apart', () => {
    render(<><ApprovalCard part={requested} names={names} interactive busy={false} onAnswer={vi.fn()} /><ApprovalCard part={del} names={names} interactive busy={false} onAnswer={vi.fn()} /></>);
    expect(screen.getByRole('group', { name: 'Save a view named ‘Lamps’' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Delete the view …aaaaaaaa — permanent' })).toBeInTheDocument();
  });
  it('an "Always approve" answer reads "Always approved" once answered, and every summary line wraps anywhere (a 512-character keyword has no spaces)', () => {
    const answered = { ...(requested as object), state: 'approval-responded', approval: { id: 'ap_1', approved: true } } as never;
    const { container, rerender } = render(<ApprovalCard part={answered} names={names} interactive busy={false} onAnswer={vi.fn()} record="always" />);
    expect(screen.getByText('Always approved')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('wrap-anywhere');
    rerender(<ApprovalCard part={requested} names={names} interactive={false} busy={false} onAnswer={vi.fn()} />);
    expect(container.firstElementChild).toHaveClass('wrap-anywhere');
    rerender(<ApprovalCard part={requested} names={names} interactive busy={false} onAnswer={vi.fn()} />);
    expect(screen.getByText('Save a view named ‘Lamps’')).toHaveClass('wrap-anywhere');
  });
  it('renders nothing for a tool part without an approval', () => {
    const plain = { type: 'tool-list_saved_views', toolCallId: 'c3', state: 'output-available', input: {}, output: {} } as never;
    const { container } = render(<ApprovalCard part={plain} names={names} interactive busy={false} onAnswer={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Composer } from './Composer';

function setup(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn(); const onStop = vi.fn(); const onChange = vi.fn();
  render(<Composer value={props.value ?? 'hello'} onChange={onChange} onSend={onSend} onStop={onStop} streaming={false} disabled={false} sendDisabled={false} disabledReason={null} {...props} />);
  return { onSend, onStop, onChange };
}
describe('Composer', () => {
  it('sends on Enter, not on Shift+Enter, and trims', () => {
    const { onSend } = setup({ value: '  hi  ' });
    const box = screen.getByLabelText('Your question');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hi');
  });
  it('shows the counter from 3,500 characters and blocks past 4,000', () => {
    setup({ value: 'x'.repeat(3600) });
    expect(screen.getByText('400 left')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });
  it('shows Stop while streaming and the disabled reason under the box', () => {
    const { onStop } = setup({ streaming: true });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalled();
    setup({ disabled: true, disabledReason: 'This chat is full. Start a new one.' });
    expect(screen.getByRole('status')).toHaveTextContent('This chat is full. Start a new one.');
  });
  it('always shows the accuracy notice', () => {
    setup();
    expect(screen.getByText('Answers can be wrong. Check the numbers on the keyword pages before acting.')).toBeInTheDocument();
  });
  it('does not send on the Enter that confirms an IME composition (item 7)', () => {
    const { onSend } = setup();
    const box = screen.getByLabelText('Your question');
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello');
  });
  it('sendDisabled disables only Send — the textarea stays enabled (item 10 M5)', () => {
    setup({ sendDisabled: true });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByLabelText('Your question')).toBeEnabled();
  });
});

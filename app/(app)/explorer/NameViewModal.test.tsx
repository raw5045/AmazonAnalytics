import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { NameViewModal } from './NameViewModal';

type Props = ComponentProps<typeof NameViewModal>;

function renderModal(overrides: Partial<Props> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const base: Props = { isOpen: true, title: 'Name view', onSubmit, onClose };
  const utils = render(<NameViewModal {...base} {...overrides} />);
  return { ...utils, onSubmit, onClose, base };
}

const input = () => screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
const submitForm = () => fireEvent.submit(input().closest('form') as HTMLFormElement);

describe('NameViewModal', () => {
  it('renders nothing while closed', () => {
    const { container } = renderModal({ isOpen: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('starts from initialName and takes a new initialName when reopened', () => {
    const { rerender, base } = renderModal({ initialName: 'Beauty' });
    expect(input().value).toBe('Beauty');
    fireEvent.change(input(), { target: { value: 'Edited' } });
    expect(input().value).toBe('Edited');
    rerender(<NameViewModal {...base} isOpen={false} initialName="Beauty" />);
    rerender(<NameViewModal {...base} isOpen initialName="Garden" />);
    expect(input().value).toBe('Garden');
  });

  it('reopening after a validation error starts clean', () => {
    const { rerender, base, onSubmit } = renderModal({ initialName: '' });
    fireEvent.change(input(), { target: { value: '   ' } });
    submitForm();
    expect(screen.getByText('Name cannot be empty')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(<NameViewModal {...base} isOpen={false} />);
    rerender(<NameViewModal {...base} isOpen />);
    expect(screen.queryByText('Name cannot be empty')).not.toBeInTheDocument();
    expect(input().value).toBe('');
  });

  it('submits the trimmed name and closes on Escape', () => {
    const { onSubmit, onClose } = renderModal({ initialName: '' });
    fireEvent.change(input(), { target: { value: '  Lamps  ' } });
    submitForm();
    expect(onSubmit).toHaveBeenCalledWith('Lamps');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

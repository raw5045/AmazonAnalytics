// app/(app)/ask/ModelPicker.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelLabel, ModelPicker, MODEL_FIXED_NOTE } from './ModelPicker';

describe('ModelPicker (spec 2026-10-04 §5)', () => {
  it('is a select named Model with the three models, notes in the option text, the fixed-model sentence as its description', () => {
    const onChange = vi.fn();
    render(<ModelPicker value="claude-sonnet-5" onChange={onChange} disabled={false} />);
    const select = screen.getByRole('combobox', { name: 'Model' });
    expect(select).toHaveValue('claude-sonnet-5');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Standard (Sonnet 5)', 'Advanced (Opus 5.5), uses about twice the usage', 'Quick (Haiku 4.5), uses about half',
    ]);
    expect(select).toHaveAccessibleDescription(MODEL_FIXED_NOTE);
    fireEvent.change(select, { target: { value: 'claude-opus-5-5' } });
    expect(onChange).toHaveBeenCalledWith('claude-opus-5-5');
  });
  it('can be disabled; ModelLabel shows an open chat\'s fixed model', () => {
    render(<ModelPicker value="claude-sonnet-5" onChange={vi.fn()} disabled />);
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();
    render(<ModelLabel model="claude-haiku-4-5" />);
    expect(screen.getByText('Quick (Haiku 4.5)')).toBeInTheDocument();
    expect(screen.getByText('· fixed for this chat')).toBeInTheDocument();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LeafCategoryTypeahead } from './LeafCategoryTypeahead';

const OPTIONS = ['A › Lamps', 'A › Lanterns', 'A › Light Bulbs', 'B › Solar Lights'];

function setup(selected: string[] = []) {
  const onChange = vi.fn();
  const utils = render(<LeafCategoryTypeahead options={OPTIONS} selected={selected} onChange={onChange} />);
  const input = screen.getByLabelText('Add leaf category');
  return { ...utils, onChange, input };
}

describe('LeafCategoryTypeahead highlight', () => {
  it('ArrowDown moves the highlight and Enter adds the highlighted match', () => {
    const { onChange, input } = setup();
    fireEvent.change(input, { target: { value: 'l' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Lanterns/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['A › Lanterns']);
  });

  it('keeps the highlight valid when the parent shrinks the match list', () => {
    const { onChange, input, rerender } = setup();
    fireEvent.change(input, { target: { value: 'l' } });
    for (let i = 0; i < 3; i++) fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Solar Lights/ })).toHaveAttribute('aria-selected', 'true');
    const picked = ['A › Lamps', 'A › Lanterns', 'B › Solar Lights'];
    rerender(<LeafCategoryTypeahead options={OPTIONS} selected={picked} onChange={onChange} />);
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Light Bulbs/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith([...picked, 'A › Light Bulbs']);
  });
});

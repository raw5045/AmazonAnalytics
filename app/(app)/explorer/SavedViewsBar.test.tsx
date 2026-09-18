import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SavedViewsBar } from './SavedViewsBar';

const nav = vi.hoisted(() => ({ pathname: '/explorer' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

describe('SavedViewsBar', () => {
  it('hides off /explorer without unmounting its children, so their state survives a detail-page trip', () => {
    nav.pathname = '/explorer';
    const { rerender } = render(
      <SavedViewsBar>
        <input aria-label="probe" />
      </SavedViewsBar>,
    );
    const input = screen.getByLabelText('probe');
    fireEvent.change(input, { target: { value: 'kept' } });
    expect(input.closest('div')).toHaveClass('flex');
    expect(input.closest('div')).not.toHaveClass('hidden');

    nav.pathname = '/explorer/keyword/abc';
    rerender(
      <SavedViewsBar>
        <input aria-label="probe" />
      </SavedViewsBar>,
    );
    expect(screen.getByLabelText('probe')).toHaveValue('kept');
    expect(screen.getByLabelText('probe').closest('div')).toHaveClass('hidden');

    nav.pathname = '/explorer';
    rerender(
      <SavedViewsBar>
        <input aria-label="probe" />
      </SavedViewsBar>,
    );
    expect(screen.getByLabelText('probe')).toHaveValue('kept');
    expect(screen.getByLabelText('probe').closest('div')).toHaveClass('flex');
  });
});

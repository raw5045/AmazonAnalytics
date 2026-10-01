import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';
import { buildViewHref } from '@/lib/savedViews/serialize';
import type { SavedView } from '@/lib/savedViews/types';

// This whole file pins useTransition to "pending" (a pick whose navigation has not
// committed yet), so it lives apart from SavedViewsControls.test.tsx, whose picker
// tests run the real hook. The pinned startTransition logs around its callback and
// router.push logs its call, so the log shows whether the push runs inside it.
const { calls, push } = vi.hoisted(() => {
  const calls: string[] = [];
  return { calls, push: (href: string) => { calls.push(`push ${href}`); } };
});
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useTransition: () => [
    true,
    (fn: () => void) => {
      calls.push('transition start');
      fn();
      calls.push('transition end');
    },
  ],
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { SavedViewsDropdown } from './SavedViewsDropdown';

const view: SavedView = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Lamps under 500',
  filters: EXPLORER_DEFAULTS,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('SavedViewsDropdown while a pick is in flight', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('spins the loading overlay, portaled into <body>, and marks the picker busy', () => {
    render(<SavedViewsDropdown views={[view]} />);
    const overlay = screen.getByRole('status');
    expect(overlay).toHaveTextContent('Loading');
    // Outside the saved-views bar's sticky z-20 stacking context, so it covers the z-30 top nav too.
    expect(overlay.parentElement).toBe(document.body);
    expect(screen.getByTitle('Pick a saved view')).toHaveAttribute('aria-busy', 'true');
  });

  it('pushes the picked view from inside the transition, so isPending tracks its navigation', () => {
    render(<SavedViewsDropdown views={[view]} />);
    fireEvent.click(screen.getByTitle('Pick a saved view'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Lamps under 500'));
    expect(calls).toEqual(['transition start', `push ${buildViewHref(view)}`, 'transition end']);
  });
});

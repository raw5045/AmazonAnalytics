import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';
import type { SavedView } from '@/lib/savedViews/types';

// This whole file pins useTransition to "pending" (a pick whose navigation has not
// committed yet), so it lives apart from SavedViewsControls.test.tsx, whose picker
// tests run the real hook.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useTransition: () => [true, (fn: () => void) => fn()],
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
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
  it('spins the loading overlay and marks the picker busy', () => {
    render(<SavedViewsDropdown views={[view]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.getByTitle('Pick a saved view')).toHaveAttribute('aria-busy', 'true');
  });
});

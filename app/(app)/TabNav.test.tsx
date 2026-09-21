import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ usePathname: () => '/explorer', useSearchParams: () => new URLSearchParams() }));

import { TabNav } from './TabNav';

describe('TabNav', () => {
  it('shows the Connect AI tab only when the account is eligible', async () => {
    const { unmount } = render(<TabNav watchlistCountPromise={Promise.resolve(0)} showConnectAi={false} />);
    await act(async () => {});
    expect(screen.queryByRole('link', { name: /connect ai/i })).toBeNull();
    unmount();

    render(<TabNav watchlistCountPromise={Promise.resolve(0)} showConnectAi />);
    await act(async () => {});
    expect(screen.getByRole('link', { name: /connect ai/i })).toHaveAttribute('href', '/connect-ai');
  });
});

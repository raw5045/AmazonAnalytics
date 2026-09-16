import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@clerk/nextjs', () => ({
  SignOutButton: ({ children }: { children?: React.ReactNode }) => <>{children ?? <button type="button">Sign out</button>}</>,
}));

import { AccountProblem } from './AccountProblem';

describe('AccountProblem', () => {
  it('explains the problem, offers sign-out, and points at support', () => {
    render(<AccountProblem message="This account no longer exists." />);
    expect(screen.getByRole('heading', { name: /couldn.t load your account/i })).toBeInTheDocument();
    expect(screen.getByText('This account no longer exists.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /support@keywordquarry\.com/i })).toHaveAttribute(
      'href',
      'mailto:support@keywordquarry.com',
    );
  });
});

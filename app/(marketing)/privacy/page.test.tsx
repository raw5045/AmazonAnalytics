import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PrivacyPage from './page';

describe('Privacy page — Ask AI', () => {
  it('discloses chat storage and Anthropic as the AI processor', () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/Ask AI chats\./)).toBeInTheDocument();
    expect(screen.getAllByText(/Anthropic/).length).toBeGreaterThan(0);
    expect(screen.getByText(/does not use it to train its models/)).toBeInTheDocument();
  });
});

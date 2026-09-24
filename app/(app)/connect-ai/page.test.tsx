import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({
  requireAuthenticatedUser: async () => ({ id: 'user-1', role: 'user', email: 'member@example.com' }),
}));
vi.mock('@/lib/mcp/connections', () => ({ getMcpConnection: async () => null }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

import ConnectAiPage from './page';

describe('Connect AI page credentials', () => {
  beforeEach(() => {
    envMock.env = { APP_PUBLIC_URL: 'https://keywordquarry.com', MCP_ENABLED: '1', MCP_AUDIENCE: 'all' };
  });

  it('shows each client its ID and secret inline and drops the "ask us" line when both are configured', async () => {
    envMock.env.MCP_CLIENT_SECRET_CLAUDE = 'claude-secret-123';
    envMock.env.MCP_CLIENT_SECRET_CHATGPT = 'chatgpt-secret-456';
    render(await ConnectAiPage());
    expect(screen.getByText('16oat62Xksi7U2Ri')).toBeInTheDocument();
    expect(screen.getByText('claude-secret-123')).toBeInTheDocument();
    expect(screen.getByText('WzrKBzjxqjhn2pUR')).toBeInTheDocument();
    expect(screen.getByText('chatgpt-secret-456')).toBeInTheDocument();
    expect(screen.queryByText(/ask through the feedback button/i)).not.toBeInTheDocument();
  });

  it('falls back to the "ask us" line for a client whose secret is not configured', async () => {
    envMock.env.MCP_CLIENT_SECRET_CLAUDE = 'claude-secret-123';
    render(await ConnectAiPage());
    expect(screen.getByText('claude-secret-123')).toBeInTheDocument();
    expect(screen.getByText('WzrKBzjxqjhn2pUR')).toBeInTheDocument();
    expect(screen.getByText(/ask through the feedback button/i)).toBeInTheDocument();
  });
});

describe('Connect AI page example questions', () => {
  beforeEach(() => {
    envMock.env = { APP_PUBLIC_URL: 'https://keywordquarry.com', MCP_ENABLED: '1', MCP_AUDIENCE: 'all' };
  });

  it('shows the first example openly and the other seven behind a disclosure', async () => {
    render(await ConnectAiPage());
    const first = screen.getByText(/highest volume keywords in the lighting niche/i);
    expect(first.closest('details')).toBeNull();
    const details = screen.getByText('Show more example questions').closest('details');
    expect(details).not.toBeNull();
    expect(details!.querySelectorAll('li')).toHaveLength(7);
    expect(screen.getByText(/gained the most search volume/i).closest('details')).toBe(details);
    expect(screen.getByText(/under pet supplies/i).closest('details')).toBe(details);
  });
});

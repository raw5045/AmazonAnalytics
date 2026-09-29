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

  it('shows ChatGPT its ID and secret inline and drops the "ask us" line when the secret is configured', async () => {
    envMock.env.MCP_CLIENT_SECRET_CLAUDE = 'claude-secret-123';
    envMock.env.MCP_CLIENT_SECRET_CHATGPT = 'chatgpt-secret-456';
    render(await ConnectAiPage());
    expect(screen.getByText('WzrKBzjxqjhn2pUR')).toBeInTheDocument();
    expect(screen.getByText('chatgpt-secret-456')).toBeInTheDocument();
    expect(screen.queryByText(/ask through the feedback button/i)).not.toBeInTheDocument();
  });

  it('never shows the Claude credentials any more (Claude signs in on its own)', async () => {
    envMock.env.MCP_CLIENT_SECRET_CLAUDE = 'claude-secret-123';
    envMock.env.MCP_CLIENT_SECRET_CHATGPT = 'chatgpt-secret-456';
    render(await ConnectAiPage());
    expect(screen.queryByText('16oat62Xksi7U2Ri')).toBeNull();
    expect(screen.queryByText('claude-secret-123')).toBeNull();
    expect(screen.queryByText(/Advanced settings/)).toBeNull();
  });

  it('falls back to the "ask us" line when the ChatGPT secret is not configured', async () => {
    render(await ConnectAiPage());
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

  it('sits above the Server URL card so the benefit shows before the setup', async () => {
    render(await ConnectAiPage());
    const tryAsking = screen.getByRole('heading', { name: 'Try asking' });
    const serverUrl = screen.getByRole('heading', { name: 'Server URL' });
    expect(tryAsking.compareDocumentPosition(serverUrl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('Connect AI page setup steps', () => {
  beforeEach(() => {
    envMock.env = { APP_PUBLIC_URL: 'https://keywordquarry.com', MCP_ENABLED: '1', MCP_AUDIENCE: 'all' };
  });

  it('gives Claude four steps (name, URL, Add, Connect) and says the desktop app works the same', async () => {
    render(await ConnectAiPage());
    expect(screen.getByRole('heading', { name: 'Claude (claude.ai or the desktop app)' })).toBeInTheDocument();
    expect(screen.getByText('Customize → Connectors → + → Add custom connector.')).toBeInTheDocument();
    expect(screen.getByText('Name it KeywordQuarry, paste the server URL above, and click Add.')).toBeInTheDocument();
    expect(screen.getByText('Connect, then approve the KeywordQuarry sign-in screen.')).toBeInTheDocument();
    expect(screen.getByText(/Works the same in the desktop app.s Chat and Code tabs/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Claude Code/ })).toBeNull();
    expect(screen.queryByText(/claude mcp add/)).toBeNull();
  });

  it('shows the troubleshooting card with the status page first', async () => {
    render(await ConnectAiPage());
    expect(screen.getByRole('heading', { name: "If it won\u2019t connect" })).toBeInTheDocument();
    expect(screen.getByText(/Check status\.claude\.com or status\.openai\.com first/)).toBeInTheDocument();
    expect(screen.getByText(/The connection only works for KeywordQuarry/)).toBeInTheDocument();
  });
});

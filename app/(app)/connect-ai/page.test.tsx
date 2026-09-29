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

  it('walks the chat door (Connectors) with Advanced settings left empty and points at the Code tab', async () => {
    render(await ConnectAiPage());
    expect(screen.getByRole('heading', { name: /^Claude \(claude\.ai or the desktop app/ })).toBeInTheDocument();
    expect(screen.getByText('Customize → Connectors → + → Add custom connector.')).toBeInTheDocument();
    expect(screen.getByText(/Leave Advanced settings empty/)).toBeInTheDocument();
    expect(screen.getByText(/also shows up in the desktop app.s Code tab, under \+ → Connectors/)).toBeInTheDocument();
  });

  it('keeps the pre-registered credentials only behind an optional disclosure', async () => {
    envMock.env.MCP_CLIENT_SECRET_CLAUDE = 'claude-secret-123';
    render(await ConnectAiPage());
    const summary = screen.getByText('Advanced settings (optional, older setups)');
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    expect(details).toContainElement(screen.getByText('16oat62Xksi7U2Ri'));
    expect(details).toContainElement(screen.getByText('claude-secret-123'));
  });

  it('walks the Code tab door: the custom MCP form, empty token and headers, then /mcp to authenticate', async () => {
    render(await ConnectAiPage());
    expect(screen.getByRole('heading', { name: /^Claude Code \(the desktop app/ })).toBeInTheDocument();
    expect(screen.getByText('In the Code tab: Plugins → Add → Add MCP server → Connect to a custom MCP.')).toBeInTheDocument();
    expect(screen.getByText(/Type: Streamable HTTP\. URL: the server URL above\. Leave the bearer token and/)).toBeInTheDocument();
    expect(screen.getByText('claude mcp add --transport http keywordquarry https://keywordquarry.com/api/mcp')).toBeInTheDocument();
    expect(screen.getAllByText('/mcp').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the troubleshooting card with the status page first', async () => {
    render(await ConnectAiPage());
    expect(screen.getByRole('heading', { name: "If it won\u2019t connect" })).toBeInTheDocument();
    expect(screen.getByText(/Check status\.claude\.com or status\.openai\.com first/)).toBeInTheDocument();
    expect(screen.getByText(/The connection only works for KeywordQuarry/)).toBeInTheDocument();
  });
});

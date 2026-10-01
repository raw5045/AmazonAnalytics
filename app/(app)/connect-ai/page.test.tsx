import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
const authMock = vi.hoisted(() => ({ role: 'user' }));
vi.mock('@/lib/env', () => envMock);
vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({
  requireAuthenticatedUser: async () => ({ id: 'user-1', role: authMock.role, email: 'member@example.com' }),
}));
vi.mock('@/lib/mcp/connections', () => ({ getMcpConnection: async () => null }));
vi.mock('@/lib/ask/ledger', () => ({ getAccount: async () => null }));
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

  it('shows no client id or secret anywhere, even when both secrets are configured (clients sign in on their own)', async () => {
    envMock.env.MCP_CLIENT_SECRET_CLAUDE = 'claude-secret-123';
    envMock.env.MCP_CLIENT_SECRET_CHATGPT = 'chatgpt-secret-456';
    render(await ConnectAiPage());
    for (const leaked of ['16oat62Xksi7U2Ri', 'claude-secret-123', 'WzrKBzjxqjhn2pUR', 'chatgpt-secret-456']) {
      expect(screen.queryByText(leaked)).toBeNull();
    }
    expect(screen.queryByText(/Advanced settings/)).toBeNull();
    expect(screen.queryByText(/client ID/i)).toBeNull();
    expect(screen.queryByText(/ask through the feedback button/i)).toBeNull();
  });

  it('gives ChatGPT four steps through its Plugins page', async () => {
    render(await ConnectAiPage());
    expect(screen.getByRole('heading', { name: 'ChatGPT' })).toBeInTheDocument();
    expect(screen.getByText(/Requires a paid ChatGPT plan with Developer mode on/)).toBeInTheDocument();
    expect(screen.getByText('Go to chatgpt.com/plugins, click +, name it KeywordQuarry, paste the server URL above, and Create.')).toBeInTheDocument();
    expect(screen.queryByText(/User-Defined OAuth Client/)).toBeNull();
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
    expect(screen.getAllByText('Connect, then approve the KeywordQuarry sign-in screen.')).toHaveLength(2); // Claude and ChatGPT
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

describe('Connect AI page → Ask AI link', () => {
  beforeEach(() => {
    envMock.env = { APP_PUBLIC_URL: 'https://keywordquarry.com', MCP_ENABLED: '1', MCP_AUDIENCE: 'all', ASK_AI_ENABLED: '1' };
    authMock.role = 'admin';
  });

  it('shows the link to an eligible admin account when Ask AI is on', async () => {
    render(await ConnectAiPage());
    expect(screen.getByRole('link', { name: 'Prefer to chat here? Try Ask AI.' })).toHaveAttribute('href', '/ask');
  });

  it('hides the link for a plain user with no ask account', async () => {
    authMock.role = 'user';
    render(await ConnectAiPage());
    expect(screen.queryByRole('link', { name: 'Prefer to chat here? Try Ask AI.' })).toBeNull();
  });

  it('hides the link for an admin when Ask AI is switched off', async () => {
    envMock.env.ASK_AI_ENABLED = '0';
    render(await ConnectAiPage());
    expect(screen.queryByRole('link', { name: 'Prefer to chat here? Try Ask AI.' })).toBeNull();
  });
});

describe('Connect AI page with the workspace tools on (spec 2026-09-30 §9.3)', () => {
  beforeEach(() => {
    envMock.env = { APP_PUBLIC_URL: 'https://keywordquarry.com', MCP_ENABLED: '1', MCP_AUDIENCE: 'all', MCP_WRITE_ENABLED: '1' };
    authMock.role = 'user'; // a member, whatever the Ask AI describe above left behind
  });

  it('says the AI can save with approval, and adds the three workspace prompts behind the disclosure', async () => {
    render(await ConnectAiPage());
    expect(screen.getByText(/with your approval each time, save views, build custom categories and edit your watchlist/)).toBeInTheDocument();
    expect(screen.queryByText(/The connection is read-only/)).toBeNull();
    const details = screen.getByText('Show more example questions').closest('details')!;
    expect(details.querySelectorAll('li')).toHaveLength(10);
    expect(screen.getByText('With saving on, also try').closest('details')).toBe(details);
    expect(screen.getByText(/Add the top 20 results to my watchlist/).closest('details')).toBe(details);
  });

  it('keeps the read-only wording and seven prompts while the flag is off', async () => {
    delete envMock.env.MCP_WRITE_ENABLED;
    render(await ConnectAiPage());
    expect(screen.getByText(/The connection is read-only/)).toBeInTheDocument();
    expect(screen.queryByText('With saving on, also try')).toBeNull();
    expect(screen.getByText('Show more example questions').closest('details')!.querySelectorAll('li')).toHaveLength(7);
  });
});

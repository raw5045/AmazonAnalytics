import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);

import {
  MCP_SCOPE,
  clerkFrontendApiUrl,
  mcpAllowedClientIds,
  mcpAudience,
  mcpClientLabel,
  mcpEnabled,
  mcpResourceUrl,
  resetMcpConfigWarningsForTests,
} from './config';

const PK_FOR = (host: string) => `pk_test_${Buffer.from(`${host}$`).toString('base64')}`;

describe('mcp config', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    envMock.env = {
      APP_PUBLIC_URL: 'https://keywordquarry.com',
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PK_FOR('clerk.keywordquarry.com'),
    };
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetMcpConfigWarningsForTests();
  });
  afterEach(() => warn.mockRestore());

  it('names the custom scope the Clerk authorization server must issue', () => {
    expect(MCP_SCOPE).toBe('keywordquarry:research:read');
  });

  it('is off unless MCP_ENABLED is exactly "1"', () => {
    expect(mcpEnabled()).toBe(false);
    envMock.env.MCP_ENABLED = 'true';
    expect(mcpEnabled()).toBe(false);
    envMock.env.MCP_ENABLED = '1';
    expect(mcpEnabled()).toBe(true);
  });

  it('defaults the audience to admin and only "all" widens it', () => {
    expect(mcpAudience()).toBe('admin');
    envMock.env.MCP_AUDIENCE = 'all';
    expect(mcpAudience()).toBe('all');
  });

  it('treats an unrecognised audience as admin and warns only once per process, not on every read', () => {
    envMock.env.MCP_AUDIENCE = 'everyone';
    expect(mcpAudience()).toBe('admin');
    expect(mcpAudience()).toBe('admin');
    expect(mcpAudience()).toBe('admin');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('MCP_AUDIENCE');
  });

  it('resetMcpConfigWarningsForTests lets the audience warning fire again', () => {
    envMock.env.MCP_AUDIENCE = 'everyone';
    expect(mcpAudience()).toBe('admin');
    expect(warn).toHaveBeenCalledTimes(1);
    resetMcpConfigWarningsForTests();
    expect(mcpAudience()).toBe('admin');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('parses the client allowlist as a trimmed comma list, empty when unset', () => {
    expect(mcpAllowedClientIds()).toEqual([]);
    envMock.env.MCP_ALLOWED_CLIENT_IDS = ' client_a, client_b ,,';
    expect(mcpAllowedClientIds()).toEqual(['client_a', 'client_b']);
  });

  it('derives the resource URL from APP_PUBLIC_URL, never from a request', () => {
    expect(mcpResourceUrl()).toBe('https://keywordquarry.com/api/mcp');
    envMock.env.APP_PUBLIC_URL = 'https://keywordquarry.com/';
    expect(mcpResourceUrl()).toBe('https://keywordquarry.com/api/mcp');
  });

  it('lets MCP_RESOURCE_URL override the resource URL when it is an absolute URL', () => {
    envMock.env.MCP_RESOURCE_URL = 'https://mcp.keywordquarry.com/api/mcp';
    expect(mcpResourceUrl()).toBe('https://mcp.keywordquarry.com/api/mcp');
  });

  it('ignores an override whose path is not exactly /api/mcp (the discovery documents live there alone)', () => {
    for (const bad of ['https://mcp.keywordquarry.com/api/mcp/', 'https://mcp.keywordquarry.com/mcp', 'https://mcp.keywordquarry.com/api/mcp?x=1']) {
      envMock.env.MCP_RESOURCE_URL = bad;
      expect(mcpResourceUrl()).toBe('https://keywordquarry.com/api/mcp');
    }
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('ignores a malformed MCP_RESOURCE_URL with a warning', () => {
    envMock.env.MCP_RESOURCE_URL = 'not a url';
    expect(mcpResourceUrl()).toBe('https://keywordquarry.com/api/mcp');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('MCP_RESOURCE_URL');
  });

  it('decodes the Clerk frontend-API host from the publishable key', () => {
    expect(clerkFrontendApiUrl()).toBe('https://clerk.keywordquarry.com');
    envMock.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_live_${Buffer.from('communal-lemming-47.clerk.accounts.dev$').toString('base64')}`;
    expect(clerkFrontendApiUrl()).toBe('https://communal-lemming-47.clerk.accounts.dev');
  });

  it('throws on a publishable key that does not decode to a host', () => {
    envMock.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_!!!';
    expect(() => clerkFrontendApiUrl()).toThrow(/publishable key/i);
  });

  it('labels the two pinned client ids and falls back to the raw id, or "unknown client" for null', () => {
    expect(mcpClientLabel('16oat62Xksi7U2Ri')).toBe('Claude');
    expect(mcpClientLabel('WzrKBzjxqjhn2pUR')).toBe('ChatGPT');
    expect(mcpClientLabel('some_other_client_id')).toBe('some_other_client_id');
    expect(mcpClientLabel(null)).toBe('unknown client');
  });
});

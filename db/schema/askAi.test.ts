import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getTableName } from 'drizzle-orm';
import { askConversations, askMessages, askAccounts, askLedger, askGlobalUsage } from './askAi';

describe('ask ai schema', () => {
  it('declares the five tables under the ask_ prefix', () => {
    expect([askConversations, askMessages, askAccounts, askLedger, askGlobalUsage].map(getTableName)).toEqual([
      'ask_conversations', 'ask_messages', 'ask_accounts', 'ask_ledger', 'ask_global_usage',
    ]);
  });
  it('the migration creates the same five tables, with cascades from users, in breakpoint-separated statements', () => {
    const sql = readFileSync('db/migrations/0048_ask_ai.sql', 'utf8');
    const statements = sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
    const creates = statements.filter((s) => /^CREATE TABLE IF NOT EXISTS ask_/.test(s));
    expect(creates.map((s) => s.match(/ask_\w+/)![0])).toEqual(['ask_conversations', 'ask_messages', 'ask_accounts', 'ask_ledger', 'ask_global_usage']);
    expect((sql.match(/REFERENCES users\(id\) ON DELETE CASCADE/g) ?? []).length).toBe(3);
    expect(sql).toContain('conversation_count');
    expect(sql).toContain("CHECK (role IN ('user','assistant'))");
  });
});

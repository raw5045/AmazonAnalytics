import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { askConversations, askMessages, askAccounts, askLedger, askGlobalUsage } from './askAi';

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '0048_ask_ai.sql');
const TABLES = [askConversations, askMessages, askAccounts, askLedger, askGlobalUsage];

function readMigration() {
  return readFileSync(MIGRATION_PATH, 'utf8');
}

function createStatements(sql: string) {
  return sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => /^CREATE TABLE IF NOT EXISTS ask_/.test(s));
}

describe('ask ai schema', () => {
  it('declares the five tables under the ask_ prefix', () => {
    expect(TABLES.map(getTableName)).toEqual([
      'ask_conversations', 'ask_messages', 'ask_accounts', 'ask_ledger', 'ask_global_usage',
    ]);
  });

  it('the migration creates the same five tables, with cascades from users, in breakpoint-separated statements', () => {
    const sql = readMigration();
    const creates = createStatements(sql);
    expect(creates.map((s) => s.match(/ask_\w+/)![0])).toEqual(['ask_conversations', 'ask_messages', 'ask_accounts', 'ask_ledger', 'ask_global_usage']);
    expect((sql.match(/REFERENCES users\(id\) ON DELETE CASCADE/g) ?? []).length).toBe(3);
    expect(creates[2]).toMatch(/conversation_count\s+integer NOT NULL DEFAULT 0/);
    expect(sql).toContain("CHECK (role IN ('user','assistant'))");
  });

  it('has no foreign key that lacks an explicit ON DELETE action', () => {
    // A default NO ACTION FK would abort the referencing delete/update instead of cascading or
    // nulling out — every REFERENCES in this migration must spell out its ON DELETE behavior.
    const sql = readMigration();
    expect(sql).not.toMatch(/REFERENCES \w+\(\w+\)(?! ON DELETE)/);
  });

  it('the ledger conversation_id carries no FK — append-only audit must survive a chat deleted mid-answer', () => {
    const creates = createStatements(readMigration());
    expect(creates[3]).toMatch(/conversation_id\s+uuid,/);
    expect(creates[3]).not.toMatch(/conversation_id\s+uuid REFERENCES/);
  });

  it('every Drizzle column, check, unique constraint and index name is mirrored in the SQL migration', () => {
    const sql = readMigration();
    const creates = createStatements(sql);

    TABLES.forEach((table, i) => {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        expect(creates[i]).toContain(column.name);
      }
      for (const c of config.checks) {
        expect(sql).toContain(`CONSTRAINT ${c.name}`);
      }
      for (const u of config.uniqueConstraints) {
        expect(sql).toContain(`CONSTRAINT ${u.name}`);
      }
      for (const idx of config.indexes) {
        expect(sql).toContain(`CREATE INDEX IF NOT EXISTS ${idx.config.name}`);
      }
    });
  });
});

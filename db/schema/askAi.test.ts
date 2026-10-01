import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { askConversations, askMessages, askAccounts, askLedger, askGlobalUsage } from './askAi';

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '0048_ask_ai.sql');
// Arc 4 (spec 2026-10-01 §7): 0049 adds columns to ask_accounts and ask_conversations with ALTER TABLE.
const ADD_COLUMNS_MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '0049_ask_writes.sql');
const TABLES = [askConversations, askMessages, askAccounts, askLedger, askGlobalUsage];

function readMigration() {
  return readFileSync(MIGRATION_PATH, 'utf8');
}

function statements(sql: string) {
  return sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

function createStatements(sql: string) {
  return statements(sql).filter((s) => /^CREATE TABLE IF NOT EXISTS ask_/.test(s));
}

// CREATE INDEX statements live outside the owning table's CREATE chunk (Postgres has no inline
// index syntax), so an index name is checked against just this table's own index statements —
// found by table name, not against the whole migration file.
function indexStatementsFor(sql: string, tableName: string) {
  const onThisTable = new RegExp(`\\bON ${tableName}\\b`);
  return statements(sql).filter((s) => /^CREATE INDEX IF NOT EXISTS /.test(s) && onThisTable.test(s));
}

// Columns a later migration adds to an existing table (`ALTER TABLE <table> ... ADD COLUMN IF NOT
// EXISTS <name> ...`): the Drizzle column set is compared against 0048's CREATE plus these.
function addedColumnsFor(sql: string, tableName: string) {
  const altersThisTable = new RegExp(`^ALTER TABLE ${tableName}\\b`, 'm');
  return statements(sql)
    .filter((s) => altersThisTable.test(s))
    .flatMap((s) => [...s.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]));
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
    const addColumnsSql = readFileSync(ADD_COLUMNS_MIGRATION_PATH, 'utf8');

    TABLES.forEach((table, i) => {
      const config = getTableConfig(table);

      // Line-anchored set comparison: the first word of every column-def line in this table's
      // own CREATE chunk (dropping the `CREATE TABLE ... (` header line) must be exactly the
      // Drizzle column set, order aside. A `CONSTRAINT ...` line (inline check/unique) starts
      // with an uppercase word so the lowercase-only regex drops it; the `--` comment line inside
      // the ledger CREATE is dropped the same way since it starts with `--`; the closing `);` is
      // dropped because it has no lowercase word at all.
      const sqlCols = creates[i]
        .split('\n')
        .slice(1)
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((w) => /^[a-z_0-9]+$/.test(w));
      sqlCols.push(...addedColumnsFor(addColumnsSql, getTableName(table)));
      expect([...sqlCols].sort()).toEqual(config.columns.map((c) => c.name).sort());

      for (const c of config.checks) {
        expect(creates[i]).toContain(`CONSTRAINT ${c.name}`);
      }
      for (const u of config.uniqueConstraints) {
        expect(creates[i]).toContain(`CONSTRAINT ${u.name}`);
      }
      for (const idx of config.indexes) {
        const ownIndexes = indexStatementsFor(sql, getTableName(table));
        expect(ownIndexes.some((s) => s.includes(`CREATE INDEX IF NOT EXISTS ${idx.config.name}`))).toBe(true);
      }
    });
  });

  it('0049 adds the two write toggles as NOT NULL DEFAULT false and the per-chat stamp as a nullable timestamptz', () => {
    const addColumnsSql = readFileSync(ADD_COLUMNS_MIGRATION_PATH, 'utf8');
    expect(addColumnsSql).toMatch(/auto_approve_changes boolean NOT NULL DEFAULT false/);
    expect(addColumnsSql).toMatch(/auto_approve_deletes boolean NOT NULL DEFAULT false/);
    expect(addColumnsSql).toMatch(/changes_approved_at timestamptz;/);
  });
});

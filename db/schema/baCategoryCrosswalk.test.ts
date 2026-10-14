// db/schema/baCategoryCrosswalk.test.ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { baCategoryCrosswalk } from '@/db/schema';

describe('ba_category_crosswalk schema (migration 0053, spec 2026-10-14 §4.1)', () => {
  const MARKER = '--> statement-breakpoint';
  const raw = readFileSync('db/migrations/0053_ba_category_crosswalk.sql', 'utf8');
  // The apply script splits on the marker; comment-only lines are not SQL.
  const chunks = raw.split(MARKER);
  const statements = chunks.map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter((s) => s.length > 0);
  const flat = statements.join(' ').replace(/\s+/g, ' ');
  // Column definitions are the two-space-indented lowercase lines of a CREATE TABLE body.
  const declared = (body: string) => [...body.matchAll(/^ {2}([a-z][a-z0-9_]*) /gm)].map((m) => m[1]).sort();

  it('has 3 statements, one per chunk, split by 2 breakpoints', () => {
    expect(chunks).toHaveLength(3);
    expect(statements).toHaveLength(3);
    for (const s of statements) expect(s.match(/^(COMMENT|CREATE)\b/gm) ?? []).toHaveLength(1);
  });

  it('creates the table exactly as the mirror declares it, keyed by the path', () => {
    const create = statements[0];
    expect(create.startsWith('CREATE TABLE IF NOT EXISTS ba_category_crosswalk (')).toBe(true);
    expect(declared(create)).toEqual(Object.values(getTableColumns(baCategoryCrosswalk)).map((c) => c.name).sort());
    expect(create).toContain('category_path text PRIMARY KEY');
    expect(create).toContain('code varchar(255) NOT NULL');
    expect(create).toContain('source_path text NOT NULL');
    expect(create).toContain('votes integer NOT NULL');
    expect(create).toContain('share_pct smallint NOT NULL');
    expect(create).toContain('week_end_date date NOT NULL');
    expect(create).toContain('built_at timestamptz NOT NULL DEFAULT now()');
  });

  it("indexes (code, category_path): the search predicate's subquery and the code list", () => {
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS ba_category_crosswalk_code_idx ON ba_category_crosswalk (code, category_path)');
    const cfg = getTableConfig(baCategoryCrosswalk);
    const idx = cfg.indexes.find((i) => i.config.name === 'ba_category_crosswalk_code_idx');
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(['code', 'category_path']);
    expect(cfg.columns.find((c) => c.name === 'category_path')?.primary).toBe(true);
    expect(cfg.columns.find((c) => c.name === 'code')?.getSQLType()).toBe('varchar(255)');
    expect(cfg.columns.find((c) => c.name === 'share_pct')?.getSQLType()).toBe('smallint');
  });

  it('says what the table is and that the build relearns it weekly', () => {
    expect(statements[2].startsWith('COMMENT ON TABLE ba_category_crosswalk IS')).toBe(true);
    expect(statements[2]).toContain('relearned at each weekly import (lib/baCategory/buildCrosswalk.ts)');
    expect(statements[2]).toContain("A product''s broad category is the code of its path");
  });
});

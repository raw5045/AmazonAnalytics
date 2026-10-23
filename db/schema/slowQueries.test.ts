import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '@/db/schema';
import { slowQueries } from './slowQueries';
import { asinProducts } from './asinProducts';

describe('slow_queries (migration 0056)', () => {
  it('mirrors the table: columns, nullability, the (surface, happened_at) index', () => {
    const t = getTableConfig(slowQueries);
    expect(t.name).toBe('slow_queries');
    expect(t.columns.map((c) => [c.name, c.notNull])).toEqual([
      ['id', true], ['surface', true], ['happened_at', true], ['user_id', false], ['query_string', true], ['elapsed_ms', true], ['timed_out', true],
    ]);
    expect(t.indexes.map((i) => i.config.name)).toEqual(['slow_queries_surface_happened_at_idx']);
  });
  it('asin_products carries keyword_count (not null, default 0) and its index', () => {
    const t = getTableConfig(asinProducts);
    const col = t.columns.find((c) => c.name === 'keyword_count');
    expect(col?.notNull).toBe(true);
    expect(col?.hasDefault).toBe(true);
    expect(t.indexes.map((i) => i.config.name)).toContain('asin_products_keyword_count_idx');
  });
  it('is exported from the schema index', () => {
    expect(schema.slowQueries).toBe(slowQueries);
  });
});

describe('migration 0056 SQL text (spec 2026-10-23 §5 and §5b)', () => {
  const MARKER = '--> statement-breakpoint';
  const raw = readFileSync('db/migrations/0056_keyword_counts_and_slow_queries.sql', 'utf8');
  // The apply script splits on the marker; comment-only lines are not SQL.
  const chunks = raw.split(MARKER);
  const statements = chunks.map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter((s) => s.length > 0);
  // Column definitions are the two-space-indented lowercase lines of a CREATE TABLE body.
  const declared = (body: string) => [...body.matchAll(/^ {2}([a-z][a-z0-9_]*) /gm)].map((m) => m[1]);

  it('has 4 statements, one per chunk, split by 3 breakpoints', () => {
    expect(chunks).toHaveLength(4);
    expect(statements).toHaveLength(4);
    for (const s of statements) expect(s.match(/^(ALTER|CREATE)\b/gm) ?? []).toHaveLength(1);
  });

  it('adds keyword_count and its (keyword_count, asin) index exactly as the asin_products mirror declares them', () => {
    expect(statements[0]).toBe('ALTER TABLE asin_products ADD COLUMN IF NOT EXISTS keyword_count integer NOT NULL DEFAULT 0;');
    expect(statements[1]).toBe('CREATE INDEX IF NOT EXISTS asin_products_keyword_count_idx ON asin_products (keyword_count, asin);');
    const cfg = getTableConfig(asinProducts);
    const col = cfg.columns.find((c) => c.name === 'keyword_count');
    expect([col?.getSQLType(), col?.notNull, col?.hasDefault, col?.default]).toEqual(['integer', true, true, 0]);
    const idx = cfg.indexes.find((i) => i.config.name === 'asin_products_keyword_count_idx');
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(['keyword_count', 'asin']);
  });

  it('creates slow_queries and its (surface, happened_at) index exactly as the mirror declares them', () => {
    const create = statements[2];
    const cfg = getTableConfig(slowQueries);
    expect(create.startsWith('CREATE TABLE IF NOT EXISTS slow_queries (')).toBe(true);
    expect(declared(create)).toEqual(cfg.columns.map((c) => c.name));
    // Whitespace collapsed: a fresh worktree checks this file out with CRLF (core.autocrlf, no .gitattributes).
    expect(create.replace(/\s+/g, ' ')).toBe(
      'CREATE TABLE IF NOT EXISTS slow_queries ( id bigserial PRIMARY KEY, surface text NOT NULL, ' +
        'happened_at timestamptz NOT NULL DEFAULT now(), user_id uuid NULL, query_string text NOT NULL, ' +
        'elapsed_ms integer NOT NULL, timed_out boolean NOT NULL );',
    );
    const shape = Object.fromEntries(cfg.columns.map((c) => [c.name, [c.getSQLType(), c.notNull]]));
    expect(shape).toEqual({
      id: ['bigserial', true], surface: ['text', true], happened_at: ['timestamp with time zone', true], user_id: ['uuid', false],
      query_string: ['text', true], elapsed_ms: ['integer', true], timed_out: ['boolean', true],
    });
    expect(cfg.columns.find((c) => c.name === 'id')?.primary).toBe(true);
    expect(cfg.columns.find((c) => c.name === 'happened_at')?.hasDefault).toBe(true);
    expect(statements[3]).toBe('CREATE INDEX IF NOT EXISTS slow_queries_surface_happened_at_idx ON slow_queries (surface, happened_at);');
    const idx = cfg.indexes.find((i) => i.config.name === 'slow_queries_surface_happened_at_idx');
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(['surface', 'happened_at']);
  });
});

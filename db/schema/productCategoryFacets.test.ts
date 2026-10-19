// db/schema/productCategoryFacets.test.ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { productCategoryFacets } from '@/db/schema';

describe('product_category_facets schema (migration 0055, spec 2026-10-19 §4)', () => {
  const MARKER = '--> statement-breakpoint';
  const raw = readFileSync('db/migrations/0055_product_category_facets.sql', 'utf8');
  // The apply script splits on the marker; comment-only lines are not SQL.
  const chunks = raw.split(MARKER);
  const statements = chunks.map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter((s) => s.length > 0);
  // Column definitions are the two-space-indented lowercase lines of a CREATE TABLE body.
  const declared = (body: string) => [...body.matchAll(/^ {2}([a-z][a-z0-9_]*) /gm)].map((m) => m[1]).sort();

  it('has 3 statements, one per chunk, split by 2 breakpoints', () => {
    expect(chunks).toHaveLength(3);
    expect(statements).toHaveLength(3);
    for (const s of statements) expect(s.match(/^(COMMENT|CREATE)\b/gm) ?? []).toHaveLength(1);
  });

  it('creates the table exactly as the mirror declares it, keyed by the path', () => {
    const create = statements[0];
    expect(create.startsWith('CREATE TABLE IF NOT EXISTS product_category_facets (')).toBe(true);
    expect(declared(create)).toEqual(Object.values(getTableColumns(productCategoryFacets)).map((c) => c.name).sort());
    // Whitespace collapsed: a fresh worktree checks this file out with CRLF (core.autocrlf, no .gitattributes).
    expect(create.replace(/\s+/g, ' ')).toBe(
      'CREATE TABLE IF NOT EXISTS product_category_facets ( category_path text PRIMARY KEY, department text NOT NULL, ' +
        'product_count integer NOT NULL, built_at timestamptz NOT NULL DEFAULT now() );',
    );
  });

  it('indexes (department, category_path): the per-department path reads and the department list', () => {
    expect(statements[1]).toBe('CREATE INDEX IF NOT EXISTS product_category_facets_department_idx ON product_category_facets (department, category_path);');
    const cfg = getTableConfig(productCategoryFacets);
    const idx = cfg.indexes.find((i) => i.config.name === 'product_category_facets_department_idx');
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(['department', 'category_path']);
    expect(cfg.columns.find((c) => c.name === 'category_path')?.primary).toBe(true);
    const shape = Object.fromEntries(cfg.columns.map((c) => [c.name, [c.getSQLType(), c.notNull, c.hasDefault]]));
    expect(shape).toEqual({
      category_path: ['text', true, false],
      department: ['text', true, false],
      product_count: ['integer', true, false],
      built_at: ['timestamp with time zone', true, true],
    });
  });

  it('says what the table is, who rebuilds it and who reads it', () => {
    expect(statements[2].startsWith('COMMENT ON TABLE product_category_facets IS')).toBe(true);
    expect(statements[2]).toContain('Rebuilt in one transaction by every weekly import (lib/products/buildCategoryFacets.ts)');
    expect(statements[2]).toContain("the Products page''s and tools'' department and leaf-category lists read it");
  });
});

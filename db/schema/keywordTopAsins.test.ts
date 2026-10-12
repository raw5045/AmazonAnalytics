// db/schema/keywordTopAsins.test.ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { keywordTopAsins, keywordTopAsinsMeta, asinProducts } from '@/db/schema';

describe('keyword_top_asins schema (migrations 0051 and 0052)', () => {
  it('mirrors the migration columns', () => {
    const cols = Object.values(getTableColumns(keywordTopAsins)).map((c) => c.name).sort();
    expect(cols).toEqual(
      ['asin', 'broad_category', 'click_share', 'conversion_share', 'search_term_id', 'slot', 'streak_started_week', 'week_end_date', 'weeks_in_top3'].sort(),
    );
    const meta = Object.values(getTableColumns(keywordTopAsinsMeta)).map((c) => c.name).sort();
    expect(meta).toEqual(['built_at', 'row_count', 'singleton', 'week_end_date'].sort());
  });
  it('adds rank_ratio_x100 to the catalog', () => {
    expect(getTableColumns(asinProducts).rankRatioX100.name).toBe('rank_ratio_x100');
  });
});

describe('migration 0051 SQL text', () => {
  const MARKER = '--> statement-breakpoint';
  const PREDICATE = "WHERE in_scope AND enrichment_status IN ('active', 'no_price')";
  const raw = readFileSync('db/migrations/0051_products.sql', 'utf8');
  // The apply script splits on the marker (as it does for 0050); comment-only lines are not SQL.
  const chunks = raw.split(MARKER);
  const statements = chunks.map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter((s) => s.length > 0);
  const flat = statements.join(' ').replace(/\s+/g, ' ');
  const mirror = (cols: Record<string, { name: string }>) => Object.values(cols).map((c) => c.name).sort();
  // Column definitions are the two-space-indented lowercase lines of a CREATE TABLE body.
  const declared = (body: string) => [...body.matchAll(/^ {2}([a-z][a-z0-9_]*) /gm)].map((m) => m[1]).sort();
  const createTable = (name: string) => {
    const found = statements.find((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`));
    if (!found) throw new Error(`migration has no CREATE TABLE for ${name}`);
    return found;
  };

  it('has 13 statements, one per chunk, split by 12 breakpoints', () => {
    expect(chunks).toHaveLength(13);
    expect(statements).toHaveLength(13);
    for (const s of statements) {
      expect(s.match(/^(ALTER|COMMENT|CREATE|INSERT)\b/gm) ?? []).toHaveLength(1);
    }
  });

  it('builds the six catalog indexes as (key, asin) on the Products-page predicate', () => {
    expect(flat.split(PREDICATE).length - 1).toBe(6);
    const catalogColumns = mirror(getTableColumns(asinProducts));
    // The search orders by "<key> <dir>, asin <dir>", so each index leads with its key and ends in the asin tie-break.
    expect(catalogColumns).toContain('asin');
    const indexes: Array<[string, string]> = [
      ['asin_products_listed_since_idx', 'listed_since'],
      ['asin_products_monthly_sold_idx', 'monthly_sold'],
      ['asin_products_review_count_idx', 'review_count'],
      ['asin_products_sales_rank_idx', 'sales_rank'],
      ['asin_products_price_idx', 'current_price_cents'],
      ['asin_products_rank_ratio_idx', 'rank_ratio_x100'],
    ];
    for (const [name, column] of indexes) {
      expect(catalogColumns).toContain(column);
      expect(flat).toContain(`CREATE INDEX IF NOT EXISTS ${name} ON asin_products (${column}, asin) ${PREDICATE}`);
    }
  });

  it('creates the reverse table and its meta row exactly as the drizzle mirrors declare them', () => {
    // 0051 created eight columns; 0052 (below) added broad_category, so the mirror is the union.
    expect([...declared(createTable('keyword_top_asins')), 'broad_category'].sort()).toEqual(mirror(getTableColumns(keywordTopAsins)));
    expect(declared(createTable('keyword_top_asins_meta'))).toEqual(mirror(getTableColumns(keywordTopAsinsMeta)));
    expect(flat).toContain('PRIMARY KEY (search_term_id, slot)');
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS keyword_top_asins_asin_idx ON keyword_top_asins (asin, search_term_id)');
  });

  it('describes rank_ratio_x100 as a point-in-time fact, not as null on delisted rows', () => {
    expect(raw).not.toContain('null on delisted');
    const comment = statements.find((s) => s.startsWith('COMMENT ON COLUMN asin_products.rank_ratio_x100'));
    expect(comment).toContain('point-in-time fact');
  });
});

describe('migration 0052 SQL text', () => {
  const MARKER = '--> statement-breakpoint';
  const raw = readFileSync('db/migrations/0052_top_asins_broad_category.sql', 'utf8');
  const chunks = raw.split(MARKER);
  const statements = chunks.map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter((s) => s.length > 0);
  const flat = statements.join(' ').replace(/\s+/g, ' ');

  it('has 4 statements, one per chunk, split by 3 breakpoints', () => {
    expect(chunks).toHaveLength(4);
    expect(statements).toHaveLength(4);
    for (const s of statements) expect(s.match(/^(ALTER|COMMENT|CREATE)\b/gm) ?? []).toHaveLength(1);
  });
  it('adds the nullable code column to the live table and, when it exists, to _prev (the retained build stays shaped like the live one)', () => {
    expect(statements[0]).toBe('ALTER TABLE keyword_top_asins ADD COLUMN IF NOT EXISTS broad_category varchar(255);');
    expect(statements[2]).toBe('ALTER TABLE IF EXISTS keyword_top_asins_prev ADD COLUMN IF NOT EXISTS broad_category varchar(255);');
    expect(getTableColumns(keywordTopAsins).broadCategory.name).toBe('broad_category');
    expect(getTableColumns(keywordTopAsins).broadCategory.notNull).toBe(false);
  });
  it('describes the column as the per-slot report code, any-of per product', () => {
    expect(statements[1]).toContain('top_clicked_category_<slot>');
    expect(statements[1]).toContain('any-of');
  });
  it('indexes (broad_category, asin) over the coded rows only, under the canonical name the swap renames', () => {
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS keyword_top_asins_broad_category_idx ON keyword_top_asins (broad_category, asin) WHERE broad_category IS NOT NULL');
  });
  it('the mirror declares varchar(255) and the partial (broad_category, asin) index', () => {
    const cfg = getTableConfig(keywordTopAsins);
    expect(cfg.columns.find((c) => c.name === 'broad_category')?.getSQLType()).toBe('varchar(255)');
    const idx = cfg.indexes.find((i) => i.config.name === 'keyword_top_asins_broad_category_idx');
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(['broad_category', 'asin']);
    expect(idx?.config.where).toBeDefined();
  });
});

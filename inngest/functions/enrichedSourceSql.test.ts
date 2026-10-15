// inngest/functions/enrichedSourceSql.test.ts
/**
 * The Keepa staging (refreshSummary) and aggregate-sync (worker) statement builders, spec
 * 2026-10-05 §7: which rows the catalog stages, what it binds, and that every column it names
 * exists in the drizzle schema of the table it reads (one source since arc 11).
 */
import { describe, it, expect } from 'vitest';
import { getTableColumns, type Table } from 'drizzle-orm';
import { asinProducts } from '@/db/schema';
import { stageEnrichedAsinsSql } from './refreshSummary';
import { enrichedSyncSourceSql } from '@/worker/kcsKeepaSyncJobs';

const CATALOG_STATUSES = "a.enrichment_status IN ('active', 'no_price', 'delisted')";
const PRICE_ONLY_WHEN_ACTIVE = "CASE WHEN a.enrichment_status = 'active' THEN a.current_price_cents END AS current_price_cents";

/** Every `a.<column>` a statement references. */
const aliasColumns = (text: string) => [...new Set([...text.matchAll(/\ba\.([a-z0-9_]+)/g)].map((m) => m[1]))];
/** A table's database column names, per the drizzle schema. */
const dbColumns = (table: Table) => new Set(Object.values(getTableColumns(table)).map((c) => c.name));

const builders = { stageEnrichedAsinsSql, enrichedSyncSourceSql };

for (const [name, build] of Object.entries(builders)) {
  describe(name, () => {
    it('catalog: binds nothing, stages active, no_price and delisted rows, and prices only the active ones', () => {
      const q = build();
      expect(q.values).toEqual([]);
      expect(q.text).toContain('FROM asin_products a');
      expect(q.text).toContain(CATALOG_STATUSES);
      expect(q.text).toContain(PRICE_ONLY_WHEN_ACTIVE);
      expect(q.text).not.toContain('$1');
      expect(q.text).not.toContain('DISTINCT ON');
    });

    it('names only columns that exist in the table it reads', () => {
      const catalog = aliasColumns(build().text);
      expect(catalog).toEqual(expect.arrayContaining(['asin', 'current_price_cents', 'review_count', 'category_path', 'enrichment_status']));
      const inCatalog = dbColumns(asinProducts);
      expect(catalog.filter((c) => !inCatalog.has(c))).toEqual([]);
    });
  });
}

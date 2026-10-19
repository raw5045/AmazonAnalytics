// db/schema/productCategoryFacets.ts
import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * The Products page's category option lists, precomputed (migration 0055; spec 2026-10-19 §4): one row per
 * distinct asin_products.category_path among the rows the page can show (in_scope, active or no_price), with
 * its department (category_root) and product count. Rebuilt in one transaction by every weekly import
 * (lib/products/buildCategoryFacets.ts, phase category_facets_build) and by hand
 * (scripts/buildProductCategoryFacets.ts); read by lib/products/listCategories.ts (the department list, and
 * the paths one department at a time through the index), instead of scanning the catalog. Type mirror only:
 * the journal is frozen.
 */
export const productCategoryFacets = pgTable(
  'product_category_facets',
  {
    categoryPath: text('category_path').primaryKey(),
    department: text('department').notNull(),
    /** Catalog rows at exactly this path. Stored because it is free; nothing reads it yet (spec §14). */
    productCount: integer('product_count').notNull(),
    builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    departmentIdx: index('product_category_facets_department_idx').on(t.department, t.categoryPath),
  }),
);

export type ProductCategoryFacetRow = typeof productCategoryFacets.$inferSelect;

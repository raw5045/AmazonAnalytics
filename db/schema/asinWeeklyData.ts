import {
  pgTable,
  pgEnum,
  text,
  date,
  integer,
  jsonb,
  timestamp,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

/**
 * Per-(asin, week) snapshot of Keepa-sourced product data.
 *
 * Aligns with kwm's weekly cadence so the join is direct: a kwm row
 * at (week_end_date, search_term_id) → up to 3 ASINs → up to 3
 * asin_weekly_data rows at the same week_end_date.
 *
 * We enrich at most once per ASIN per week. Two weeks later, the row
 * for that ASIN at the new week exists alongside the old one — the
 * "current" view is `ORDER BY week_end_date DESC LIMIT 1` per ASIN,
 * the trajectory is just every row.
 *
 * Scope is enforced by the Inngest job (top-3 ASINs at rank ≤ 100K,
 * excluded categories filtered out), not by the schema. Keeps the
 * table generic in case we widen scope later.
 *
 * Filled by `inngest/functions/enrichKeepaForWeek.ts` after each kcs
 * refresh. See `db/migrations/0022_asin_weekly_data.sql` for the
 * canonical column docs and the partial-index definitions.
 */
export const asinEnrichmentStatusEnum = pgEnum('asin_enrichment_status', [
  'active',
  'no_price',
  'delisted',
  'error',
]);

export const asinWeeklyData = pgTable(
  'asin_weekly_data',
  {
    asin: text('asin').notNull(),
    weekEndDate: date('week_end_date').notNull(),

    // Product metadata (Keepa product object)
    title: text('title'),
    brand: text('brand'),
    /**
     * Primary product image URL. Keepa returns `imagesCSV` (comma-separated
     * image keys); we take the first and prepend the Amazon image CDN host.
     * May be null for some ASINs. Bytes are not hosted by us — the URL
     * points at Amazon's CDN directly.
     */
    imageUrl: text('image_url'),

    // Specific category path (Keepa categoryTree)
    categoryPath: text('category_path'),   // "Tools › Bath › Faucets"
    categoryRoot: text('category_root'),   // denormalized, for top-level filters
    categoryLeaf: text('category_leaf'),   // denormalized, for leaf filters

    // Time-varying metrics (Keepa csv arrays)
    currentPriceCents: integer('current_price_cents'), // csv[0] last value, fallback csv[1]
    salesRank: integer('sales_rank'),                  // csv[3] last value
    reviewCount: integer('review_count'),              // csv[17] last value
    /**
     * Average rating on the Keepa 0–50 scale (e.g. 45 = 4.5★). Divide by 10
     * for display. Sourced from csv[16] last value.
     */
    averageRatingX10: integer('average_rating_x10'),
    /**
     * Date Keepa most recently observed a rating update for this ASIN.
     * Converted from `product.lastRatingUpdate` (Keepa Time Minutes →
     * ISO date). Freshness signal.
     */
    lastRatingUpdate: date('last_rating_update'),

    // Trailing-window averages (computed from csv[0] history at parse time)
    avg30PriceCents: integer('avg30_price_cents'),
    avg90PriceCents: integer('avg90_price_cents'),
    avg180PriceCents: integer('avg180_price_cents'),
    avg365PriceCents: integer('avg365_price_cents'),

    /**
     * Variations (sibling ASINs) — JSONB array of ASIN strings.
     * Example: ["B00...","B01..."]
     */
    variations: jsonb('variations'),

    /**
     * Promotions JSONB — Keepa's `promotions` field stored as-is so
     * we can revisit shape later without a migration.
     */
    promotions: jsonb('promotions'),

    // Enrichment metadata
    enrichmentStatus: asinEnrichmentStatusEnum('enrichment_status').notNull(),
    errorMessage: text('error_message'),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.asin, t.weekEndDate] }),
    weekRootIdx: index('asin_weekly_data_week_root_idx').on(t.weekEndDate, t.categoryRoot),
    weekLeafIdx: index('asin_weekly_data_week_leaf_idx').on(t.weekEndDate, t.categoryLeaf),
    asinIdx: index('asin_weekly_data_asin_idx').on(t.asin),
    // Partial index (delisted only) defined in the migration SQL —
    // drizzle's index().where() emits inconsistently for partial
    // predicates, so we keep the declaration here as a vanilla
    // index for type-checking purposes and trust the migration.
    delistedRecheckIdx: index('asin_weekly_data_delisted_recheck_idx').on(t.enrichedAt),
  }),
);

export type AsinWeeklyData = typeof asinWeeklyData.$inferSelect;
export type AsinEnrichmentStatus = (typeof asinEnrichmentStatusEnum.enumValues)[number];

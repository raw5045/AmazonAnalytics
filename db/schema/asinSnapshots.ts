// db/schema/asinSnapshots.ts
import { pgTable, text, integer, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { asinEnrichmentStatusEnum } from './asinWeeklyData';

/** One narrow row per Keepa fetch (spec 2026-10-05 §4.2). Written by services/keepa. */
export const asinSnapshots = pgTable(
  'asin_snapshots',
  {
    asin: text('asin').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    currentPriceCents: integer('current_price_cents'),
    salesRank: integer('sales_rank'),
    reviewCount: integer('review_count'),
    averageRatingX10: integer('average_rating_x10'),
    monthlySold: integer('monthly_sold'),
    newOfferCount: integer('new_offer_count'),
    fbaOfferCount: integer('fba_offer_count'),
    fbmOfferCount: integer('fbm_offer_count'),
    enrichmentStatus: asinEnrichmentStatusEnum('enrichment_status').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.asin, t.fetchedAt] }) }),
);

export type AsinSnapshotRow = typeof asinSnapshots.$inferSelect;

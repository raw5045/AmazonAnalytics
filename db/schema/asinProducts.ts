// db/schema/asinProducts.ts
import { pgTable, text, date, integer, smallint, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { asinEnrichmentStatusEnum } from './asinWeeklyData';

/**
 * One row per ASIN: current Keepa facts + the Keepa service's queue state.
 * Written by services/keepa (raw SQL); read by the admin card, the watcher and —
 * behind KEEPA_READ_SOURCE=products — the app's readers. Canonical DDL and
 * partial-index predicates: db/migrations/0050_keepa_service.sql (spec 2026-10-05 §4.1).
 */
export const asinProducts = pgTable(
  'asin_products',
  {
    asin: text('asin').primaryKey(),
    title: text('title'),
    brand: text('brand'),
    imageUrl: text('image_url'),
    categoryPath: text('category_path'),
    categoryRoot: text('category_root'),
    categoryLeaf: text('category_leaf'),
    listedSince: date('listed_since'),
    trackingSince: date('tracking_since'),
    currentPriceCents: integer('current_price_cents'),
    /** 'amazon' | 'new' — which Keepa series the current price and its averages come from. */
    priceSource: text('price_source'),
    salesRank: integer('sales_rank'),
    reviewCount: integer('review_count'),
    averageRatingX10: integer('average_rating_x10'),
    lastRatingUpdate: date('last_rating_update'),
    /** Amazon's "bought in past month" floor (100000 = 100K+); null without the badge. */
    monthlySold: integer('monthly_sold'),
    /** Keepa's lastUpdate: the "as of" date for monthly sold and the offer counts. */
    keepaUpdatedAt: date('keepa_updated_at'),
    newOfferCount: integer('new_offer_count'),
    fbaOfferCount: integer('fba_offer_count'),
    fbmOfferCount: integer('fbm_offer_count'),
    /** Keepa code: -1 no Amazon offer, 0 in stock, 1 pre-order, 2 unknown, 3 back-order, 4 delayed. */
    amazonAvailability: smallint('amazon_availability'),
    avg30PriceCents: integer('avg30_price_cents'),
    avg90PriceCents: integer('avg90_price_cents'),
    avg180PriceCents: integer('avg180_price_cents'),
    avg365PriceCents: integer('avg365_price_cents'),
    avg30SalesRank: integer('avg30_sales_rank'),
    avg90SalesRank: integer('avg90_sales_rank'),
    /** NULL until the first fetch outcome ('error' after a failed first fetch). Never fetched = lastFetchedAt IS NULL. */
    enrichmentStatus: asinEnrichmentStatusEnum('enrichment_status'),
    errorCode: text('error_code'),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    fetchCount: integer('fetch_count').notNull().default(0),
    consecutiveErrors: integer('consecutive_errors').notNull().default(0),
    inScope: boolean('in_scope').notNull().default(true),
    bestRank: integer('best_rank'),
    scopeWeek: date('scope_week'),
    tier: smallint('tier').notNull().default(2),
    nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The four indexes are PARTIAL in the migration (drizzle's index().where() emits inconsistently) and the category_path index uses text_pattern_ops there, and scope_week has a plain index for max(scope_week); declared plain here for type-checking only.
    neverFetchedIdx: index('asin_products_never_fetched_idx').on(t.tier, t.bestRank, t.asin),
    dueIdx: index('asin_products_due_idx').on(t.tier, t.nextDueAt, t.asin),
    claimedIdx: index('asin_products_claimed_idx').on(t.claimedAt),
    categoryPathIdx: index('asin_products_category_path_idx').on(t.categoryPath),
    scopeWeekIdx: index('asin_products_scope_week_idx').on(t.scopeWeek),
  }),
);

export type AsinProductRow = typeof asinProducts.$inferSelect;

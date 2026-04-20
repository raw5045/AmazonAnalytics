import {
  pgTable,
  uuid,
  integer,
  date,
  varchar,
  text,
  numeric,
  boolean,
  smallint,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { uploadBatches, uploadedFiles } from './uploads';
import { searchTerms } from './searchTerms';

export const stagingWeeklyMetrics = pgTable(
  'staging_weekly_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => uploadBatches.id),
    uploadedFileId: uuid('uploaded_file_id')
      .notNull()
      .references(() => uploadedFiles.id),
    weekEndDate: date('week_end_date').notNull(),
    searchTermRaw: varchar('search_term_raw', { length: 512 }).notNull(),
    searchTermNormalized: varchar('search_term_normalized', { length: 512 }).notNull(),
    searchTermId: uuid('search_term_id').references(() => searchTerms.id),
    actualRank: integer('actual_rank').notNull(),
    topClickedBrand1: varchar('top_clicked_brand_1', { length: 255 }),
    topClickedBrand2: varchar('top_clicked_brand_2', { length: 255 }),
    topClickedBrand3: varchar('top_clicked_brand_3', { length: 255 }),
    topClickedCategory1: varchar('top_clicked_category_1', { length: 255 }),
    topClickedCategory2: varchar('top_clicked_category_2', { length: 255 }),
    topClickedCategory3: varchar('top_clicked_category_3', { length: 255 }),
    topClickedProduct1Asin: varchar('top_clicked_product_1_asin', { length: 20 }),
    topClickedProduct2Asin: varchar('top_clicked_product_2_asin', { length: 20 }),
    topClickedProduct3Asin: varchar('top_clicked_product_3_asin', { length: 20 }),
    topClickedProduct1Title: text('top_clicked_product_1_title'),
    topClickedProduct2Title: text('top_clicked_product_2_title'),
    topClickedProduct3Title: text('top_clicked_product_3_title'),
    topClickedProduct1ClickShare: numeric('top_clicked_product_1_click_share', { precision: 5, scale: 2 }),
    topClickedProduct2ClickShare: numeric('top_clicked_product_2_click_share', { precision: 5, scale: 2 }),
    topClickedProduct3ClickShare: numeric('top_clicked_product_3_click_share', { precision: 5, scale: 2 }),
    topClickedProduct1ConversionShare: numeric('top_clicked_product_1_conversion_share', { precision: 5, scale: 2 }),
    topClickedProduct2ConversionShare: numeric('top_clicked_product_2_conversion_share', { precision: 5, scale: 2 }),
    topClickedProduct3ConversionShare: numeric('top_clicked_product_3_conversion_share', { precision: 5, scale: 2 }),
    keywordInTitle1: boolean('keyword_in_title_1'),
    keywordInTitle2: boolean('keyword_in_title_2'),
    keywordInTitle3: boolean('keyword_in_title_3'),
    keywordTitleMatchCount: smallint('keyword_title_match_count'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fileIdx: index('staging_file_idx').on(t.uploadedFileId),
    normalizedIdx: index('staging_normalized_idx').on(t.searchTermNormalized),
  }),
);

export type StagingWeeklyMetric = typeof stagingWeeklyMetrics.$inferSelect;
export type NewStagingWeeklyMetric = typeof stagingWeeklyMetrics.$inferInsert;

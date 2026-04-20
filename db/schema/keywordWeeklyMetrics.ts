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
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { searchTerms } from './searchTerms';
import { uploadedFiles, fakeVolumeEvalStatusEnum } from './uploads';

export const keywordWeeklyMetrics = pgTable(
  'keyword_weekly_metrics',
  {
    weekEndDate: date('week_end_date').notNull(),
    searchTermId: uuid('search_term_id').notNull().references(() => searchTerms.id),
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
    fakeVolumeFlag: boolean('fake_volume_flag'),
    fakeVolumeEvalStatus: fakeVolumeEvalStatusEnum('fake_volume_eval_status'),
    fakeVolumeRuleVersionId: uuid('fake_volume_rule_version_id'),
    sourceFileId: uuid('source_file_id').notNull().references(() => uploadedFiles.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.weekEndDate, t.searchTermId] }),
    rankIdx: index('kwm_week_rank_idx').on(t.weekEndDate, t.actualRank),
    termWeekIdx: index('kwm_term_week_idx').on(t.searchTermId, t.weekEndDate),
    categoryIdx: index('kwm_week_category_idx').on(t.weekEndDate, t.topClickedCategory1),
  }),
);

export type KeywordWeeklyMetric = typeof keywordWeeklyMetrics.$inferSelect;
export type NewKeywordWeeklyMetric = typeof keywordWeeklyMetrics.$inferInsert;

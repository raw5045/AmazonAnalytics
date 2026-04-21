CREATE TABLE "keyword_weekly_metrics" (
  "week_end_date" date NOT NULL,
  "search_term_id" uuid NOT NULL,
  "actual_rank" integer NOT NULL,
  "top_clicked_brand_1" varchar(255),
  "top_clicked_brand_2" varchar(255),
  "top_clicked_brand_3" varchar(255),
  "top_clicked_category_1" varchar(255),
  "top_clicked_category_2" varchar(255),
  "top_clicked_category_3" varchar(255),
  "top_clicked_product_1_asin" varchar(20),
  "top_clicked_product_2_asin" varchar(20),
  "top_clicked_product_3_asin" varchar(20),
  "top_clicked_product_1_title" text,
  "top_clicked_product_2_title" text,
  "top_clicked_product_3_title" text,
  "top_clicked_product_1_click_share" numeric(5,2),
  "top_clicked_product_2_click_share" numeric(5,2),
  "top_clicked_product_3_click_share" numeric(5,2),
  "top_clicked_product_1_conversion_share" numeric(5,2),
  "top_clicked_product_2_conversion_share" numeric(5,2),
  "top_clicked_product_3_conversion_share" numeric(5,2),
  "keyword_in_title_1" boolean,
  "keyword_in_title_2" boolean,
  "keyword_in_title_3" boolean,
  "keyword_title_match_count" smallint,
  "fake_volume_flag" boolean,
  "fake_volume_eval_status" fake_volume_eval_status,
  "fake_volume_rule_version_id" uuid,
  "source_file_id" uuid NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("week_end_date", "search_term_id"),
  FOREIGN KEY ("search_term_id") REFERENCES "search_terms"("id"),
  FOREIGN KEY ("source_file_id") REFERENCES "uploaded_files"("id")
) PARTITION BY RANGE ("week_end_date");
--> statement-breakpoint
CREATE TABLE "keyword_weekly_metrics_2024" PARTITION OF "keyword_weekly_metrics"
  FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
--> statement-breakpoint
CREATE TABLE "keyword_weekly_metrics_2025" PARTITION OF "keyword_weekly_metrics"
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
--> statement-breakpoint
CREATE TABLE "keyword_weekly_metrics_2026" PARTITION OF "keyword_weekly_metrics"
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
--> statement-breakpoint
CREATE TABLE "keyword_weekly_metrics_2027" PARTITION OF "keyword_weekly_metrics"
  FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');
--> statement-breakpoint
CREATE INDEX "kwm_week_rank_idx" ON "keyword_weekly_metrics" ("week_end_date", "actual_rank");
--> statement-breakpoint
CREATE INDEX "kwm_term_week_idx" ON "keyword_weekly_metrics" ("search_term_id", "week_end_date");
--> statement-breakpoint
CREATE INDEX "kwm_week_category_idx" ON "keyword_weekly_metrics" ("week_end_date", "top_clicked_category_1");

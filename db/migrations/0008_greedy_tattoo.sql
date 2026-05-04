CREATE TYPE "public"."fake_volume_severity" AS ENUM('none', 'warning', 'critical');--> statement-breakpoint
CREATE TABLE "fake_volume_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_name" varchar(64) NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"warning_rules_json" jsonb NOT NULL,
	"critical_rules_json" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keyword_current_summary" (
	"search_term_id" uuid PRIMARY KEY NOT NULL,
	"current_week_end_date" date NOT NULL,
	"current_rank" integer NOT NULL,
	"prior_week_rank" integer,
	"rank_4w_ago" integer,
	"rank_13w_ago" integer,
	"rank_26w_ago" integer,
	"rank_52w_ago" integer,
	"improvement_1w" integer,
	"improvement_4w" integer,
	"improvement_13w" integer,
	"improvement_26w" integer,
	"improvement_52w" integer,
	"consecutive_improvement_streak" integer DEFAULT 0 NOT NULL,
	"ever_top_50k" boolean DEFAULT false NOT NULL,
	"has_unranked_week" boolean DEFAULT false NOT NULL,
	"unranked_week_count" integer DEFAULT 0 NOT NULL,
	"unranked_after_top_50k" boolean DEFAULT false NOT NULL,
	"last_seen_week" date NOT NULL,
	"weeks_since_seen" integer DEFAULT 0 NOT NULL,
	"fake_volume_severity_current" "fake_volume_severity",
	"top_clicked_category_1_current" varchar(255),
	"top_clicked_product_1_asin_current" varchar(20),
	"top_clicked_product_1_title_current" text,
	"keyword_in_title_1_current" boolean,
	"keyword_in_title_2_current" boolean,
	"keyword_in_title_3_current" boolean,
	"keyword_title_match_count_current" smallint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "keyword_weekly_metrics" ADD COLUMN "fake_volume_severity" "fake_volume_severity";--> statement-breakpoint
ALTER TABLE "fake_volume_rules" ADD CONSTRAINT "fake_volume_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_current_summary" ADD CONSTRAINT "keyword_current_summary_search_term_id_search_terms_id_fk" FOREIGN KEY ("search_term_id") REFERENCES "public"."search_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fake_volume_rules_active_idx" ON "fake_volume_rules" USING btree ("is_active") WHERE "fake_volume_rules"."is_active" = true;--> statement-breakpoint
CREATE INDEX "kcs_rank_idx" ON "keyword_current_summary" USING btree ("current_week_end_date","current_rank");--> statement-breakpoint
CREATE INDEX "kcs_title_match_idx" ON "keyword_current_summary" USING btree ("current_week_end_date","keyword_title_match_count_current");--> statement-breakpoint
CREATE INDEX "kcs_imp1_idx" ON "keyword_current_summary" USING btree ("improvement_1w");--> statement-breakpoint
CREATE INDEX "kcs_imp4_idx" ON "keyword_current_summary" USING btree ("improvement_4w");--> statement-breakpoint
CREATE INDEX "kcs_imp13_idx" ON "keyword_current_summary" USING btree ("improvement_13w");--> statement-breakpoint
CREATE INDEX "kcs_imp26_idx" ON "keyword_current_summary" USING btree ("improvement_26w");--> statement-breakpoint
CREATE INDEX "kcs_imp52_idx" ON "keyword_current_summary" USING btree ("improvement_52w");--> statement-breakpoint
CREATE INDEX "kcs_category_idx" ON "keyword_current_summary" USING btree ("current_week_end_date","top_clicked_category_1_current");--> statement-breakpoint
CREATE INDEX "kcs_severity_idx" ON "keyword_current_summary" USING btree ("current_week_end_date","fake_volume_severity_current");--> statement-breakpoint
-- Seed the default v1 fake-volume rule. The SQL CASE in processFileImport
-- hard-codes thresholds that match the JSON below — both must change
-- together until Plan 3.5 ships a JSON-driven rule evaluator.
INSERT INTO "fake_volume_rules" ("version_name", "is_active", "warning_rules_json", "critical_rules_json")
VALUES (
  'v1-default',
  true,
  '[{"if":"click_share_1 > 5 AND conversion_share_1 < 0.5"},{"if":"click_share_1 > 10 AND conversion_share_1 < 1.0"}]'::jsonb,
  '[{"if":"click_share_1 > 20 AND conversion_share_1 < 0.5"},{"if":"click_share_1 > 30 AND conversion_share_1 < 1.0"}]'::jsonb
);
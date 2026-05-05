ALTER TABLE "keyword_current_summary" ADD COLUMN "keyword_in_title_1_loose_current" boolean;--> statement-breakpoint
ALTER TABLE "keyword_current_summary" ADD COLUMN "keyword_in_title_2_loose_current" boolean;--> statement-breakpoint
ALTER TABLE "keyword_current_summary" ADD COLUMN "keyword_in_title_3_loose_current" boolean;--> statement-breakpoint
ALTER TABLE "keyword_current_summary" ADD COLUMN "keyword_title_match_count_loose_current" smallint;--> statement-breakpoint
CREATE INDEX "kcs_title_match_loose_idx" ON "keyword_current_summary" USING btree ("current_week_end_date","keyword_title_match_count_loose_current");
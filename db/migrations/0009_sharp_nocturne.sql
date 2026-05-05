ALTER TABLE "keyword_current_summary" ADD COLUMN "top_clicked_product_1_click_share_current" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "keyword_current_summary" ADD COLUMN "top_clicked_product_1_conversion_share_current" numeric(5, 2);--> statement-breakpoint
CREATE INDEX "kcs_jump_4w_idx" ON "keyword_current_summary" USING btree ("rank_4w_ago","current_rank");--> statement-breakpoint
CREATE INDEX "kcs_jump_13w_idx" ON "keyword_current_summary" USING btree ("rank_13w_ago","current_rank");--> statement-breakpoint
CREATE INDEX "kcs_jump_26w_idx" ON "keyword_current_summary" USING btree ("rank_26w_ago","current_rank");--> statement-breakpoint
CREATE INDEX "kcs_jump_52w_idx" ON "keyword_current_summary" USING btree ("rank_52w_ago","current_rank");
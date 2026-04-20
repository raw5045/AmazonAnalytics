CREATE TABLE "staging_weekly_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"uploaded_file_id" uuid NOT NULL,
	"week_end_date" date NOT NULL,
	"search_term_raw" varchar(512) NOT NULL,
	"search_term_normalized" varchar(512) NOT NULL,
	"search_term_id" uuid,
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
	"top_clicked_product_1_click_share" numeric(5, 2),
	"top_clicked_product_2_click_share" numeric(5, 2),
	"top_clicked_product_3_click_share" numeric(5, 2),
	"top_clicked_product_1_conversion_share" numeric(5, 2),
	"top_clicked_product_2_conversion_share" numeric(5, 2),
	"top_clicked_product_3_conversion_share" numeric(5, 2),
	"keyword_in_title_1" boolean,
	"keyword_in_title_2" boolean,
	"keyword_in_title_3" boolean,
	"keyword_title_match_count" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staging_weekly_metrics" ADD CONSTRAINT "staging_weekly_metrics_batch_id_upload_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."upload_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_weekly_metrics" ADD CONSTRAINT "staging_weekly_metrics_uploaded_file_id_uploaded_files_id_fk" FOREIGN KEY ("uploaded_file_id") REFERENCES "public"."uploaded_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_weekly_metrics" ADD CONSTRAINT "staging_weekly_metrics_search_term_id_search_terms_id_fk" FOREIGN KEY ("search_term_id") REFERENCES "public"."search_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staging_file_idx" ON "staging_weekly_metrics" USING btree ("uploaded_file_id");--> statement-breakpoint
CREATE INDEX "staging_normalized_idx" ON "staging_weekly_metrics" USING btree ("search_term_normalized");
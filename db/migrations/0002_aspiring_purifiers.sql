CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."fake_volume_eval_status" AS ENUM('evaluated', 'unknown_missing_conversion', 'unknown_missing_click');--> statement-breakpoint
CREATE TABLE "search_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_term_raw" varchar(512) NOT NULL,
	"search_term_normalized" varchar(512) NOT NULL,
	"first_seen_week" date NOT NULL,
	"last_seen_week" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reporting_weeks" (
	"week_end_date" date PRIMARY KEY NOT NULL,
	"week_start_date" date NOT NULL,
	"source_file_id" uuid,
	"is_complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "uploaded_files" ADD COLUMN "replaced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reporting_weeks" ADD CONSTRAINT "reporting_weeks_source_file_id_uploaded_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."uploaded_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_terms_normalized_idx" ON "search_terms" USING btree ("search_term_normalized");--> statement-breakpoint
CREATE INDEX "search_terms_normalized_trgm_idx" ON "search_terms" USING gin ("search_term_normalized" gin_trgm_ops);
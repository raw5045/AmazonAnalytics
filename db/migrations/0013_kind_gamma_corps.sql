-- Defense-in-depth: reject any future search_terms row whose
-- normalized form is empty. Won't break existing data (we already
-- have no empty-normalized rows) and catches a class of bugs cheap.
ALTER TABLE "search_terms"
  ADD CONSTRAINT "search_terms_normalized_not_empty"
  CHECK ("search_term_normalized" <> '');
--> statement-breakpoint
CREATE TABLE "import_duplicate_search_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploaded_file_id" uuid NOT NULL,
	"week_end_date" date NOT NULL,
	"search_term_id" uuid NOT NULL,
	"search_term_normalized" varchar(512) NOT NULL,
	"duplicate_count" integer NOT NULL,
	"winning_rank" integer NOT NULL,
	"losing_ranks" integer[] NOT NULL,
	"raw_examples" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staging_weekly_metrics" ADD COLUMN "search_term_raw_original" varchar(512) NOT NULL;--> statement-breakpoint
ALTER TABLE "staging_weekly_metrics" ADD COLUMN "had_unicode_noise" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "staging_weekly_metrics" ADD COLUMN "source_row_number" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "import_duplicate_search_terms" ADD CONSTRAINT "import_duplicate_search_terms_uploaded_file_id_uploaded_files_id_fk" FOREIGN KEY ("uploaded_file_id") REFERENCES "public"."uploaded_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_duplicate_search_terms" ADD CONSTRAINT "import_duplicate_search_terms_search_term_id_search_terms_id_fk" FOREIGN KEY ("search_term_id") REFERENCES "public"."search_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idst_file_idx" ON "import_duplicate_search_terms" USING btree ("uploaded_file_id");--> statement-breakpoint
CREATE INDEX "idst_week_idx" ON "import_duplicate_search_terms" USING btree ("week_end_date");
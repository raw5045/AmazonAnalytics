CREATE TYPE "public"."schema_version_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('uploaded', 'validating', 'clean', 'partial_review', 'blocked', 'importing', 'imported', 'imported_partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."batch_type" AS ENUM('single_csv', 'zip_backfill');--> statement-breakpoint
CREATE TYPE "public"."ingestion_severity" AS ENUM('error', 'warning', 'info');--> statement-breakpoint
CREATE TYPE "public"."validation_status" AS ENUM('pending', 'pass', 'pass_with_warnings', 'fail', 'import_failed', 'imported');--> statement-breakpoint
CREATE TABLE "schema_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_number" integer NOT NULL,
	"status" "schema_version_status" DEFAULT 'draft' NOT NULL,
	"header_row_index" integer NOT NULL,
	"required_columns_json" jsonb NOT NULL,
	"header_hash" varchar(64) NOT NULL,
	"sample_file_id" uuid,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploaded_file_id" uuid NOT NULL,
	"severity" "ingestion_severity" NOT NULL,
	"code" varchar(64) NOT NULL,
	"message" text NOT NULL,
	"row_number" integer,
	"column_name" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_type" "batch_type" NOT NULL,
	"status" "batch_status" DEFAULT 'uploaded' NOT NULL,
	"schema_version_id" uuid,
	"failure_threshold_pct" integer DEFAULT 10 NOT NULL,
	"total_files" integer DEFAULT 0 NOT NULL,
	"passed_files" integer DEFAULT 0 NOT NULL,
	"warning_files" integer DEFAULT 0 NOT NULL,
	"failed_files" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"summary_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "uploaded_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"schema_version_id" uuid,
	"storage_key" varchar(1024) NOT NULL,
	"original_filename" varchar(512) NOT NULL,
	"file_checksum" varchar(64),
	"week_end_date" date,
	"week_start_date" date,
	"reporting_date_raw" varchar(64),
	"metadata_row_raw" text,
	"validation_status" "validation_status" DEFAULT 'pending' NOT NULL,
	"validation_errors_json" jsonb,
	"validation_warnings_json" jsonb,
	"validation_info_json" jsonb,
	"row_count_raw" integer,
	"row_count_loaded" integer,
	"is_replacement" boolean DEFAULT false NOT NULL,
	"replaces_file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(128) NOT NULL,
	"value_json" jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" varchar(128) NOT NULL,
	"entity_type" varchar(128),
	"entity_id" uuid,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schema_versions" ADD CONSTRAINT "schema_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_errors" ADD CONSTRAINT "ingestion_errors_uploaded_file_id_uploaded_files_id_fk" FOREIGN KEY ("uploaded_file_id") REFERENCES "public"."uploaded_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_batches" ADD CONSTRAINT "upload_batches_schema_version_id_schema_versions_id_fk" FOREIGN KEY ("schema_version_id") REFERENCES "public"."schema_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_batches" ADD CONSTRAINT "upload_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_batch_id_upload_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."upload_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_schema_version_id_schema_versions_id_fk" FOREIGN KEY ("schema_version_id") REFERENCES "public"."schema_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
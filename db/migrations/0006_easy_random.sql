CREATE TABLE "import_phase_timings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uploaded_file_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_ms" bigint NOT NULL,
	"rows_affected" bigint,
	"notes" jsonb
);
--> statement-breakpoint
ALTER TABLE "uploaded_files" ADD COLUMN "import_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_phase_timings" ADD CONSTRAINT "import_phase_timings_uploaded_file_id_uploaded_files_id_fk" FOREIGN KEY ("uploaded_file_id") REFERENCES "public"."uploaded_files"("id") ON DELETE cascade ON UPDATE no action;
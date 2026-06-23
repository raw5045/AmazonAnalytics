-- 0038_custom_categories
-- Per-user named sets of leaf-category names for the Category Builder tab.
CREATE TABLE IF NOT EXISTS "custom_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" varchar(80) NOT NULL,
  "leaf_names" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_categories_user_created_idx" ON "custom_categories" ("user_id", "created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_categories_user_name_uniq" ON "custom_categories" ("user_id", lower("name"));

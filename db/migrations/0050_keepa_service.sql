-- 0050 (hand-numbered, applied by the untracked scripts/applyMigration0050.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-05 §4.
-- Three ADDITIVE tables for the always-on Keepa service. asin_weekly_data is untouched.
-- Safe to apply before any code that reads these tables is deployed.
CREATE TABLE IF NOT EXISTS asin_products (
  asin text PRIMARY KEY,
  title text,
  brand text,
  image_url text,
  category_path text,
  category_root text,
  category_leaf text,
  listed_since date,
  tracking_since date,
  current_price_cents integer,
  price_source text CHECK (price_source IN ('amazon', 'new')),
  sales_rank integer,
  review_count integer,
  average_rating_x10 integer,
  last_rating_update date,
  monthly_sold integer,
  keepa_updated_at date,
  new_offer_count integer,
  fba_offer_count integer,
  fbm_offer_count integer,
  amazon_availability smallint,
  avg30_price_cents integer,
  avg90_price_cents integer,
  avg180_price_cents integer,
  avg365_price_cents integer,
  avg30_sales_rank integer,
  avg90_sales_rank integer,
  enrichment_status asin_enrichment_status,
  error_code text,
  last_fetched_at timestamptz,
  fetch_count integer NOT NULL DEFAULT 0,
  consecutive_errors integer NOT NULL DEFAULT 0,
  in_scope boolean NOT NULL DEFAULT true,
  best_rank integer,
  scope_week date,
  tier smallint NOT NULL DEFAULT 2 CHECK (tier IN (1, 2)),
  next_due_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
COMMENT ON TABLE asin_products IS
  'One row per ASIN: current Keepa facts + the Keepa service queue state. enrichment_status NULL = never fetched. Spec 2026-10-05 §4.1.';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asin_products_never_fetched_idx
  ON asin_products (tier, best_rank)
  WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asin_products_due_idx
  ON asin_products (tier, next_due_at)
  WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asin_products_claimed_idx
  ON asin_products (claimed_at)
  WHERE claimed_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asin_products_category_path_idx
  ON asin_products (category_path)
  WHERE category_path IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS asin_snapshots (
  asin text NOT NULL,
  fetched_at timestamptz NOT NULL,
  current_price_cents integer,
  sales_rank integer,
  review_count integer,
  average_rating_x10 integer,
  monthly_sold integer,
  new_offer_count integer,
  fba_offer_count integer,
  fbm_offer_count integer,
  enrichment_status asin_enrichment_status NOT NULL,
  PRIMARY KEY (asin, fetched_at)
);
--> statement-breakpoint
COMMENT ON TABLE asin_snapshots IS
  'One narrow row per Keepa fetch (point-in-time price, rank, reviews, monthly sold, offer counts). Spec 2026-10-05 §4.2.';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS keepa_service_status (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  boot_id text,
  booted_at timestamptz,
  heartbeat_at timestamptz,
  last_batch_at timestamptz,
  last_batch_lane text,
  tokens_left integer,
  refill_rate integer,
  tail_enabled boolean NOT NULL DEFAULT false,
  last_error_code text,
  last_error_at timestamptz,
  lane_new_drained_at timestamptz,
  sync_fired_at timestamptz,
  nightly_sync_date date,
  down_alarm_sent_at timestamptz,
  stall_alarm_sent_at timestamptz
);
--> statement-breakpoint
COMMENT ON TABLE keepa_service_status IS
  'Single row: Keepa service heartbeat + the main-worker watcher bookkeeping. Spec 2026-10-05 §4.3.';

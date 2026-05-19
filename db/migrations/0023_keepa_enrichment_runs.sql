-- Tracks each Keepa enrichment run for a given week. Replaces the
-- step.run-checkpoint model that fought infrastructure failures
-- (connection resets, HTTP timeouts) every few hours during the long
-- backfill.
--
-- New model: the Inngest function only orchestrates (claim → kickoff →
-- wait → email), all cheap operations. The actual work runs as a
-- detached Promise on the Railway worker, with state tracked in this
-- table. Mirrors the existing pattern in worker/jobs.ts +
-- inngest/functions/importBatch.ts for CSV imports.
--
-- One "run" represents one attempt to enrich a week. If the worker
-- dies mid-run (Railway redeploy, OOM, etc.), the heartbeat goes
-- stale; the orchestrator detects this within ~10 minutes and the
-- next event can take over.
--
-- A partial unique index enforces "at most one running enrichment
-- per week" at the database layer — robust against any orchestrator-
-- level race that might try to spawn two parallel runs.

CREATE TABLE keepa_enrichment_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_end_date       date NOT NULL,
  status              text NOT NULL CHECK (status IN (
                        'running', 'completed', 'failed', 'orphaned'
                      )),

  -- Lifecycle timestamps
  started_at          timestamptz NOT NULL DEFAULT now(),
  heartbeat_at        timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,

  -- Worker identity at start. If a new orchestrator sees a 'running'
  -- row whose owner_boot_id no longer matches the live worker's
  -- BOOT_ID, AND heartbeat is stale, the previous worker has died.
  owner_boot_id       text,

  -- Progress + denormalized status counts (updated as batches complete,
  -- so the heartbeat carries useful info beyond "I'm alive").
  total_asins         integer,                                -- set right after listScope
  processed_asins     integer NOT NULL DEFAULT 0,             -- includes errors
  active_count        integer NOT NULL DEFAULT 0,
  no_price_count      integer NOT NULL DEFAULT 0,
  delisted_count      integer NOT NULL DEFAULT 0,
  error_count         integer NOT NULL DEFAULT 0,

  -- Failure detail (when status = 'failed' or 'orphaned')
  error_message       text
);

-- Find the current/latest run for a week
CREATE INDEX keepa_runs_week_started_idx
  ON keepa_enrichment_runs (week_end_date, started_at DESC);

-- One running run per week, enforced at the DB level
CREATE UNIQUE INDEX keepa_runs_one_active_per_week_idx
  ON keepa_enrichment_runs (week_end_date)
  WHERE status = 'running';

-- For dashboards / future "what runs are stuck" queries
CREATE INDEX keepa_runs_status_heartbeat_idx
  ON keepa_enrichment_runs (status, heartbeat_at)
  WHERE status = 'running';

COMMENT ON TABLE keepa_enrichment_runs IS
  'One row per Keepa enrichment attempt for a given week. Owned by the '
  'detached background job in worker/keepaJobs.ts and observed by the '
  'orchestrator in inngest/functions/enrichKeepaForWeek.ts via heartbeat + '
  'completion event.';

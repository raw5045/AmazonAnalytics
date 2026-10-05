# Keepa service

Always-on enrichment loop (spec `docs/superpowers/specs/2026-10-05-keepa-service-design.md`). Runs as its own Railway service from this repo; talks only to Keepa and Neon.

## Railway settings (dashboard — Config as Code is deprecated for new services)

| Setting | Value |
|---|---|
| Custom Build Command | `echo "no build - tsx runs the source"` |
| Custom Start Command | `pnpm tsx services/keepa/index.ts` |
| Healthcheck Path | `/` |
| Restart Policy | On Failure, max retries 10 |
| Watch Paths | `/services/keepa/**`, `/lib/keepa/**`, `/package.json`, `/pnpm-lock.yaml` |
| App Sleeping | off |

Variables: `DATABASE_URL` (the worker's value), `KEEPA_API_KEY`; `KEEPA_TAIL_LANE=1` turns on the tier-2 lane. Set by the owner in the dashboard; never in the repo.

## What it does

Every iteration: release claims older than ten minutes → claim up to 100 due ASINs lane by lane (tier-1 never-fetched by rank, tier-1 due oldest first, tier 2 only with the tail on) → wait for tokens → one Keepa request (`rating=1&stats=90`, no history) → parse/validate → one transaction (catalog upsert, snapshots, claims cleared, status row). Nothing due: heartbeat and a 60-second nap.

Status lives in `keepa_service_status`; the admin page `/admin/keepa-enrichment` shows it; the main worker's watcher cron emails on a stale heartbeat or a stall and fires the explorer aggregate sync.

Logs: one JSON line per batch under `[keepa-svc]`, coded errors only.

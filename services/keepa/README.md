# Keepa service

Always-on enrichment loop (spec `docs/superpowers/specs/2026-10-05-keepa-service-design.md`). Runs as its own Railway service from this repo; talks only to Keepa and Neon.

## Railway settings (dashboard — Config as Code is deprecated for new services)

| Setting | Value |
|---|---|
| Custom Build Command | `echo "no build - tsx runs the source"` |
| Custom Start Command | `pnpm tsx services/keepa/index.ts` |
| Healthcheck Path | `/` |
| Restart Policy | On Failure, max retries 10 |
| Replicas | 1 only (two would draw on one Keepa token bucket, each pacing as if it were alone) |
| Watch Paths | `/services/keepa/**`, `/lib/keepa/**`, `/package.json`, `/pnpm-lock.yaml` |
| App Sleeping | off |

Variables: `DATABASE_URL` (the worker's value), `KEEPA_API_KEY`; `KEEPA_TAIL_LANE=1` turns on the tier-2 lane. Set by the owner in the dashboard; never in the repo.

## What it does

Every iteration: release claims older than ten minutes → probe the old enrichment job (yield while it runs) → claim up to 100 due ASINs lane by lane (tier-1 never-fetched by rank, tier-1 due oldest first, tier 2 only with the tail on) → wait for tokens → probe again (before every request, retries included) → one Keepa request (`rating=1&stats=90`, no history) → parse/validate → one transaction (catalog update, snapshots, claims cleared, status row). Nothing due: heartbeat and a 60-second nap.

Before each batch the loop waits for Keepa's next refill when the balance is short (Keepa adds `refillRate` tokens once a minute; `refillIn` says when) and keeps `TOKEN_RESERVE` (50) tokens in the bucket after a batch so the old import-time job's two-token calls (its per-ASIN requests cost 2 tokens) never find it empty during the shadow week. Throughput is unchanged: 250 tokens/min.

Status lives in `keepa_service_status`; the admin page `/admin/keepa-enrichment` shows it; the main worker's watcher cron emails on a stale heartbeat or a stall and fires the explorer aggregate sync.

## Operations

- **The weekly enqueue pauses the service.** While an import's enqueue-week step runs (it holds the enqueue lock, up to ~30 minutes), every store transaction waits for it: no claims, no writes, then the loop carries on by itself. The heartbeat keeps landing every 60 seconds meanwhile (it does not wait on that lock), so the watcher sees the service alive.
- **Shares the Keepa token bucket with the old import-time enrichment job until phase 3:** the service idles (`yield_old_job`) while any `keepa_enrichment_runs` row has a heartbeat from the last 10 minutes — the probe ignores the run's status, since a detached run past its poll budget is marked `orphaned` yet keeps heartbeating (a diff run lasts about 3.4 hours and starts when the import finishes; a manual full refresh runs about 23 hours). It probes before claiming and again before every Keepa request, so a run that starts mid-batch gets the bucket at once (that batch's claims are released unfetched). Never press the admin full-refresh button while the service runs.
- **Stopping it is safe.** Claims left behind free themselves after 10 minutes; on SIGTERM (a Railway redeploy or stop) the service releases its own claims at once (given at most 10 seconds) and exits. A `sigterm` line appears only if Railway's draining seconds are above 0 (otherwise the claims free themselves after 10 minutes).
- **Health:** `/` answers 503 `{"ok":false,"booting":true}` until this boot is on the status row, then 200.
- **Exits:** ten database failures in a row end the process with code 1 (Railway restarts it). Keepa trouble never does: it is retried, paused for, and recorded as the status row's last error.
- **The integration test** (`tests/integration/keepaService.test.ts`) needs the service STOPPED and no weekly enqueue in progress; it claims real rows for a moment and releases them.

### Log events

Every line is `[keepa-svc]` plus one JSON object with coded fields only (an error's class name, a Postgres `code`, an HTTP `status`, a network `causeCode`, never a message or the key).

| Event | Meaning |
|---|---|
| `batch` | A batch was fetched and written: outcome counts, tokens left, `tokenWaitMs` (the token wait before it; up to a minute, the wait for Keepa's next refill, is normal), `ms` for fetch + parse + write. |
| `batch_errored` | Keepa never answered after three attempts (or answered 400 three times): the rows were marked errored with `code`. |
| `batch_all_errors` | Keepa answered but no product was usable: the rows were written with their error backoff, and `code` (the most common error) became the status row's last error. |
| `keepa_retry` | One failed attempt (`attempt` 1–3) of a batch request. |
| `keepa_rejected` | Keepa refused the request (401/402/403 and other 4xx except 400): recorded, retried every 10 minutes until fixed. |
| `token_wait` | A token wait over a minute is starting: `ms` (at most 2 minutes). Shorter waits appear only as `tokenWaitMs` on the `batch` line. |
| `tokens_exhausted` | `consecutive` 429s since the last good fetch (5 or more): recorded as `keepa_tokens_exhausted`. |
| `outage_pause` | Pausing `ms` before the next claim after a batch Keepa never answered, an all-error batch of 10+ rows, or a second 400 in a row: 1 minute, doubling to 15, back to none after a batch with any success. |
| `db_error` | A database step (`stage`) failed; `failures` in a row, ten end the process. |
| `iteration_threw` | An unexpected error escaped an iteration; counted like a database failure. |
| `heartbeat_failed` | The 60-second heartbeat could not reach the database. |
| `stale_claims_released` | `count` claims older than 10 minutes (left by a dead process) were freed. |
| `sigterm` | Shutdown: `released` own claims (null when the release failed or ran past 10 seconds). |
| `yield_old_job` | The old import-time enrichment job is running (a `keepa_enrichment_runs` heartbeat from the last 10 minutes, whatever the status): no claims, a heartbeat and a 60-second nap per tick until it ends; a batch caught mid-way has its claims released before any request. Logged once per run. |
| `resume_after_old_job` | The old job's run ended; claiming resumes. |
| `release_own_claims_failed` | Releasing a mid-batch yield's claims failed; the 10-minute stale release frees them instead. |
| `server_statement_timeout_failed` | The boot-time `SHOW statement_timeout` failed; it is only logged, nothing depends on it. |
| `token_status_failed` | The boot-time free token-status call failed; the first batch reply reveals the balance instead. |

Rarer lines: `listening`, `server_statement_timeout` and `token_status` at boot; `pool_error`, `record_error_failed`, `drained_stamp_failed`, `exit_db_failures`, `boot_failed`.

# Import notifications RFC

Owner: Reese
Status: Draft for review
Predecessor: Plan 3.2 perf work — uncovered the `import_phase` stuck-state bug and surfaced the need for proactive completion signals

## Goal

Tell admins when a weekly import has finished — and whether it succeeded — without them having to babysit `/admin/batches`.

Two surfaces, intentionally redundant:

1. **In-app header banner** in `/admin/*` — visible whenever an admin is in the app
2. **Email via Resend** — reaches admins who aren't currently in the app

Both fire on the SAME signal: an `uploaded_files` row transitioning to `import_phase = 'completed'` or `import_phase = 'completed_with_refresh_failure'`. **Not** on `validation_status = 'imported'` — that flips before `summary_refresh` runs and would falsely declare victory ~30 minutes early.

## Out of scope (explicitly)

- Browser push notifications (system notifications when the tab isn't focused). Nice-to-have but adds service-worker complexity. Defer.
- Slack / Discord / SMS integrations.
- Notifications for events other than imports (e.g., "rubric approved," "user signed up"). The notification model below is general enough to support these later, but V1 only handles imports.
- Real-time updates via WebSocket / SSE. Polling is good enough at the cadence we need; will revisit if it ever feels laggy.
- Per-user notification preferences UI. V1: every admin gets every notification. We can add a preferences table when needed.

## 1. The trigger

The single source of truth is the `uploaded_files.import_phase` column. The `processFileImport` worker writes this at the end of every import:

| Final value | Meaning |
|---|---|
| `'completed'` | Import + summary refresh both succeeded. Full success. |
| `'completed_with_refresh_failure'` | kwm rows landed cleanly but the kcs refresh threw. Data is in the warehouse but the explorer's snapshot is stale. Recover with `pnpm tsx scripts/refreshSummaryOnce.ts`. |
| Anything else (`'staging_copy'`, `'kwm_insert'`, `'summary_refresh'`, `'lock_acquired'`, …) | Still in progress, or stuck. The orchestrator's orphan-detection will eventually surface a stuck file as `validation_status = 'import_failed'`. |

Imports that fail before reaching the final write (mid-staging crash, validation rejection, etc.) end up with `validation_status = 'import_failed'` — that's the signal for the failure-side notification.

### Why this two-column dance

`validation_status` is the **terminal data state** (does the data exist in kwm?). `import_phase` is the **operational breadcrumb** (what was the last thing the worker did?). For the user, "is this import done in a way I care about?" needs both: kwm rows + kcs refreshed. So the notification key is the `import_phase` transition, and the notification payload reports the `validation_status` for the success/failure-text framing.

## 2. Header banner

### Visual

A thin colored chip at the top of every `/admin/*` page (rendered in `app/admin/layout.tsx`).

States:

| State | Color | Text | Click |
|---|---|---|---|
| Idle (no recent activity) | hidden | — | — |
| Import in progress | gray | "Import in progress: \<filename\> · started 12 min ago" | → `/admin/batches/{batchId}` |
| Recently completed | green | "Import complete: \<filename\> · 32 min" | → `/admin/batches/{batchId}` |
| Recently failed | red | "Import failed: \<filename\> · check details" | → `/admin/batches/{batchId}/files/{fileId}` |
| Refresh failed only | amber | "Import OK, summary stale: \<filename\>" | → `/admin/batches/{batchId}/files/{fileId}` |

Recency window: 30 min after the most recent terminal transition. After 30 min, the chip auto-dismisses unless dismissed manually first.

### Data + polling

A new server endpoint `GET /api/admin/notifications/import-status` returns the most recent import-related state for a single admin user:

```json
{
  "active": [
    { "fileId": "...", "batchId": "...", "filename": "...", "phase": "summary_refresh", "startedAt": "..." }
  ],
  "recent": [
    { "fileId": "...", "batchId": "...", "filename": "...", "outcome": "completed", "completedAt": "...", "durationMs": 1900000 }
  ]
}
```

Client component polls every 30 s using a regular fetch (no SSE, no WebSocket). On state change, updates the chip. Cheap query — uses indexed lookups on `uploaded_files`.

### Dismissal

Clicking the X dismisses for the current admin. Stored client-side in `localStorage` keyed by `fileId`, so dismissals don't need a DB round-trip and survive page navigations within the session.

### Why a chip, not a toast

A toast disappears too fast. An admin who refreshes the page after the toast vanished would have no idea anything happened. The chip persists across navigations and across reloads (until dismissed or until the 30-min recency window passes), which matches how an "is my import done?" mental check actually works.

## 3. Email via Resend

### Trigger

Same DB transition as the banner: a write of `import_phase = 'completed'` or `'completed_with_refresh_failure'`, or a write of `validation_status = 'import_failed'`. The email send happens **inside `processFileImport`**, after the phase is written, so a worker crash between phase-write and email-send is the only way to miss an email — acceptable.

### Recipients

V1: every user with `role = 'admin'`. Selected via `SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL`.

V2 (future): per-user toggle to opt out, plus a "notify only on failure" mode for users who don't want green-light emails.

### Templates

Three message templates, all plain text + a small HTML version. Subject + first line of body designed to be self-contained (mobile push preview only shows ~50 chars).

**Success:**
```
Subject: ✓ Import succeeded: Week 2026-04-25
Body:
The weekly import of US_Top_Search_Terms_Simple_Week_2026_04_25.csv completed successfully.

Duration: 32 min
Rows imported (kwm): 3,094,002
Rows in current_summary after refresh: 3,882,892
Latest week: 2026-04-25

View details: https://amazon-analytics-beta.vercel.app/admin/batches/{batchId}
```

**Refresh-only failure:**
```
Subject: ⚠ Import OK but summary stale: Week 2026-04-25
Body:
The weekly import of US_Top_Search_Terms_Simple_Week_2026_04_25.csv landed cleanly into kwm but the keyword_current_summary refresh failed.

The explorer page will continue to show the prior week's snapshot until you run:
  pnpm tsx scripts/refreshSummaryOnce.ts

Refresh error: <errorMessage>

View details: https://amazon-analytics-beta.vercel.app/admin/batches/{batchId}
```

**Hard failure:**
```
Subject: ✗ Import failed: Week 2026-04-25
Body:
The weekly import of US_Top_Search_Terms_Simple_Week_2026_04_25.csv did not complete.

Last phase: <phase>
Error: <errorMessage>

The data did NOT make it into kwm. Re-upload the file once the issue is fixed.

View details: https://amazon-analytics-beta.vercel.app/admin/batches/{batchId}
```

### Resend wiring

- Add `@resend/node` SDK
- Env var: `RESEND_API_KEY` (Vercel + Railway worker)
- A single helper `lib/notifications/sendImportEmail.ts`:
  ```ts
  await sendImportEmail({
    outcome: 'completed' | 'completed_with_refresh_failure' | 'failed',
    file: { id, filename },
    batch: { id },
    metrics: { durationMs, rowsImported, ... }
  });
  ```
- Domain: configure a verified sender on Resend (e.g., `notifications@<domain>`). For testing pre-domain, Resend allows sending from `onboarding@resend.dev` to verified test recipients.

### Failure modes

If Resend itself is down or returns an error: log it, don't fail the import. The header banner is the redundancy — the user will still see status from there.

## 4. Architecture / files

### New

```
lib/notifications/
  sendImportEmail.ts          # Resend wrapper + template selection
  buildImportEmail.test.ts    # Snapshot tests for the 3 email templates

app/api/admin/notifications/
  import-status/route.ts      # GET endpoint feeding the header chip

app/admin/
  ImportStatusChip.tsx        # Client component, polls /api endpoint, renders chip

inngest/functions/importFile.ts
  - Hook the email send into the existing phase-finalization block
```

### Modified

```
app/admin/layout.tsx          # Mount <ImportStatusChip /> in the header
lib/env.ts                    # Add RESEND_API_KEY (optional in dev)
```

### Schema

No changes for V1. Reusing `uploaded_files.import_phase`, `validation_status`, `import_started_at`, etc.

## 5. Implementation sequence

Suggest ~4 commits:

1. **`sendImportEmail` helper + Resend integration + tests** (~1 day)
   - Snapshot tests for the 3 templates
   - Wire into `processFileImport`'s phase-finalize block
   - Manually trigger by running the next weekly import after deploy
2. **`/api/admin/notifications/import-status` endpoint** (~3 hrs)
   - Pure read, no auth surface beyond requireAdmin
   - Test by hitting it directly
3. **`ImportStatusChip` client component** (~half day)
   - Polling, state machine, dismissal, click-through
4. **Mount in admin layout + visual polish** (~3 hrs)

Total: ~2-3 days of focused work.

## 6. Open questions

1. **Sender address** — what email address do you want notifications to come from? `notifications@<domain>` requires verifying a domain in Resend (~30 min via DNS). Alternative is to use Resend's `onboarding@resend.dev` for testing, then switch to a verified domain later.

2. **Recipient list** — every admin always, or only the admin who initiated the upload? The latter requires `upload_batches` to track `created_by_user_id` (likely already there — needs a check). My read: V1 = every admin, since imports are infrequent and the team is small.

3. **Banner persistence on completion** — 30 min auto-dismiss is my proposal. Reasonable, or do you want it to stick until manually dismissed?

4. **Failure-only email mode** — a single per-admin "only email me on failures" toggle. Worth building V1 or defer until someone complains?

5. **Mobile rendering** — should we send a separate plain-text + HTML email, or just plain text? Plain text always works, HTML is prettier in clients that render it. I'd default to both via Resend's built-in support.

## 7. What I want feedback on

- Are the 3 email templates the right shape, or should they say more / less?
- Banner colors / states acceptable? Anything missing?
- 30-second polling frequency — too aggressive (battery, server load) or too relaxed?
- Anything in section 6 you want to settle now vs leave as default?

---

*Spec ready for review. Implementation can start once decisions on §6 are made.*

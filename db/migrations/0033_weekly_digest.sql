-- Weekly digest email: opt-out flag + send-tracking tables.
--
-- See docs/superpowers/specs/2026-05-31-weekly-digest-email-design.md.
--
-- weekly_digest_subscribed defaults to true so the first broadcast
-- reaches everyone and new accounts inherit subscription automatically
-- (syncUserFromClerk's INSERT needs no change).
--
-- weekly_digest_runs: one row per week sent. PK on week_end_date is the
-- idempotency gate — a week can never be sent twice.
--
-- weekly_digest_sends: one row per (week, user). The grain at which
-- sends are idempotent and retryable; retry re-sends only failed rows.

ALTER TABLE users
  ADD COLUMN weekly_digest_subscribed BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE weekly_digest_runs (
  week_end_date    date        PRIMARY KEY,
  status           text        NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  recipients_count int         NOT NULL DEFAULT 0,
  sent_count       int         NOT NULL DEFAULT 0,
  failed_count     int         NOT NULL DEFAULT 0,
  triggered_by     uuid        REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE weekly_digest_sends (
  week_end_date  date        NOT NULL REFERENCES weekly_digest_runs(week_end_date) ON DELETE CASCADE,
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant        text        NOT NULL,
  status         text        NOT NULL,
  resend_id      text,
  error          text,
  sent_at        timestamptz,
  PRIMARY KEY (week_end_date, user_id)
);

CREATE INDEX weekly_digest_sends_failed_idx
  ON weekly_digest_sends (week_end_date)
  WHERE status = 'failed';

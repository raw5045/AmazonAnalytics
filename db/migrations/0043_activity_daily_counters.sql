-- 0043: daily activity counters for the admin abuse-digest.
--
-- user_activity_daily: one row per (user, ET calendar day, metric), bumped
-- fire-and-forget from the explorer/detail read paths. ON DELETE CASCADE is
-- deliberate — unlike audit_log's RESTRICT, activity counters must never
-- block a user deletion (the Clerk user.deleted webhook cascade).
--
-- app_activity_daily: app-wide counters with no user (signed-out contact
-- form: submissions + honeypot trips).
--
-- 'day' is the ET (America/New_York) calendar date, computed app-side.
-- See docs/superpowers/specs/2026-07-13-abuse-digest-design.md.

CREATE TABLE IF NOT EXISTS user_activity_daily (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     date NOT NULL,
  metric  varchar(64) NOT NULL,
  count   integer NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, day, metric)
);

CREATE INDEX IF NOT EXISTS user_activity_daily_day_idx
  ON user_activity_daily (day);

CREATE TABLE IF NOT EXISTS app_activity_daily (
  day    date NOT NULL,
  metric varchar(64) NOT NULL,
  count  integer NOT NULL DEFAULT 1,
  PRIMARY KEY (day, metric)
);

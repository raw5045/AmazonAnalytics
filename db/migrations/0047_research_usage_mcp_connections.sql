-- 0047: research usage buckets + MCP connection records
-- (spec docs/superpowers/specs/2026-09-19-mcp-arc1-amendment-design.md §6)
-- Hand-numbered raw SQL: apply with scripts/applyMigration0047.ts after the
-- owner confirms; NOT via drizzle-kit. Inert while MCP tools are unused.

CREATE TABLE IF NOT EXISTS research_usage_buckets (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel      varchar(16) NOT NULL,
  bucket_start timestamptz NOT NULL,
  requests     integer NOT NULL DEFAULT 0,
  "rows"       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel, bucket_start)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS research_usage_buckets_start_idx ON research_usage_buckets (bucket_start);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mcp_connections (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status          varchar(16) NOT NULL DEFAULT 'enabled'
                    CONSTRAINT mcp_connections_status_check CHECK (status IN ('enabled', 'disconnected')),
  disconnected_at timestamptz,
  reconnected_at  timestamptz,
  last_request_at timestamptz,
  last_client_id  varchar(128),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

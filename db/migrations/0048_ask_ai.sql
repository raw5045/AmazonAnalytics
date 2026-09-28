-- 0048: Ask AI — conversations, messages, per-member money ledger, global monthly counter
-- (spec docs/superpowers/specs/2026-09-28-in-app-chat-design.md §8, amended: ask_accounts.conversation_count)
-- Hand-numbered raw SQL: apply with scripts/applyMigration0048.ts after the
-- owner confirms; NOT via drizzle-kit. Inert while ASK_AI_ENABLED is unset.
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ask_conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            text NOT NULL,
  model            varchar(64) NOT NULL,
  message_count    integer NOT NULL DEFAULT 0,
  in_flight_since  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ask_conversations_user_updated_idx ON ask_conversations (user_id, updated_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ask_messages (
  id               uuid PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES ask_conversations(id) ON DELETE CASCADE,
  seq              integer NOT NULL,
  role             varchar(16) NOT NULL CONSTRAINT ask_messages_role_check CHECK (role IN ('user','assistant')),
  parts            jsonb NOT NULL,
  status           varchar(16) NOT NULL DEFAULT 'complete'
                     CONSTRAINT ask_messages_status_check CHECK (status IN ('complete','stopped','failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ask_messages_conversation_seq_key UNIQUE (conversation_id, seq)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ask_accounts (
  user_id                  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access                   boolean NOT NULL DEFAULT true,
  monthly_allowance_micro  bigint NOT NULL DEFAULT 10000000,
  allowance_used_micro     bigint NOT NULL DEFAULT 0,
  period_start             date NOT NULL,
  credit_micro             bigint NOT NULL DEFAULT 0,
  conversation_count       integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ask_ledger (
  id                    bigserial PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                  varchar(24) NOT NULL
                          CONSTRAINT ask_ledger_kind_check CHECK (kind IN ('allowance_reset','grant','credit','usage','adjustment','revoke')),
  amount_micro          bigint NOT NULL,
  -- no FK: append-only audit; a chat deleted mid-answer must never abort the settle (see spec §8 amendment)
  conversation_id       uuid,
  message_id            uuid,
  model                 varchar(64),
  input_tokens          integer,
  cache_write_tokens    integer,
  cache_read_tokens     integer,
  output_tokens         integer,
  from_allowance_micro  bigint,
  from_credit_micro     bigint,
  absorbed_micro        bigint,
  note                  text,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ask_ledger_user_created_idx ON ask_ledger (user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ask_ledger_created_idx ON ask_ledger (created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ask_ledger_created_by_idx ON ask_ledger (created_by) WHERE created_by IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ask_global_usage (
  month            date PRIMARY KEY,
  cost_micro       bigint NOT NULL DEFAULT 0,
  questions        integer NOT NULL DEFAULT 0,
  alerted_80_at    timestamptz,
  alerted_100_at   timestamptz
);

-- 0049 (hand-numbered, applied by the untracked scripts/applyMigration0049.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-01 §7.
ALTER TABLE ask_accounts
  ADD COLUMN IF NOT EXISTS auto_approve_changes boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_approve_deletes boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE ask_conversations
  ADD COLUMN IF NOT EXISTS changes_approved_at timestamptz;

-- Add a new fake_volume_eval_status enum value that signals "we
-- deliberately skipped evaluating this row because its actual_rank is
-- below the meaningful-volume threshold."
--
-- Currently the import path computes severity for every row regardless
-- of rank. For rank > 100,000 the search volume is so small that
-- click_share / conversion_share signals are dominated by rounding
-- noise — high click_share isn't "fake volume manipulation," it's
-- "1 of 2 observed clicks went to one product." Flagging those as
-- warning/critical adds visual clutter without meaning.
--
-- Going forward (migration 0019 + the import path change in the same
-- commit) we'll force severity = 'none' AND eval_status =
-- 'rank_below_threshold' for any row whose actual_rank exceeds the
-- threshold. The threshold lives in code as LOOSE_RANK_THRESHOLD's
-- sibling — see inngest/functions/importFile.ts.

ALTER TYPE fake_volume_eval_status ADD VALUE IF NOT EXISTS 'rank_below_threshold';

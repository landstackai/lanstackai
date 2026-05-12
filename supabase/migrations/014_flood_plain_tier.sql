-- Migration 014: Replace numeric flood_plain_pct with categorical flood_plain.
--
-- Brokers don't typically know the exact flood-plain percentage of a tract,
-- but they do know whether it's affected at all. Switch to a 3-state
-- categorical (Yes / Partial / No) with NULL allowed for unknown.
--
-- The old flood_plain_pct column stays in place (dormant) so historical
-- numeric data isn't lost. We backfill the new column from it:
--   pct = 0       → No
--   pct > 0..60   → Partial
--   pct >= 60     → Yes
--   pct IS NULL   → NULL (unknown)

ALTER TABLE comps ADD COLUMN IF NOT EXISTS flood_plain TEXT;

UPDATE comps
  SET flood_plain = CASE
    WHEN flood_plain_pct IS NULL THEN NULL
    WHEN flood_plain_pct = 0 THEN 'No'
    WHEN flood_plain_pct >= 60 THEN 'Yes'
    WHEN flood_plain_pct > 0 THEN 'Partial'
    ELSE NULL
  END
  WHERE flood_plain IS NULL;

CREATE INDEX IF NOT EXISTS idx_comps_flood_plain
  ON comps(flood_plain) WHERE flood_plain IS NOT NULL;

NOTIFY pgrst, 'reload schema';

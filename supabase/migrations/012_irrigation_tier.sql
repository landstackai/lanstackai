-- Migration 012: Irrigation goes from boolean → 3-tier enum.
--
-- Old shape (from migration 011): has_irrigated_farm BOOLEAN
-- New shape: irrigation TEXT ('None' | 'Medium' | 'Strong')
--
-- "Strong" is the value-driver tier (active center pivot, drip, current row
-- crops) — triggers the IRRIGATION pill in the comp header. All tiers display
-- in the 4-chip grid, mirroring how Water (None/Seasonal/Strong) works.
--
-- has_irrigated_farm is left dormant (not dropped) so existing data isn't
-- lost. We backfill the new column from it and stop reading the old column.

ALTER TABLE comps ADD COLUMN IF NOT EXISTS irrigation TEXT;

-- Backfill: any comp flagged as irrigated maps to 'Strong'; everything else
-- stays NULL (rendered as "—" in the chip grid).
UPDATE comps
  SET irrigation = 'Strong'
  WHERE has_irrigated_farm = true
    AND irrigation IS NULL;

CREATE INDEX IF NOT EXISTS idx_comps_irrigation
  ON comps(irrigation) WHERE irrigation IS NOT NULL;

NOTIFY pgrst, 'reload schema';

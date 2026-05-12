-- Migration 011: Property feature booleans for the value-driver pill system.
--
-- These columns power the three new visible pills on every comp surface
-- (Vault, standalone Comp Detail, CMA workspace, share report, hover popup):
--   * LIVE WATER  — has_live_water
--   * IRRIGATED FARM — has_irrigated_farm
--   * WATER RIGHTS — has_water_rights (collected & searchable but NO pill)
--
-- They mirror the existing has_improvements pattern: a single yes/no field
-- driving both a visual highlight and AI-search filtering. Mineral rights
-- continue to derive from the existing minerals_sold dropdown — no new column.
--
-- The Data Center "best_use" value doesn't need a migration: best_use is a
-- TEXT[] column, the new enum value slots in via the Comp type only.

ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS has_live_water BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_irrigated_farm BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_water_rights BOOLEAN DEFAULT false;

-- Partial indexes — only rows where the flag is true. AI search hits these
-- columns when a query says "irrigated farm" / "live water" / "water rights".
CREATE INDEX IF NOT EXISTS idx_comps_has_live_water
  ON comps(has_live_water) WHERE has_live_water = true;
CREATE INDEX IF NOT EXISTS idx_comps_has_irrigated_farm
  ON comps(has_irrigated_farm) WHERE has_irrigated_farm = true;
CREATE INDEX IF NOT EXISTS idx_comps_has_water_rights
  ON comps(has_water_rights) WHERE has_water_rights = true;

NOTIFY pgrst, 'reload schema';

-- Migration 026: Add city field to comps for proper structured storage.
--
-- Background: the vault has been computing "city" client-side from a
-- heuristic that parses comp.address (typically "Street, City, State Zip").
-- The heuristic works for clean addresses but fails on the descriptive,
-- non-standard addresses common in TX rural land appraisals:
--   "Frio County, TX"                                  → would render "Frio County"
--   "East side of County Road 2875"                    → would render junk
--   "approximately 11 miles NE of Pleasanton"          → no comma, returns null
--
-- The recent heuristic update (NOT_A_CITY regex) correctly filters these
-- to null, but then the column shows nothing. This migration sets up a
-- proper structured city field so:
--   1. Imports can extract city directly (via AI or reverse-geocode)
--   2. Vault reads comp.city as the source of truth, with heuristic +
--      reverse-geocode as fallbacks for legacy rows
--   3. Future filtering / grouping by city becomes possible
--
-- Backfill is intentionally NOT done in this migration. The vault page
-- backfills lazily on render — for each row where comp.city is null but
-- comp.latitude/longitude are set, it kicks off a Mapbox reverse-geocode
-- and writes the result back. One-time per comp, then cached forever.
-- This avoids running geocode in a batch SQL context (no HTTP access)
-- and spreads the cost over normal usage rather than a big migration.

ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS city TEXT NULL;

-- No index needed — city is not currently filtered/sorted at the DB level
-- (vault sort by city happens client-side after the city is computed).

NOTIFY pgrst, 'reload schema';

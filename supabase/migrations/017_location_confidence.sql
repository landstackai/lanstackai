-- Migration 017: Location confidence tracking.
--
-- When auto-locate produces a low-confidence pin (e.g., geocoded to a road
-- intersection without a specific parcel match), we want the UI to flag
-- the comp as "approximate — needs verification" so the broker knows to
-- review and refine.
--
-- Values:
--   'verified'    — coords confirmed (manually set, or auto-located with
--                   high/medium confidence + parcel boundary match)
--   'approximate' — auto-located to a landmark but no specific parcel match;
--                   broker should refine via LocationPicker
--   NULL          — no coords yet (lands in Needs Location)
--
-- Future: 'verified' rows can be further split (auto-high vs auto-medium
-- vs manual) if we want that granularity. For now, binary is enough.

ALTER TABLE comps ADD COLUMN IF NOT EXISTS location_confidence TEXT;

CREATE INDEX IF NOT EXISTS idx_comps_location_confidence
  ON comps(location_confidence) WHERE location_confidence IS NOT NULL;

NOTIFY pgrst, 'reload schema';

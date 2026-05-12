-- Adds a JSONB column to store GeoJSON geometry for each comp.
-- Used by the import flow (CAD-merged owner holdings) and rendered as a
-- polygon overlay on the map.
ALTER TABLE comps ADD COLUMN IF NOT EXISTS boundary_geojson JSONB;

-- Adds subject location + boundary geometry to CMAs so the workspace can
-- render the subject property as a pin and polygon on the map.
ALTER TABLE cmas ADD COLUMN IF NOT EXISTS subject_latitude DOUBLE PRECISION;
ALTER TABLE cmas ADD COLUMN IF NOT EXISTS subject_longitude DOUBLE PRECISION;
ALTER TABLE cmas ADD COLUMN IF NOT EXISTS subject_boundary_geojson JSONB;

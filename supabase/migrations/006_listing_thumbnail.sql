-- Stores a thumbnail URL (typically og:image) extracted from the comp's
-- saved listing page so the CMA can show a quick visual preview.
ALTER TABLE comps ADD COLUMN IF NOT EXISTS listing_thumbnail TEXT;

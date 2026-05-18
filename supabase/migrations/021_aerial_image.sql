-- Migration 021: Persist the source aerial photo per comp.
--
-- The import flow extracts the largest embedded image from the source PDF
-- (via pdfExtractAerial — uses pdfjs to enumerate image XObjects and pick
-- the largest one). Today that aerial is attached to the comp in-memory
-- for the verification card's LEFT thumbnail, but never persisted — so
-- after save, the image data is lost.
--
-- The planned review page (docs/DESIGN_DECISIONS.md §5) needs the aerial
-- available for any comp the broker focuses on later, not just at import
-- time. This column persists it so the review page can render the aerial
-- as a side panel or georeferenced overlay against the matched satellite.
--
-- Stored as a base64-encoded JPEG data URL. Typically 50-200KB per row
-- depending on aerial resolution. Postgres TEXT handles this fine; no
-- need for a separate object-storage hop for the volumes we expect.
--
-- Backfill: existing rows stay NULL. The review page renders a
-- "No source aerial available" state for those — broker can re-import the
-- source PDF if they need the aerial for a specific older comp.

ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS aerial_image TEXT;

-- No index — this column is never queried by, only read by primary key
-- when a specific comp is opened. Indexing the text column would waste
-- space and slow down inserts for zero query benefit.

NOTIFY pgrst, 'reload schema';

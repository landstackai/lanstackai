-- ─────────────────────────────────────────────────────────────────────────
-- 042_add_source_page_image
--
-- Adds the `source_page_image` column to `comps`.
--
-- WHY THIS EXISTS
--
-- Today, the server/Claude extraction path (import-pdf-orchestrator) stores
-- the full appraisal-page render in `aerial_image`. That render contains
-- the aerial photograph PLUS Property Identification + Transaction Data
-- blocks (the whole page squeezed into one image).
--
-- The map view's bottom-left "Source aerial" thumbnail was designed for
-- JUST the aerial photograph — so the broker can glance at it for context
-- while drawing/verifying the parcel boundary. When the whole page lands
-- there instead, it's an unreadable text block at 220×160px.
--
-- AFTER THIS MIGRATION + THE PIPELINE CHANGE
--
--   aerial_image       = cropped aerial PHOTOGRAPH only
--                        (small thumbnail in bottom-left, click to zoom)
--   source_page_image  = full appraisal-page render
--                        (right-panel "Review Comp Card" thumbnail →
--                         fullscreen modal for verifying extraction)
--
-- BACKFILL
--
-- We do NOT backfill historical rows. Per the broker's explicit decision:
-- existing comps keep their current behavior (full page in aerial_image,
-- null in source_page_image). Only new imports — starting after the
-- pipeline change ships — get the split treatment.
--
-- The review UI handles the null case gracefully:
--   if source_page_image is null → hide the right-panel comp-card button
--                                  (existing aerial_image still renders
--                                  in bottom-left, even if it's a full page)
--
-- ROLLBACK
--
-- Pure additive change. To roll back: `ALTER TABLE comps DROP COLUMN
-- source_page_image;`. No data depends on it for older comps; new comps
-- would lose their full-page reference but still have aerial_image.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS source_page_image TEXT NULL;

COMMENT ON COLUMN comps.source_page_image IS
  'Full appraisal-page render from the source PDF (base64 data URL). Used by the Review Comp Card modal accessible via the right-panel thumbnail. Sibling to aerial_image, which holds the cropped aerial photograph only. Populated by import-pdf-orchestrator for new imports; null for comps imported before migration 042.';

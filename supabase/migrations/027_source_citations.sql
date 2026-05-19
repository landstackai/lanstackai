-- Migration 027: Source citations for extracted numeric fields.
--
-- Background: extraction failures (L&D Farm 8,820 ac, Eatwell River Ranch
-- 9 ac) shared a root cause — the AI returned a wrong value but the system
-- had no way to know WHERE in the document that value came from. With no
-- provenance, broker has no defense against silent wrong extractions.
--
-- Fix: every numeric field gets a paired source citation. The AI's
-- updated prompt requires it to cite the EXACT document location for each
-- value (e.g., "page 2 · Property Description table · 'Gross Land Area'
-- row"). If it can't cite a source, the field returns null + the broker
-- sees the comp flagged for review.
--
-- Columns added (all nullable TEXT — citations are free-form strings):
--   acres_source           — where the acreage came from
--   sale_price_source      — where the sale price came from
--   price_per_acre_source  — where the gross $/ac came from
--   ppa_land_only_source   — where the land-only $/ac came from
--
-- No backfill — existing comps stay NULL for these columns. They'll
-- populate naturally as comps get re-imported or re-extracted. The
-- verification card on import will surface citations whenever they exist.
--
-- Display in UI:
--   Verification card during import: each value shows "↳ from: <source>"
--   Review page Source block: same treatment on the saved comp
--   Vault: not shown (column noise; citations are inspection-time data)

ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS acres_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS sale_price_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS price_per_acre_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS ppa_land_only_source TEXT NULL;

NOTIFY pgrst, 'reload schema';

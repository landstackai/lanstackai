-- Migration 032: Subject Overview fields for the marketing CMA PDF
--
-- The forthcoming marketing-grade PDF (Borgelt-style 5-6 pages) has a
-- "Subject Property" overview page where the broker writes a polished
-- 2-3 paragraph narrative about the property. Per discussion, the
-- "old ranch broker" persona shouldn't have to write polished prose
-- themselves — they jot bullets, GPT-4o-mini drafts polished prose,
-- broker edits + saves.
--
-- Three new columns on cmas:
--
--   subject_overview_notes TEXT NULL
--     The broker's private scratchpad. Bullet points, shorthand,
--     whatever helps the AI generate a good draft. Never appears
--     in the PDF or share report. Broker-only view.
--
--   subject_overview_prose TEXT NULL
--     The polished prose that appears in the PDF + (optionally) on
--     the client share report. Either AI-drafted from notes via the
--     /api/cma/[id]/generate-overview endpoint, OR hand-typed by the
--     broker if they prefer to write it themselves.
--
--   pdf_cover_image_url TEXT NULL
--     Optional broker upload for the PDF cover hero image. NULL =
--     auto-pull from the subject boundary's existing aerial. Upload
--     workflow gets wired up in a future PR (V2 of the PDF build) —
--     column ships now so the PDF endpoint can read from it without
--     a follow-up migration.
--
-- All three are optional. CMAs created before this migration get
-- NULL for all three and the PDF renderer falls back gracefully
-- (use comp data for overview, auto-pull aerial for cover).

ALTER TABLE cmas
  ADD COLUMN IF NOT EXISTS subject_overview_notes TEXT NULL,
  ADD COLUMN IF NOT EXISTS subject_overview_prose TEXT NULL,
  ADD COLUMN IF NOT EXISTS pdf_cover_image_url TEXT NULL;

-- Reload PostgREST schema cache so writes don't hit "Could not find
-- the X column" errors before the next deploy. Same pattern as
-- migrations 028 / 030 / 031.
NOTIFY pgrst, 'reload schema';

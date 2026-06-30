-- ─────────────────────────────────────────────────────────────────────────
-- 044_revert_visibility_forced_selection
--
-- Reverts the forced-selection behavior introduced in migration 043.
--
-- WHY
--
-- Migration 043 added needs_visibility_review (default true) to force the
-- broker to explicitly pick Private/Team/Public on every comp before it
-- could leave needs-review. The broker decided that was too much friction:
-- comps should auto-default to 'team' visibility and ONLY surface a flag
-- if the broker wants to change it.
--
-- WHAT CHANGES
--
--   1. Default flips to false — new imports come in with the flag
--      already cleared, so they don't appear in the "Pick visibility"
--      review reason in the vault.
--   2. Existing rows where the flag is still true (newly imported under
--      043 before this revert) get backfilled to false so they don't
--      surface as stuck-in-review.
--
-- The COLUMN ITSELF stays — it's harmless metadata and could be useful
-- for a future "explicit broker visibility confirmation" workflow if
-- needed. Removing it would require coordinated code drops. Easier to
-- keep the column and just stop using it as a gate.
--
-- The visibility picker UI stays on the review page — broker can still
-- change Private/Team/Public at will. It just isn't a forced choice
-- anymore.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE comps
  ALTER COLUMN needs_visibility_review SET DEFAULT false;

-- Clear any rows that came in under the brief forced-selection regime.
UPDATE comps
SET needs_visibility_review = false
WHERE needs_visibility_review = true;

COMMENT ON COLUMN comps.needs_visibility_review IS
  'DEPRECATED as of migration 044 — kept for schema stability but no longer surfaced as a needs-review gate. Default is now false; review-page visibility picker no longer forces selection. New comps auto-default to visibility=''team'' and broker can change to private or shared at any time via the always-visible picker on the review page.';

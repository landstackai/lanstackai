-- ─────────────────────────────────────────────────────────────────────────
-- 043_needs_visibility_review
--
-- Adds `needs_visibility_review` column to `comps`.
--
-- WHY
--
-- Today, every imported comp is hardcoded to visibility='team' at the
-- 3 upload entry points (main import single/batch, bookmarklet). The
-- broker never makes an explicit choice — every comp becomes
-- team-visible automatically.
--
-- The broker wants forced selection at REVIEW time: explicitly pick
-- Private | Team | Public (mapping to schema values private | team |
-- shared) before the comp can leave needs-review. This prevents accidental
-- sharing of deals-in-progress and forces deliberate visibility choices.
--
-- FLAG SHAPE
--
--   - New imports: needs_visibility_review = true. Default visibility
--     stays 'team' as a safe fallback — but the broker must explicitly
--     click one of the three options before the flag clears.
--   - When the broker picks: visibility updates AND needs_visibility_review
--     is set to false in the same transaction. Comp exits needs-review on
--     that criterion (still subject to needs_extraction_review and
--     needs_location_review for the math/location gates).
--
-- BACKFILL — EXISTING COMPS
--
-- Existing comps were already verified under the team-default behavior.
-- Forcing the broker to revisit every comp just to confirm "yes, team"
-- would be retroactive friction with no benefit (the comp is already in
-- the team's hands either way). Grandfather them: every existing row
-- gets needs_visibility_review = false. They keep whatever visibility
-- they already have.
--
-- ROLLBACK
--
-- Pure additive. To roll back:
--   ALTER TABLE comps DROP COLUMN needs_visibility_review;
-- No data depends on it; UI degrades to "no visibility gate" gracefully.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS needs_visibility_review BOOLEAN NOT NULL DEFAULT true;

-- Grandfather existing rows: they were verified under the old default;
-- don't surface a "needs visibility" flag for comps that pre-date the
-- forced-selection requirement.
UPDATE comps
SET needs_visibility_review = false
WHERE created_at < NOW();

COMMENT ON COLUMN comps.needs_visibility_review IS
  'True until the broker explicitly picks Private/Team/Public on the review page. Forces deliberate visibility choice on every new import. Cleared by the visibility-picker handlers in review/[compId]/page.tsx. Existing rows (pre-migration 043) were grandfathered to false via the migration backfill UPDATE — they keep whatever visibility was set at import time without re-review.';

-- Migration 020: Track whether a comp's auto-located pin has been
-- visually reviewed by a broker via the thumbnail verification screen.
--
-- Three logical states for a comp's location:
--   1. needs_location_review=false, latitude IS NOT NULL
--      → Either broker explicitly clicked "Looks right" on the
--        verification screen, OR broker manually placed via
--        LocationPicker. Pin is broker-verified.
--   2. needs_location_review=true, latitude IS NOT NULL
--      → autoLocate produced a pin but broker skipped the verification
--        screen (clicked Skip, navigated away, or batch-skipped). Pin
--        exists in the vault but hasn't been visually confirmed.
--   3. needs_location_review=true, latitude IS NULL
--      → autoLocate returned null (no parcel match) AND broker skipped.
--        Vault shows the comp with no pin; broker needs to manually
--        place via LocationPicker.
--
-- The vault renders a gray clock badge on rows where this is true so
-- the broker knows to revisit. The badge clears when broker manually
-- edits the location (saveComp/saveCompSilent passes false).
--
-- Default false on existing rows: legacy comps were either manually
-- placed (effectively verified) or have null lat/lng already (which
-- the existing UI already flags separately).

ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS needs_location_review BOOLEAN DEFAULT FALSE;

-- Partial index over flagged rows only — keeps the index small and
-- supports the vault filter "show me comps that need review."
CREATE INDEX IF NOT EXISTS idx_comps_needs_location_review
  ON comps(needs_location_review) WHERE needs_location_review = TRUE;

NOTIFY pgrst, 'reload schema';

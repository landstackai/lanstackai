-- Migration 019: Flag comps whose extracted values don't add up.
--
-- The math identity gate at extraction time checks whether
--   acres × price_per_acre ≈ sale_price  (within 1%)
-- When the identity fails, at least one of the three extracted values
-- is wrong but the gate can't tell which. Instead of silently
-- auto-correcting (the previous design — risks overwriting correct
-- fields with bad math-derived values), we flag the row for required
-- broker review.
--
-- The vault UI renders a warning badge on flagged rows. Until the
-- thumbnail verification UI ships (build #4), the badge IS the review
-- surface — broker sees it, opens the comp, fixes whichever field is
-- wrong, and clears the flag manually via the existing vault edit.
--
-- Values:
--   true   — math identity failed at extraction; broker must verify
--            extracted acres / price / ppa before this comp is trusted
--   false  — math identity passed (or couldn't run; see notes below)
--   NULL   — legacy row from before the gate shipped
--
-- The gate only runs when sale_price AND price_per_acre AND acres
-- are ALL extracted. If any one is null (some appraisals don't state
-- ppa explicitly), the gate is skipped and the flag stays false —
-- absence of the gate is not a failure signal.

ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS needs_extraction_review BOOLEAN DEFAULT FALSE;

-- Index supports the vault list query "show me all comps that need
-- review" — small partial index, only rows where the flag is true.
CREATE INDEX IF NOT EXISTS idx_comps_needs_extraction_review
  ON comps(needs_extraction_review) WHERE needs_extraction_review = TRUE;

NOTIFY pgrst, 'reload schema';

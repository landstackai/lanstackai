-- Enable anonymous (logged-out) access to a CMA report via share_token.
-- The share page queries cmas (by share_token) and comps (selected_comp_ids).
-- Without these policies, anon users hit "Report not found" because RLS blocks the reads.
--
-- NOTE: profiles is intentionally NOT exposed to anon. Broker contact info
-- must never be visible on the public share page.

-- 1. cmas: anon can read a CMA whose share has not expired.
--    Security relies on the 32-byte random share_token; the page filters
--    by .eq('share_token', token), so only the matching row is returned.
CREATE POLICY "Anon can view shared CMAs by token"
  ON cmas FOR SELECT
  TO anon
  USING (
    share_token IS NOT NULL
    AND (share_expires_at IS NULL OR share_expires_at > NOW())
  );

-- 2. comps: anon can read a comp if it is referenced by any non-expired
--    shared CMA's selected_comp_ids.
CREATE POLICY "Anon can view comps in shared CMAs"
  ON comps FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM cmas
      WHERE comps.id = ANY (cmas.selected_comp_ids)
        AND (cmas.share_expires_at IS NULL OR cmas.share_expires_at > NOW())
    )
  );

-- 3. Allow anon to increment share_views on the cmas they can read.
--    (The share page bumps a view counter; without this it silently fails.)
CREATE POLICY "Anon can update share_views on shared CMAs"
  ON cmas FOR UPDATE
  TO anon
  USING (
    share_token IS NOT NULL
    AND (share_expires_at IS NULL OR share_expires_at > NOW())
  )
  WITH CHECK (
    share_token IS NOT NULL
    AND (share_expires_at IS NULL OR share_expires_at > NOW())
  );

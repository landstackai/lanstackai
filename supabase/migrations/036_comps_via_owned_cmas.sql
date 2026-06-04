-- Migration 036: Allow brokers to read any comp that appears in a CMA they own.
--
-- Background: comps RLS (from migration 001) has three read policies:
--   1. "Users can view their own comps"  — created_by = auth.uid()
--   2. "Users can view team comps"       — visibility ∈ ('team','shared')
--                                          AND same team_id
--   3. "Users can view shared comps"     — visibility = 'shared'
--
-- These don't cover the case where a broker added someone else's PRIVATE
-- comp to their CMA. Example: Broker Alice imports an appraisal that
-- creates a comp owned by appraiser Bob (created_by = bob). Bob's comp
-- has visibility='private'. Alice adds it to her CMA. Now Alice CAN see
-- the comp on her workspace map (it has lat/lng, the workspace renders
-- pins from the CMA's selected_comp_ids). But the PDF route's
-- .in('id', selectedIds) Supabase query goes through RLS — none of the
-- three policies above grant Alice access to Bob's private comp, so the
-- query silently drops it. Result: PDF map shows 4 of 6 pins even
-- though all 6 are valid.
--
-- This adds a 4th read policy: if the comp's id appears in any CMA the
-- broker owns, they can read it. Same shape as migration 008's anon
-- policy but for authenticated users.
--
-- Why this is safe: the broker already has full write access to their
-- own CMAs, including the selected_comp_ids array. If they added a
-- comp to their CMA, by definition they have a legitimate reason to
-- see its underlying data. We're not granting broader read access —
-- only access to comps the broker explicitly chose.

CREATE POLICY "Users can view comps in their own CMAs" ON comps
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM cmas
      WHERE cmas.created_by = auth.uid()
        AND comps.id = ANY(cmas.selected_comp_ids)
    )
  );

-- Schema cache reload so PostgREST sees the new policy immediately
-- (same pattern as 028/029/030/034/035).
NOTIFY pgrst, 'reload schema';

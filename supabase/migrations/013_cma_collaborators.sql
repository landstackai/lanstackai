-- Migration 013: CMA collaborators.
--
-- Lets a broker explicitly invite specific team members to a CMA. Selected
-- collaborators can view and update the CMA in their own dashboard. The
-- whole-team-can-see-everything approach was too broad — a 4-person team
-- working on different CMAs needs scoped collaboration, not blanket access.

CREATE TABLE IF NOT EXISTS cma_collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cma_id UUID NOT NULL REFERENCES cmas(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor', 'viewer')),
  added_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cma_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cma_collaborators_cma_id ON cma_collaborators(cma_id);
CREATE INDEX IF NOT EXISTS idx_cma_collaborators_user_id ON cma_collaborators(user_id);

ALTER TABLE cma_collaborators ENABLE ROW LEVEL SECURITY;

-- The CMA owner manages the collaborator list.
DROP POLICY IF EXISTS "Owner can manage CMA collaborators" ON cma_collaborators;
CREATE POLICY "Owner can manage CMA collaborators"
  ON cma_collaborators FOR ALL
  TO authenticated
  USING (
    cma_id IN (SELECT id FROM cmas WHERE created_by = auth.uid())
  )
  WITH CHECK (
    cma_id IN (SELECT id FROM cmas WHERE created_by = auth.uid())
  );

-- A user can see their own collaboration rows (so the CMA library knows which
-- CMAs to include for them).
DROP POLICY IF EXISTS "User can view their own collaborations" ON cma_collaborators;
CREATE POLICY "User can view their own collaborations"
  ON cma_collaborators FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Extend CMA visibility: collaborators can SELECT + UPDATE the CMAs they're
-- assigned to. Existing "Users can view own CMAs" policy stays (this is additive).
DROP POLICY IF EXISTS "Collaborators can view assigned CMAs" ON cmas;
CREATE POLICY "Collaborators can view assigned CMAs"
  ON cmas FOR SELECT
  TO authenticated
  USING (
    id IN (SELECT cma_id FROM cma_collaborators WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Editor collaborators can update assigned CMAs" ON cmas;
CREATE POLICY "Editor collaborators can update assigned CMAs"
  ON cmas FOR UPDATE
  TO authenticated
  USING (
    id IN (
      SELECT cma_id FROM cma_collaborators
      WHERE user_id = auth.uid() AND role = 'editor'
    )
  );

NOTIFY pgrst, 'reload schema';

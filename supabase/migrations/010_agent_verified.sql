-- Migration 010: Agent-Verified improvement source.
--
-- Adds a third improvement_source tier between 'appraiser' and
-- 'broker_estimate' — for cases where an agent involved in the transaction
-- (listing or buyer's side) personally verified the improvement value.
--
-- The public client share report shows this as an anonymous "Agent-Verified"
-- green pill. The agent's identity is captured internally via the new
-- improvement_verified_by/_at columns so the firm has an audit trail, but
-- it is NEVER surfaced on the client-facing share report.
--
-- improvement_source is a TEXT column — the new 'agent_verified' value
-- slots in without any schema change to that column. Only the two
-- audit columns are added here.

ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS improvement_verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS improvement_verified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_comps_improvement_verified_by
  ON comps(improvement_verified_by)
  WHERE improvement_verified_by IS NOT NULL;

NOTIFY pgrst, 'reload schema';

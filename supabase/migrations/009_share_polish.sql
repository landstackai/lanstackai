-- Migration 009: Share-report polish.
-- Adds the schema and RLS bits needed for:
--   * Brokerage branding on the public share page (#6)
--   * Per-comp broker notes (#5) — stored in cmas.comp_adjustments JSON,
--     no migration needed for that. Listed here only as documentation.
--
-- IMPORTANT: this migration depends on 008_public_share_rls.sql.
-- Run 008 first.

-- ============================================================
-- 1. BROKERAGE BRANDING — anon read of profiles, name fields only.
-- ============================================================
-- The public share page shows the broker's name + brokerage at the top
-- so the report looks branded (not just generic landstack.ai). We do NOT
-- expose phone or email to anon — those stay locked behind authenticated
-- access only.
--
-- Approach: column-level GRANT. Anon gets SELECT on (id, full_name,
-- brokerage_name) only — never on phone/email. Plus an RLS policy that
-- only matches profiles whose owner created a non-expired shared CMA.

-- Lock everything down first, then re-grant just the safe columns.
REVOKE ALL ON profiles FROM anon;
GRANT SELECT (id, full_name, brokerage_name) ON profiles TO anon;

-- Anon may read a profile row if its owner is the creator of a non-expired
-- shared CMA. The column-level GRANT above ensures only safe fields come back.
DROP POLICY IF EXISTS "Anon can view broker name on shared CMAs" ON profiles;
CREATE POLICY "Anon can view broker name on shared CMAs"
  ON profiles FOR SELECT
  TO anon
  USING (
    id IN (
      SELECT created_by FROM cmas
      WHERE share_token IS NOT NULL
        AND (share_expires_at IS NULL OR share_expires_at > NOW())
    )
  );

-- ============================================================
-- 2. SHARE FEEDBACK — clients can submit a question via the share report.
-- ============================================================
-- The "Reply to broker" CTA on the share page POSTs to /api/share/[token]/feedback,
-- which inserts into this table. The broker reads them in their dashboard.
-- Email integration is intentionally NOT wired up here — that requires a
-- service like Resend/SendGrid. Persistence first, notification later.

CREATE TABLE IF NOT EXISTS share_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cma_id UUID NOT NULL REFERENCES cmas(id) ON DELETE CASCADE,
  share_token TEXT NOT NULL,
  -- Client-provided contact info (optional — client may stay anonymous).
  client_name TEXT,
  client_email TEXT,
  message TEXT NOT NULL,
  -- Whether the broker has read this message.
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_feedback_cma_id ON share_feedback(cma_id);
CREATE INDEX IF NOT EXISTS idx_share_feedback_created_at ON share_feedback(created_at DESC);

ALTER TABLE share_feedback ENABLE ROW LEVEL SECURITY;

-- Anon may INSERT feedback against a non-expired shared CMA. They cannot
-- read or modify any rows — write-only.
DROP POLICY IF EXISTS "Anon can submit feedback on shared CMAs" ON share_feedback;
CREATE POLICY "Anon can submit feedback on shared CMAs"
  ON share_feedback FOR INSERT
  TO anon
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM cmas
      WHERE cmas.id = share_feedback.cma_id
        AND cmas.share_token = share_feedback.share_token
        AND cmas.share_token IS NOT NULL
        AND (cmas.share_expires_at IS NULL OR cmas.share_expires_at > NOW())
    )
  );

-- Brokers can read/update feedback on their own CMAs.
DROP POLICY IF EXISTS "Brokers can view feedback on their CMAs" ON share_feedback;
CREATE POLICY "Brokers can view feedback on their CMAs"
  ON share_feedback FOR SELECT
  TO authenticated
  USING (
    cma_id IN (SELECT id FROM cmas WHERE created_by = auth.uid())
  );

DROP POLICY IF EXISTS "Brokers can mark feedback read" ON share_feedback;
CREATE POLICY "Brokers can mark feedback read"
  ON share_feedback FOR UPDATE
  TO authenticated
  USING (
    cma_id IN (SELECT id FROM cmas WHERE created_by = auth.uid())
  );

-- Tell PostgREST to reload its schema cache so the new table + columns
-- become visible to the API.
NOTIFY pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────
-- extraction_runs — telemetry table for the engine-routing decision.
--
-- This table was created directly in Supabase via the dashboard SQL editor
-- on 2026-06-17 as part of building the "triage-and-route" extraction
-- architecture. This migration codifies it so DB-from-scratch rebuilds
-- include it.
--
-- One row per PDF extraction attempt. Over time, this table tells us:
--   • Which engine wins on which document shape
--   • Where extraction silently fails (succeeded=true but comps_extracted=0)
--   • Real cost per broker per month
--   • Where to invest next (which doc types fail most often)
--
-- The "_user_kept / _user_edited" columns are filled by the review UI
-- LATER — after the broker has actually reviewed the comps. That post-hoc
-- signal is the ground truth: an extraction that found 6 comps but the
-- broker only kept 2 was not actually a win.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS extraction_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- who & where
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,

  -- the input PDF
  file_name TEXT,
  file_size_bytes INT,
  page_count INT,
  doc_type TEXT,
  has_live_text BOOLEAN,
  sha256 TEXT,

  -- the engine + model used
  engine TEXT NOT NULL,
  model TEXT,
  routing_reason TEXT,

  -- the output
  comps_extracted INT,
  subject_property_found BOOLEAN,
  fields_filled_pct NUMERIC(5,2),

  -- the cost
  latency_ms INT,
  input_tokens INT,
  output_tokens INT,
  cost_usd NUMERIC(10,6),

  -- the outcome
  succeeded BOOLEAN NOT NULL,
  error_message TEXT,
  error_stage TEXT,

  -- post-hoc human ground truth (filled by review UI, NULL until reviewed)
  comps_user_kept INT,
  comps_user_edited INT,
  user_quality_rating INT
);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_team_created
  ON extraction_runs(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_engine_doctype
  ON extraction_runs(engine, doc_type);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_succeeded
  ON extraction_runs(succeeded, created_at DESC) WHERE succeeded = false;

-- ─── RLS ────────────────────────────────────────────────────────────────
-- Telemetry is sensitive: file names + counts reveal what brokers are
-- working on. Lock it down hard.
ALTER TABLE extraction_runs ENABLE ROW LEVEL SECURITY;

-- Policy 1: Users SELECT only rows from their own team.
DROP POLICY IF EXISTS "users read own team extractions" ON extraction_runs;
CREATE POLICY "users read own team extractions"
  ON extraction_runs FOR SELECT
  USING (
    team_id IN (
      SELECT team_id FROM profiles WHERE id = auth.uid()
    )
  );

-- Policy 2: Users UPDATE own team rows (for review-time ground-truth columns).
DROP POLICY IF EXISTS "users update own team review feedback" ON extraction_runs;
CREATE POLICY "users update own team review feedback"
  ON extraction_runs FOR UPDATE
  USING (
    team_id IN (
      SELECT team_id FROM profiles WHERE id = auth.uid()
    )
  );

-- INSERT/DELETE policies deliberately omitted: only service role writes.

COMMENT ON TABLE extraction_runs IS
  'Telemetry: one row per PDF extraction attempt. Powers engine-routing decisions and post-hoc quality analysis. Inserts only via service role.';

-- Migration 016: Import exemplar tracking — the learning-loop foundation.
--
-- Every time a comp is imported, we save an exemplar capturing:
--   * What the AI extracted (description, county, acres, grantor/grantee)
--   * What auto-locate did or didn't do (confidence, reason, search_hint)
--   * What the broker ultimately accepted (final coords, was_manually_fixed)
--
-- This is the basis for:
--   * Identifying appraiser formats that consistently fail extraction/locate
--   * Few-shot retrieval (RAG): similar past descriptions become exemplars
--     in future extraction prompts
--   * Format-specific adapters: when a single firm's docs flow through,
--     we can build a tuned prompt for that firm
--
-- 1-to-1 with comps. Cascade on delete.

CREATE TABLE IF NOT EXISTS import_exemplars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comp_id UUID NOT NULL REFERENCES comps(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- The text/data the AI extracted from the PDF. Used for similarity matching
  -- in future extraction prompts (RAG).
  description TEXT,
  address TEXT,
  county TEXT,
  state TEXT,
  acres NUMERIC,
  grantor TEXT,
  grantee TEXT,

  -- What the AI auto-locate pipeline did.
  ai_search_hint TEXT,                 -- the search_hint the AI generated
  ai_auto_located BOOLEAN DEFAULT FALSE, -- did auto-locate produce coords?
  ai_match_confidence TEXT CHECK (ai_match_confidence IN ('high', 'medium', 'low') OR ai_match_confidence IS NULL),
  ai_match_reason TEXT,                -- AI's reasoning string

  -- The broker's final answer.
  final_lat NUMERIC,
  final_lng NUMERIC,
  was_manually_fixed BOOLEAN DEFAULT FALSE,  -- did broker use LocationPicker?
  fixed_at TIMESTAMPTZ,

  -- Future: PDF page 1 image URL for visual matching.
  pdf_image_url TEXT,

  UNIQUE(comp_id)
);

CREATE INDEX IF NOT EXISTS idx_import_exemplars_created_by ON import_exemplars(created_by);
CREATE INDEX IF NOT EXISTS idx_import_exemplars_county ON import_exemplars(county) WHERE county IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_import_exemplars_manually_fixed ON import_exemplars(was_manually_fixed);

ALTER TABLE import_exemplars ENABLE ROW LEVEL SECURITY;

-- Brokers see/manage their own exemplars only. (Team-level sharing for
-- collaborative learning is a future feature.)
DROP POLICY IF EXISTS "Users manage their own import exemplars" ON import_exemplars;
CREATE POLICY "Users manage their own import exemplars"
  ON import_exemplars FOR ALL
  TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

NOTIFY pgrst, 'reload schema';

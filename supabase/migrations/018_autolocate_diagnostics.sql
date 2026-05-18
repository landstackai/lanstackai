-- Migration 018: AutoLocate diagnostic logging.
--
-- One row per autoLocate run, captured to make failure modes and
-- pipeline behavior queryable. Without this we debug case-by-case;
-- with it we can ask "what % of HIGH-confidence pins does the broker
-- reject?" or "which counties have the highest manual-fallback rate?"
--
-- Captures: input snapshot, pipeline path, outcome, and (later, when
-- thumbnail verification ships) the broker's accept/reject decision.
--
-- Failure mode: if this table doesn't exist or the POST fails, the
-- diagnostic write fails silently — autoLocate itself is unaffected.
-- This is pure observability; never block user-facing flow on it.

CREATE TABLE IF NOT EXISTS autolocate_diagnostics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Linkage to the comp (filled when the comp is saved; NULL otherwise
  -- because the comp doesn't exist yet at autoLocate time and may
  -- never be saved if the broker rejects the pin).
  comp_id UUID REFERENCES comps(id) ON DELETE SET NULL,

  -- Who ran it. NULL if anonymous (shouldn't happen but defensive).
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── Input snapshot (what came INTO autoLocate) ───────────────────
  input_acres NUMERIC,
  input_sale_price NUMERIC,
  input_ppa NUMERIC,
  input_grantee TEXT,
  input_grantor TEXT,
  input_property_name TEXT,
  input_county TEXT,
  input_lat NUMERIC,
  input_lng NUMERIC,
  input_has_aerial BOOLEAN DEFAULT FALSE,
  input_has_description BOOLEAN DEFAULT FALSE,

  -- ── Pipeline path ────────────────────────────────────────────────
  -- exit_stage values (extensible):
  --   'owner_search_cluster'   — owner search succeeded, picked a cluster
  --   'owner_search_null'      — owner search ran but produced no viable cluster
  --   'manual_placeholder'     — autoLocate skipped (no signals)
  --   'error'                  — exception thrown
  --   'latlng_seed_cluster'    — (future) lat/lng-first seed produced cluster
  --   'math_gate_rejected'     — (future) extraction rejected pre-autoLocate
  exit_stage TEXT,

  -- Compact per-stage trace: [{ stage, ms, result }, ...]
  stages_attempted JSONB,

  -- ── Stage-specific data (queryable for pattern analysis) ─────────
  -- Per owner signal: { signal, tokens, raw_count, tight_count }
  owner_search_data JSONB,
  -- { cluster_count, picked_idx, picked_acres, picked_delta, alternatives: [...] }
  cluster_data JSONB,

  -- ── Outcome ──────────────────────────────────────────────────────
  final_pin_lat NUMERIC,
  final_pin_lng NUMERIC,
  final_parcel_ids TEXT[],
  final_cluster_acres NUMERIC,
  final_confidence TEXT,        -- 'high' | 'medium' | 'low' | NULL
  final_match_reason TEXT,

  -- ── Broker decision (filled later by thumbnail verification) ─────
  broker_decision TEXT,         -- 'approved' | 'rejected' | 'edited' | NULL
  broker_decision_at TIMESTAMPTZ,
  broker_replacement_pin JSONB, -- { lat, lng, parcel_ids } when broker manually placed

  -- ── Misc ─────────────────────────────────────────────────────────
  ms_total NUMERIC,             -- end-to-end autoLocate runtime in ms
  deployment_sha TEXT           -- which build produced this row (for regression detection)
);

-- Indexes for the queries we expect to run most often:
--   "recent runs"           → created_at DESC
--   "find runs for a comp"  → comp_id
--   "where is volume?"      → exit_stage
--   "high-confidence runs"  → final_confidence
CREATE INDEX IF NOT EXISTS idx_autolocate_diagnostics_created_at
  ON autolocate_diagnostics(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_autolocate_diagnostics_comp_id
  ON autolocate_diagnostics(comp_id) WHERE comp_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_autolocate_diagnostics_exit_stage
  ON autolocate_diagnostics(exit_stage);

CREATE INDEX IF NOT EXISTS idx_autolocate_diagnostics_confidence
  ON autolocate_diagnostics(final_confidence) WHERE final_confidence IS NOT NULL;

-- RLS: this is a diagnostic table queried only via service-role from
-- admin endpoints. Lock it down — no policies = no client access.
ALTER TABLE autolocate_diagnostics ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

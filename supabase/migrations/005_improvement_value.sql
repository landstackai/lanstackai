-- Adjusted Land Value feature.
--
-- 1) Comp-level optional improvement value + source. Existing comps unaffected.
-- 2) CMA broker-estimate disclosure acknowledgment timestamp (logged once per CMA
--    when the broker confirms estimates before sharing with a client).
ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS improvement_value NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS improvement_source TEXT
    CHECK (improvement_source IS NULL OR improvement_source IN ('appraiser', 'broker_estimate'));

ALTER TABLE cmas
  ADD COLUMN IF NOT EXISTS broker_disclosure_acknowledged_at TIMESTAMPTZ;

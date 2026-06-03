-- Migration 035: Broker-set Range for Opinion of Value
--
-- Background: when the broker chooses "Range" presentation mode
-- (opinion_presentation = 'range'), the client report currently
-- derives the range from the comp set automatically. Brokers asked
-- for explicit control — they want to enter a specific low/high
-- band that may differ from the raw comp range, and they want both
-- the per-acre and the total values to auto-sync.
--
-- New columns on cmas:
--   opinion_range_low_total  NUMERIC(14,2) NULL — broker's stated
--     LOW end of the range (total dollars). Per-acre is derived on
--     display by dividing by subject_acres.
--   opinion_range_high_total NUMERIC(14,2) NULL — broker's stated
--     HIGH end of the range (total dollars). Same derivation.
--
-- Both nullable. When NULL, the existing comp-derived range falls
-- through. When both populated, they take precedence in Range mode
-- on the client share report + PDF.
--
-- We store TOTAL only (not also per-acre) to keep a single source
-- of truth — if the subject acreage ever changes, the per-acre is
-- re-derived on display. The input UI presents both fields with
-- bidirectional auto-sync so the broker can enter whichever feels
-- natural for the conversation.
--
-- Schema cache reload at the bottom so PostgREST picks up the new
-- columns without manual NOTIFY (per the pattern in 028-034).

ALTER TABLE cmas
  ADD COLUMN IF NOT EXISTS opinion_range_low_total  NUMERIC(14,2) NULL,
  ADD COLUMN IF NOT EXISTS opinion_range_high_total NUMERIC(14,2) NULL;

NOTIFY pgrst, 'reload schema';

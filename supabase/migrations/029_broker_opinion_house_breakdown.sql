-- Migration 029: House SQFT × $/SQFT itemization under Improvement Value
--
-- Migration 028 added the Lump Sum vs Breakdown modes for broker opinion
-- of value. This adds an optional itemization INSIDE the Improvement
-- Value bucket (when in Breakdown mode):
--
--   House: SQFT × $/SQFT  (the universal real-estate metric every
--                          client recognizes)
--   Additional Vertical Improvements: lump  (barns, shops, sheds,
--                                            equipment buildings,
--                                            guest houses, etc.)
--
-- Horizontal improvements (fencing, ponds, wells, septic, irrigation,
-- gates, roads) are NOT itemized — convention is to roll those into
-- the Land $/Acre judgment, since a fenced, watered property commands
-- a higher per-acre price.
--
-- Three nullable columns:
--   broker_opinion_house_sqft       — square footage of the primary dwelling
--   broker_opinion_house_ppsf       — $/sqft for the primary dwelling
--   broker_opinion_additional_vertical — lump $ for other vertical structures
--
-- Computation rule (UI-side):
--   When ANY of these are set, the existing broker_opinion_improvement_value
--   is treated as a computed sum:
--     improvement = (house_sqft × house_ppsf) + additional_vertical
--   When all three are NULL, broker_opinion_improvement_value is whatever
--   lump the broker typed directly.
--
-- "Option (a) when only house is filled in" (per broker decision):
--   improvement_value = house_sqft × house_ppsf,
--   additional_vertical defaults to $0.
--
-- No backfill needed — existing CMAs simply have NULL for all three
-- new columns and continue rendering as lump improvement values.

ALTER TABLE cmas
  ADD COLUMN IF NOT EXISTS broker_opinion_house_sqft NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS broker_opinion_house_ppsf NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS broker_opinion_additional_vertical NUMERIC NULL;

NOTIFY pgrst, 'reload schema';

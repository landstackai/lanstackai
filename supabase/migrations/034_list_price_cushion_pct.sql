-- Migration 034: Per-broker default List Price cushion %
--
-- Background: until now the CMA workspace defaulted the Suggested
-- List Price to broker_opinion_value × 1.10 (a hardcoded 10%
-- negotiation cushion). Brokers price differently — some run 5%,
-- some 15-20%, some flat to BOV. The hardcoded value works for
-- nobody but the default-by-coincidence broker.
--
-- New column on profiles:
--   default_list_price_cushion_pct NUMERIC(5,2) NULL
--     Broker's preferred cushion percentage. NULL → 10% default
--     (existing behavior preserved). Read on every CMA the broker
--     creates and used as the default multiplier for the auto-
--     suggested list price; the broker can still override the
--     dollar amount per-CMA via cmas.suggested_list_price.
--
-- Why a percentage instead of a multiplier (e.g. 1.10): brokers
-- think in "10% above BOV," not "1.10x BOV." Storing the integer
-- percentage keeps the UI math intuitive and the column name
-- self-documenting.
--
-- Schema cache reload so PostgREST picks up the new column
-- immediately (matches pattern in 028/029/030).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS default_list_price_cushion_pct NUMERIC(5,2) NULL;

NOTIFY pgrst, 'reload schema';

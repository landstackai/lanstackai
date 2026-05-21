-- Migration 030: Suggested List Price for CMAs
--
-- Background: client meetings often get derailed by sticker shock when the
-- broker's opinion of value lands below the seller's expectation. Showing
-- ONLY the broker's expected-sale number ("$6.75M") feels like a verdict;
-- showing the suggested LIST price as the headline ("$7.5M") plus the
-- expected sale as supporting context lets the seller anchor on the
-- aspirational number while the broker stays honest about likely outcome.
--
-- New column:
--   suggested_list_price NUMERIC(14,2) NULL — broker-set override for
--     the list price. NULL means "fall back to broker_opinion_value × 1.10"
--     on display (the standard 10% negotiation cushion for TX ranch land).
--
-- Why a single column instead of a cushion-percentage field: brokers
-- want to enter a whole-number list price ("list at $7.5M") not a
-- percentage. The 10% default just seeds the input; the broker sees a
-- round number to confirm/edit. Storing the absolute value keeps the
-- read-path math trivial and means the displayed list price never drifts
-- if broker_opinion_value gets recomputed later.
--
-- Schema cache reload at the bottom so PostgREST picks up the new column
-- without manual NOTIFY (per the pattern in 028/029).

ALTER TABLE cmas
  ADD COLUMN IF NOT EXISTS suggested_list_price NUMERIC(14,2) NULL;

NOTIFY pgrst, 'reload schema';

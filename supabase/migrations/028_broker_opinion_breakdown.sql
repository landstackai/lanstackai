-- Migration 028: Broker Opinion of Value — Lump Sum vs Land + Improvement breakdown
--
-- Background: brokers value land two distinct ways:
--   1. "I'll just say it's worth $5M" — a single number, no breakdown
--   2. "Land's worth $20k/ac × 100 ac = $2M, plus a $1M house = $3M total"
--      — itemized for clients who want to see the work
--
-- Migration 007 added `broker_opinion_value` (the lump-sum total). This
-- migration adds the columns needed for the breakdown path:
--
--   broker_opinion_mode             TEXT  — 'lump_sum' | 'breakdown' | NULL
--                                          (NULL = broker hasn't entered an opinion yet)
--   broker_opinion_land_value       NUMERIC — land-only total in breakdown mode
--                                            ($/acre × acres). Editable in UI.
--   broker_opinion_improvement_value NUMERIC — improvement lump sum in breakdown mode
--
-- Rendering rules:
--   In lump_sum mode  → broker_opinion_value carries the total; the other two are NULL.
--   In breakdown mode → broker_opinion_land_value + broker_opinion_improvement_value
--                       are the inputs; total = sum of the two.
--                       broker_opinion_value MAY also be set to the computed total
--                       for backwards-compatible read paths, but it's not authoritative.
--
-- Why NUMERIC (no precision/scale specified): matches existing
-- broker_opinion_value declaration in 007 (NUMERIC(14,2)). We use plain
-- NUMERIC here for flexibility; values are always whole dollars in UI.
--
-- Why TEXT not ENUM for mode: brokers will likely want a 3rd mode later
-- ("per-acre with sub-improvements"?), and TEXT with a CHECK constraint
-- is easier to extend than dropping/recreating an ENUM.
--
-- Schema cache reload at the bottom — fixes the "Could not find the
-- 'broker_opinion_value' column" error that's surfacing in toasts when
-- PostgREST's cache goes stale.

ALTER TABLE cmas
  ADD COLUMN IF NOT EXISTS broker_opinion_mode TEXT NULL,
  ADD COLUMN IF NOT EXISTS broker_opinion_land_value NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS broker_opinion_improvement_value NUMERIC NULL;

-- Constrain the mode column to recognized values. NULL permitted (= no
-- opinion entered yet).
ALTER TABLE cmas
  DROP CONSTRAINT IF EXISTS cmas_broker_opinion_mode_check;

ALTER TABLE cmas
  ADD CONSTRAINT cmas_broker_opinion_mode_check
  CHECK (broker_opinion_mode IS NULL
      OR broker_opinion_mode IN ('lump_sum', 'breakdown'));

-- Reload PostgREST schema cache so the new columns + the existing
-- broker_opinion_value column are recognized by the API layer.
NOTIFY pgrst, 'reload schema';

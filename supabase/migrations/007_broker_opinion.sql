-- Optional broker-stated opinion of value. When set, this overrides the
-- computed average on the client-facing share report. Leaving it null keeps
-- the report driven by the comp averages.
ALTER TABLE cmas ADD COLUMN IF NOT EXISTS broker_opinion_value NUMERIC(14,2);

-- Migration 022: Track where each comp came from.
--
-- Comps can originate from several sources, each with different data
-- shape and reliability:
--   'pdf_appraisal'   — Stouffer-format etc. PDF upload. Best signal,
--                        full grantor/grantee, sale_date, recording info,
--                        usually an embedded aerial.
--   'listing_url'     — Pasted URL of a real-estate listing (Land.com,
--                        LandsOfTexas, broker's own site). Partial data:
--                        no grantor/grantee, no recording info, asking
--                        price not sold price.
--   'manual'          — Broker typed it in directly.
--   'paste'           — Pasted appraisal text.
--   NULL              — Legacy rows from before this column existed.
--
-- source_url records the original listing URL when applicable, so the
-- broker can click through to the source later (verify, refresh data,
-- see photos that weren't extracted, etc.).

ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT;

-- No indexes — these columns are read per-row by primary key, not
-- queried by filter. Adding indexes would waste space and slow inserts
-- for zero query benefit.

NOTIFY pgrst, 'reload schema';

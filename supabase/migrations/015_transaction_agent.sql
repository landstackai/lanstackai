-- Migration 015: Transaction Agent attribution on comps.
--
-- When the firm handled a deal (is_company_transaction = true), we record
-- WHICH agent on the firm was on the transaction. This is T1 confidential
-- data — only the broker who entered the comp + their firm sees it. It is
-- NEVER exposed to aggregate stats or any public view.
--
-- The map's "My Sales" filter reads this field: a broker sees only the
-- deals they personally closed, not every comp they typed in as research.

ALTER TABLE comps
  ADD COLUMN IF NOT EXISTS transaction_agent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_comps_transaction_agent_id
  ON comps(transaction_agent_id) WHERE transaction_agent_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

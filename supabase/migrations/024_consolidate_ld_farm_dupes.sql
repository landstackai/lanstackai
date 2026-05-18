-- Migration 024: One-time cleanup of L & D Farm and Ranch duplicate rows.
--
-- Context: during testing of the extraction math gate, the L & D Farm
-- and Ranch appraisal PDF was imported 4 times, each producing a comp
-- row for the same transaction. The map shows up to two pins at
-- different price-per-acre values because the bad-acreage extraction
-- (820 ac vs the correct 1,179.12 ac) produces a different $/ac.
--
-- Going forward, the dedup banner shipped in commit b83c148 will catch
-- this at import time. This migration cleans up the existing mess.
--
-- The 4 rows:
--   e75c937a — KEEP (1179.12 ac, has coords + parcel IDs, most recent
--                    and best-enriched version)
--   a9749635 — DELETE (820 ac, wrong acreage from a bad extraction,
--                      no coords, no parcels)
--   8ee7108c — DELETE (1179.12 ac, no coords, no parcels — superseded)
--   7367f81e — DELETE (1179.12 ac, no coords, no parcels — superseded)
--
-- All 4 have identical sale_date (2023-04-28), sale_price ($5,600,796),
-- and grantee — confirming they're the same transaction.
--
-- IRREVERSIBLE — the DELETEs cannot be undone via migration. If you
-- need to roll back, restore from a Supabase backup.

DELETE FROM comps
WHERE id IN (
  'a9749635-0d39-4746-9034-5379a46b030a',
  '8ee7108c-4b4a-4336-ad09-ce057f617c41',
  '7367f81e-cbdd-4754-80a3-9b5e68f5e531'
);

-- No NOTIFY needed — DELETE on existing rows doesn't change schema.

-- Migration 025: Remove duplicate Lopez Farm row with bogus coords.
--
-- Two Lopez Farm rows exist in the DB from pre-dedup-banner imports:
--   c0b4ceb8...  no coords, otherwise correct (KEEP)
--   c5aa0b49...  coords at lat 33.16, lng -96.63 — Plano area, NOT Atascosa,
--                from a bad auto-locate. (DELETE)
--
-- Same sale_date, sale_price, grantor, grantee, acres — clearly the same
-- transaction. The dedup banner shipped in commit b83c148 prevents this
-- from recurring on future imports.
--
-- Keeping the no-coords version so the broker can manually place the pin
-- via the review page rather than living with the wrong coordinates.

DELETE FROM comps
WHERE id = 'c5aa0b49-eb84-4d45-949a-a7f66faaa26d';

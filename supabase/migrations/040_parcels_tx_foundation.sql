-- ─────────────────────────────────────────────────────────────────────────
-- Parcels foundation — self-host Texas StratMap parcel data.
--
-- Replaces the TxGIO live-API dependency that caused 5-min hangs on
-- 2026-06-18 + flaky responses on 2026-06-19. Same underlying data
-- (StratMap is Texas A&M / TxGIO's bulk export of the same parcels
-- TxGIO's ArcGIS service streams), but hosted in our Supabase Postgres
-- so query latency is <100ms and uptime is ours to control.
--
-- Source: TxGIO StratMap 2025 vintage (snapshot date 2025-05, published
-- 2025-09). Collection ID 0fa04328-872e-481c-b453-126a74777593.
-- License: CC0 1.0 (public domain).
--
-- 254 counties · ~14 million parcels · ~9GB compressed shapefile, ~50GB
-- in Postgres after import. Refresh annually (TxGIO publishes a new
-- snapshot each summer).
--
-- SCHEMA NOTES:
--   • Column names are kept UPPERCASE-then-snake to match the shapefile
--     DBF field names. Makes the ogr2ogr / shapefile-import pipeline
--     a direct lift, no field-mapping config.
--   • geom is GEOMETRY(MultiPolygon, 4326). The shapefiles arrive in
--     WGS84 (EPSG:4326) already; we store native, no reprojection.
--   • Three indexes carry the autoLocate query patterns:
--       GIST on geom              — point-in-polygon for "what parcel
--                                   is at this lat/lng?"
--       GIN trigram on owner_name — fuzzy owner-name search,
--                                   "MIKULENCAK" matches "MIKULENCAK,
--                                   DANNY J & IRENE"
--       BTREE on county           — fast filter for the county scope
--   • Bonus fields beyond what TxGIO's API exposes:
--       situs_addr / mail_addr — physical + owner mailing address
--       legal_desc             — surveyor's legal description
--       mkt_value / land_value / imp_value — current assessed values
--       tax_year / date_acq   — data currency markers
--     These start unused in autoLocate but unlock future features
--     (find-owner-mailing-address, enrich-with-tax-value).
-- ─────────────────────────────────────────────────────────────────────────

-- ── Extensions ──────────────────────────────────────────────────────────
-- postgis: spatial column types + GIST indexes + ST_Intersects etc.
-- pg_trgm: trigram fuzzy text search for owner_name (Postgres equivalent
--          of TxGIO's UPPER(LIKE) tokenization, but with proper indexing).
-- Both must be enabled in the Supabase dashboard before this migration
-- runs (Database → Extensions). The DO blocks below are safe to re-run
-- but will error loudly if the extensions aren't enabled.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RAISE EXCEPTION 'postgis extension is not enabled. Enable it in Supabase Dashboard → Database → Extensions before running this migration.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION 'pg_trgm extension is not enabled. Enable it in Supabase Dashboard → Database → Extensions before running this migration.';
  END IF;
END $$;

-- ── Table ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parcels_tx (
  -- Internal PK — auto-increments for INSERT performance. Prop_ID is the
  -- natural key for queries but isn't globally unique across counties
  -- (each CAD assigns its own internal IDs starting from 0), so we keep
  -- a synthetic PK and rely on the (county, prop_id) tuple for natural
  -- uniqueness when we need it.
  id              BIGSERIAL PRIMARY KEY,

  -- Source fields (1:1 with shapefile DBF, names lowercased)
  prop_id         TEXT,
  geo_id          TEXT,
  owner_name      TEXT,
  name_care       TEXT,                     -- "A TEXAS LIMITED LIABILITY COMPANY"
  legal_area      TEXT,                     -- broker-stated acreage string
  lgl_area_u      TEXT,                     -- units (Acres/SqFt)
  gis_area        DOUBLE PRECISION,         -- computed acreage from polygon
  gis_area_u      TEXT,
  legal_desc      TEXT,                     -- surveyor's legal description
  stat_land_      TEXT,                     -- state land-use code
  loc_land_u      TEXT,                     -- local land-use code
  land_value      DOUBLE PRECISION,
  imp_value       DOUBLE PRECISION,
  mkt_value       DOUBLE PRECISION,         -- market value (CAD-assessed)
  situs_addr      TEXT,                     -- physical address
  situs_num       TEXT,
  situs_stre      TEXT,
  situs_st_1      TEXT,
  situs_st_2      TEXT,
  situs_city      TEXT,
  situs_stat      TEXT,
  situs_zip       TEXT,
  mail_addr       TEXT,                     -- owner's mailing address
  mail_line1      TEXT,
  mail_line2      TEXT,
  mail_city       TEXT,
  mail_stat       TEXT,
  mail_zip        TEXT,
  source          TEXT,                     -- e.g. "FRIO APPRAISAL DISTRICT"
  date_acq        INTEGER,                  -- YYYYMMDD, when CAD acquired data
  fips            TEXT,                     -- 5-digit county FIPS (e.g. 48163)
  county          TEXT,                     -- county name UPPERCASE
  tax_year        INTEGER,
  year_built      TEXT,
  objectid_1      INTEGER,

  -- Provenance — which StratMap vintage this row came from. Lets us
  -- run two refreshes side-by-side then swap when validation passes.
  vintage         TEXT NOT NULL DEFAULT 'stratmap-2025-05',

  -- Polygon geometry, WGS84 (EPSG:4326). Always MultiPolygon (single
  -- polygons get auto-wrapped on import so the type stays uniform).
  geom            GEOMETRY(MultiPolygon, 4326),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ─────────────────────────────────────────────────────────────
-- GIST on geom: required for ANY spatial query. Point-in-polygon,
-- bounding-box filters, distance — all use this index.
CREATE INDEX IF NOT EXISTS parcels_tx_geom_gist ON parcels_tx USING GIST (geom);

-- Trigram on owner_name: fuzzy text search. Index speeds up queries
-- like `WHERE owner_name ILIKE '%MIKULENCAK%'`. Critical for
-- /api/parcels-by-owner being sub-second.
CREATE INDEX IF NOT EXISTS parcels_tx_owner_trgm ON parcels_tx
  USING GIN (owner_name gin_trgm_ops);

-- BTREE on county: every autoLocate query filters by county to keep
-- the candidate set small. Without this index, full-table scans on
-- 14M rows for every "WHERE county = 'Frio'" query.
CREATE INDEX IF NOT EXISTS parcels_tx_county_btree ON parcels_tx (county);

-- BTREE on prop_id: direct lookup by parcel ID (when autoLocate already
-- knows the prop_id from an earlier query and just wants the geometry).
CREATE INDEX IF NOT EXISTS parcels_tx_prop_id_btree ON parcels_tx (prop_id);

-- BTREE on fips: FIPS-based lookups (when frontend has the FIPS code,
-- e.g. from county selector dropdown).
CREATE INDEX IF NOT EXISTS parcels_tx_fips_btree ON parcels_tx (fips);

-- ── RLS ─────────────────────────────────────────────────────────────────
-- Parcels are public data (CC0 license) — every authenticated broker
-- can read every parcel. No write access from any role except the
-- service-role import script. Enable RLS and add a single permissive
-- read policy so we get the safety guardrail without restricting reads.
ALTER TABLE parcels_tx ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated brokers can read parcels" ON parcels_tx;
CREATE POLICY "Authenticated brokers can read parcels"
  ON parcels_tx FOR SELECT
  TO authenticated
  USING (true);

-- ── Comments ────────────────────────────────────────────────────────────
COMMENT ON TABLE parcels_tx IS
  'Texas StratMap 2025 parcel data (CC0 1.0). Source: TxGIO/Texas A&M TNRIS bulk export. Replaces live TxGIO ArcGIS API dependency.';
COMMENT ON COLUMN parcels_tx.owner_name IS
  'Owner name in CAD format ("LAST FIRST M & SPOUSE"). Trigram index lets ILIKE queries run sub-second.';
COMMENT ON COLUMN parcels_tx.gis_area IS
  'Acres computed from polygon geometry by source CAD. May differ from legal_area; treat as the authoritative number for spatial matching.';
COMMENT ON COLUMN parcels_tx.geom IS
  'Parcel polygon, WGS84 (EPSG:4326). Use ST_Intersects / ST_Within for spatial queries.';
COMMENT ON COLUMN parcels_tx.vintage IS
  'Snapshot vintage tag. When we refresh annually, the new vintage loads alongside the old and we cut over once validation passes, then drop the old.';

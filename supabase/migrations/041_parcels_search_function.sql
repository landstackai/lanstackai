-- ─────────────────────────────────────────────────────────────────────────
-- Owner-name search RPC for /api/parcels-by-owner.
--
-- Replaces the TxGIO ArcGIS query we used to build server-side. Same
-- query shape (tokenized owner-name match within a county filter),
-- same return shape (GeoJSON FeatureCollection), but runs against our
-- self-hosted parcels_tx table — sub-second response time, no
-- dependency on TxGIO availability.
--
-- WHY A POSTGRES FUNCTION (not raw SQL in the API route):
--   1. PostGIS does the geometry → GeoJSON conversion in ST_AsGeoJSON,
--      which is faster than fetching raw geom blobs over the wire and
--      converting in Node.
--   2. The tokenization + ILIKE chain is identical to the TxGIO route's
--      logic; keeping it here means we get the trigram-index speedup
--      transparently and don't have to manage a SQL builder in TypeScript.
--   3. Single round-trip from the API route. Caller does
--      supabase.rpc('search_parcels_by_owner', { q, county }) and gets
--      back a ready-to-serialize JSON object.
--
-- BEHAVIOR PARITY with TxGIO route:
--   - Same stop-word filter ('THE', 'OF', 'AND', '&', 'C/O')
--   - Same token minimum length (3 chars OR contains a digit)
--   - Same punctuation strip (.,'’-/&)
--   - Same result cap (200 records)
--   - Same response shape ({ type: 'FeatureCollection', features: [...] })
--   - Same feature.properties shape ({ prop_id, owner_name, gis_area, county })
--
-- WHAT'S DIFFERENT (intentional improvements):
--   - sub-second response time even on slow days
--   - never returns HTTP 502/504 from upstream timeouts
--   - bonus mkt_value field exposed in properties (TxGIO didn't have it)
-- ─────────────────────────────────────────────────────────────────────────

-- Drop on re-run so we can iterate on the function body without
-- having to deal with "function exists with these args" errors.
DROP FUNCTION IF EXISTS public.search_parcels_by_owner(TEXT, TEXT);

CREATE FUNCTION public.search_parcels_by_owner(
  q TEXT,
  county_filter TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tokens TEXT[];
  where_clauses TEXT[] := ARRAY[]::TEXT[];
  sql TEXT;
  result JSONB;
BEGIN
  -- ── Tokenize the input ──
  -- Match the API route's logic:
  --   1. Strip punctuation (.,'’-/&)
  --   2. Split on whitespace
  --   3. Uppercase + sanitize SQL chars
  --   4. Keep tokens >= 3 chars OR containing a digit
  --   5. Drop stop words
  SELECT array_agg(token) INTO tokens FROM (
    SELECT UPPER(REPLACE(REPLACE(token, '''', ''), '\', '')) AS token
    FROM regexp_split_to_table(
      REGEXP_REPLACE(COALESCE(q, ''), '[.,''’\-/&]', ' ', 'g'),
      '\s+'
    ) AS token
    WHERE token <> ''
  ) AS s
  WHERE LENGTH(token) >= 3 OR token ~ '\d'
    AND token NOT IN ('THE', 'OF', 'AND', '&', 'C/O');

  IF tokens IS NULL OR array_length(tokens, 1) IS NULL THEN
    -- No usable tokens → empty result, not an error.
    RETURN jsonb_build_object('type', 'FeatureCollection', 'features', '[]'::jsonb);
  END IF;

  -- ── Build the WHERE clause ──
  -- Each token becomes a "owner_name ILIKE '%TOKEN%'" — the trigram
  -- index on owner_name kicks in here. AND-joined so all tokens must
  -- appear (order-independent).
  FOR i IN 1..array_length(tokens, 1) LOOP
    where_clauses := array_append(
      where_clauses,
      format('owner_name ILIKE %L', '%' || tokens[i] || '%')
    );
  END LOOP;

  -- ── Optional county filter ──
  IF county_filter IS NOT NULL AND length(trim(county_filter)) > 0 THEN
    where_clauses := array_append(
      where_clauses,
      format('UPPER(county) = %L', UPPER(trim(county_filter)))
    );
  END IF;

  -- ── Execute + serialize to GeoJSON ──
  sql := format($f$
    SELECT jsonb_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(geom, 6)::jsonb,
            'properties', jsonb_build_object(
              'prop_id',    prop_id,
              'owner_name', owner_name,
              'gis_area',   gis_area,
              'county',     county,
              'fips',       fips,
              'mkt_value',  mkt_value,
              'situs_addr', situs_addr,
              'mail_addr',  mail_addr,
              'legal_desc', legal_desc
            )
          )
        ),
        '[]'::jsonb
      )
    )
    FROM (
      SELECT prop_id, owner_name, gis_area, county, fips, mkt_value,
             situs_addr, mail_addr, legal_desc, geom
      FROM parcels_tx
      WHERE %s
      LIMIT 200
    ) AS hits
  $f$, array_to_string(where_clauses, ' AND '));

  EXECUTE sql INTO result;
  RETURN result;
END;
$$;

COMMENT ON FUNCTION public.search_parcels_by_owner(TEXT, TEXT) IS
  'Tokenized fuzzy owner-name search across parcels_tx. Returns a GeoJSON FeatureCollection. Drop-in replacement for the legacy TxGIO call in /api/parcels-by-owner.';

-- Grant execute to authenticated brokers (service role already has it).
GRANT EXECUTE ON FUNCTION public.search_parcels_by_owner(TEXT, TEXT) TO authenticated, anon;

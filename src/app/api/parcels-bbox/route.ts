import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';

// Viewport-based parcel proxy. Returns up to 2000 parcels intersecting the
// requested bbox as a GeoJSON FeatureCollection. Used by the map to render
// parcel boundaries and owner labels as the user pans.
//
// Request: /api/parcels-bbox?bbox=minLng,minLat,maxLng,maxLat
//
// History:
//   v1 hit TxGIO's ArcGIS endpoint (~20s under load). We added retries,
//   bbox-snap-to-grid caching, and a 25-30s timeout. Even with all that,
//   TxGIO outages still made the map go blank.
//   v2 (this file) queries our self-hosted parcels_tx table via the GIST
//   index. Bbox queries return in <500ms on cold cache; the same caching
//   layer in front means most user pans hit Vercel edge instantly.
//
// We keep the same grid-snap caching strategy so cache hit rates stay high:
//   1. Snap incoming bbox outward to 0.02° (~2km) cells.
//   2. Cache for 24h on Vercel's edge (parcel data changes ~annually).
//   3. On DB error, return empty FeatureCollection with short cache so the
//      next pan triggers a fresh attempt rather than freezing the map.

export const maxDuration = 15;

const GRID = 0.02; // ~2km in TX, balances cache hit rate vs. data overhead

function getTransactionPoolerUrl(): string {
  const sessionUrl = process.env.PARCELS_POOLER_URL;
  if (!sessionUrl) return '';
  return sessionUrl.replace(':5432/', ':6543/');
}

const pool = process.env.PARCELS_POOLER_URL
  ? new Pool({
      connectionString: getTransactionPoolerUrl(),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
    })
  : null;

// Snap a bbox outward to the next grid cell on each side. Guarantees the
// snapped bbox is ≥ the original (no missed parcels at the edge) and
// drastically improves cache hit rate as users pan continuously.
function snapBbox(
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number
): [number, number, number, number] {
  return [
    Math.floor(minLng / GRID) * GRID,
    Math.floor(minLat / GRID) * GRID,
    Math.ceil(maxLng / GRID) * GRID,
    Math.ceil(maxLat / GRID) * GRID,
  ].map((v) => Number(v.toFixed(4))) as [number, number, number, number];
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const bbox = searchParams.get('bbox');
  if (!bbox || bbox.split(',').length !== 4) {
    return NextResponse.json(
      { error: 'bbox=minLng,minLat,maxLng,maxLat required' },
      { status: 400 }
    );
  }
  const parts = bbox.split(',').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) {
    return NextResponse.json({ error: 'bbox must be 4 numbers' }, { status: 400 });
  }
  const [minLng, minLat, maxLng, maxLat] = snapBbox(parts[0], parts[1], parts[2], parts[3]);
  const snappedStr = `${minLng},${minLat},${maxLng},${maxLat}`;

  if (!pool) {
    return new NextResponse(
      JSON.stringify({ type: 'FeatureCollection', features: [] }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/geo+json',
          'Cache-Control': 'public, max-age=30',
          'X-Source-Error': 'PARCELS_POOLER_URL not set',
          'X-Snapped-Bbox': snappedStr,
        },
      }
    );
  }

  try {
    // geom && ST_MakeEnvelope uses the GIST index for fast bbox-overlap.
    // We don't need exact ST_Intersects refinement for map rendering —
    // bbox overlap is what the visual layer wants anyway, and skipping
    // refinement is significantly faster on dense viewports.
    const sql = `
      SELECT jsonb_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'type', 'Feature',
              'geometry', ST_AsGeoJSON(geom, 6)::jsonb,
              'properties', jsonb_build_object(
                'prop_id', prop_id,
                'owner_name', owner_name,
                'gis_area', gis_area,
                'county', county
              )
            )
          ),
          '[]'::jsonb
        )
      ) AS fc
      FROM (
        SELECT prop_id, owner_name, gis_area, county, geom
        FROM parcels_tx
        WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
        LIMIT 2000
      ) AS hits
    `;
    const result = await pool.query(sql, [minLng, minLat, maxLng, maxLat]);
    const fc = result.rows[0]?.fc || { type: 'FeatureCollection', features: [] };

    return new NextResponse(JSON.stringify(fc), {
      status: 200,
      headers: {
        'Content-Type': 'application/geo+json',
        // Parcel data changes ~annually — cache 1h browser, 24h edge.
        'Cache-Control':
          'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
        'X-Parcel-Source': 'self-hosted',
        'X-Snapped-Bbox': snappedStr,
      },
    });
  } catch (e: any) {
    console.warn('[parcels-bbox] DB query failed:', e?.message);
    return new NextResponse(
      JSON.stringify({ type: 'FeatureCollection', features: [] }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/geo+json',
          // Short cache on failure so a retry happens soon.
          'Cache-Control': 'public, max-age=30',
          'X-Source-Error': String(e?.message || 'unknown').slice(0, 200),
          'X-Snapped-Bbox': snappedStr,
        },
      }
    );
  }
}

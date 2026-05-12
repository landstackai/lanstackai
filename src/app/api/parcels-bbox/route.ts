import { NextRequest, NextResponse } from 'next/server';

// Viewport-based parcel proxy. Returns up to 2000 TxGIO parcels intersecting
// the requested bbox as GeoJSON. Used by the map to render parcel boundaries
// and owner labels statewide on the fly as the user pans.
//
// Request: /api/parcels-bbox?bbox=minLng,minLat,maxLng,maxLat
//
// TxGIO is severely slow (~20s for tiny bboxes). To make this usable:
//   1. Snap incoming bbox outward to a 0.02° grid (~2km cells). All panning
//      within a cell hits the same cached response.
//   2. Cache for 24h on Vercel's edge (parcel data changes monthly at most).
//   3. Retry on timeout with progressively longer windows.
//   4. On final failure, return an empty FeatureCollection (200) so the map
//      doesn't error-toast — the next pan triggers a fresh fetch.

const TXGIO_QUERY =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query';

const GRID = 0.02; // ~2km in TX, balances cache hit rate vs. data overhead

// Snap a bbox outward to the next grid cell on each side. This guarantees
// the snapped bbox is ≥ the original (no missed parcels at the edge) and
// drastically improves cache hit rate as users pan.
function snapBbox(minLng: number, minLat: number, maxLng: number, maxLat: number) {
  return [
    Math.floor(minLng / GRID) * GRID,
    Math.floor(minLat / GRID) * GRID,
    Math.ceil(maxLng / GRID) * GRID,
    Math.ceil(maxLat / GRID) * GRID,
  ].map((v) => Number(v.toFixed(4))).join(',');
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const bbox = searchParams.get('bbox');
  if (!bbox || bbox.split(',').length !== 4) {
    return NextResponse.json({ error: 'bbox=minLng,minLat,maxLng,maxLat required' }, { status: 400 });
  }
  const parts = bbox.split(',').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) {
    return NextResponse.json({ error: 'bbox must be 4 numbers' }, { status: 400 });
  }
  const snapped = snapBbox(parts[0], parts[1], parts[2], parts[3]);

  const params = new URLSearchParams({
    geometry: snapped,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'prop_id,owner_name,gis_area,county',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '6',
    resultRecordCount: '2000',
    f: 'geojson',
  });

  async function fetchOnce(timeoutMs: number) {
    const upstream = await fetch(`${TXGIO_QUERY}?${params}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!upstream.ok) throw new Error(`Upstream ${upstream.status}`);
    return upstream.json();
  }

  let data: any = null;
  let lastErr: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      data = await fetchOnce(attempt === 0 ? 25000 : 30000);
      break;
    } catch (e: any) {
      lastErr = e;
    }
  }

  if (!data) {
    console.warn('[parcels-bbox] upstream failed after retry:', lastErr?.message);
    return new NextResponse(
      JSON.stringify({ type: 'FeatureCollection', features: [] }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/geo+json',
          // Short cache on failure so a retry happens soon.
          'Cache-Control': 'public, max-age=30',
          'X-Upstream-Error': String(lastErr?.message || 'unknown').slice(0, 200),
          'X-Snapped-Bbox': snapped,
        },
      }
    );
  }

  return new NextResponse(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/geo+json',
      // Parcel data changes monthly at most — cache for 24h on Vercel edge,
      // 1h in browser. After the first slow request to a region, every
      // subsequent visit hits Vercel's cache instantly (no TxGIO call).
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
      'X-Snapped-Bbox': snapped,
    },
  });
}

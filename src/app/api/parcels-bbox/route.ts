import { NextRequest, NextResponse } from 'next/server';

// Viewport-based parcel proxy. Returns up to 2000 TxGIO parcels intersecting
// the requested bbox as GeoJSON. Used by the map to render parcel boundaries
// and owner labels statewide on the fly as the user pans.
//
// Request: /api/parcels-bbox?bbox=minLng,minLat,maxLng,maxLat
//
// At zoom < ~13 a TX bbox can hold >2000 parcels. The map should only call
// this route when zoomed in enough.

const TXGIO_QUERY =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const bbox = searchParams.get('bbox');
  if (!bbox || bbox.split(',').length !== 4) {
    return NextResponse.json({ error: 'bbox=minLng,minLat,maxLng,maxLat required' }, { status: 400 });
  }

  const params = new URLSearchParams({
    geometry: bbox,
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

  // TxGIO is occasionally slow (>10s) under load. Try once with a forgiving
  // timeout, retry once on timeout/5xx, then give up. Return an empty
  // FeatureCollection (not a 502) so the map doesn't show an error toast for
  // a transient upstream blip — the user can pan and it'll retry.
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
      data = await fetchOnce(attempt === 0 ? 20000 : 25000);
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
          'Cache-Control': 'public, max-age=30',
          'X-Upstream-Error': String(lastErr?.message || 'unknown').slice(0, 200),
        },
      }
    );
  }

  return new NextResponse(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/geo+json',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
    },
  });
}

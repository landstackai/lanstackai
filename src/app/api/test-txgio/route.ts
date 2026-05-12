import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/test-txgio?county=Frio&minAcres=370&maxAcres=460
 *
 * Diagnostic endpoint — exposes exactly what TxGIO returns for a given
 * county + acreage range. Use this to confirm whether the auto-locate
 * pipeline's data source is functioning, what fields the candidates have,
 * and whether the assumed units (acres) match reality.
 *
 * Hit in browser, paste response back to debugging chat.
 */

const TXGIO_QUERY =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const county = (searchParams.get('county') || '').replace(/[^a-zA-Z\s\-]/g, '').trim();
  const minA = Number(searchParams.get('minAcres') ?? 0);
  const maxA = Number(searchParams.get('maxAcres') ?? 1_000_000);
  if (!county) {
    return NextResponse.json({ error: 'county query param required' }, { status: 400 });
  }

  const u = county.toUpperCase();
  const where = `(UPPER(county) = '${u}' OR UPPER(county) = '${u} COUNTY') AND gis_area BETWEEN ${minA} AND ${maxA}`;

  const params = new URLSearchParams({
    where,
    outFields: '*',                       // return ALL fields so we can see what's there
    returnGeometry: 'false',              // skip geometry — keep response small
    outSR: '4326',
    resultRecordCount: '20',
    f: 'geojson',
  });

  const fullUrl = `${TXGIO_QUERY}?${params}`;

  try {
    const res = await fetch(fullUrl, { signal: AbortSignal.timeout(15000) });
    const status = res.status;
    const statusText = res.statusText;
    let body: any;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    return NextResponse.json({
      ok: res.ok,
      status,
      statusText,
      where_clause: where,
      url: fullUrl,
      feature_count: Array.isArray(body?.features) ? body.features.length : 0,
      // Just the first 5 features' properties (no geometry) — easier to read.
      sample_features: Array.isArray(body?.features)
        ? body.features.slice(0, 5).map((f: any) => f.properties)
        : null,
      raw_body_if_unparseable: typeof body === 'string' ? body.slice(0, 1000) : null,
    });
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      error: e?.message || 'fetch failed',
      url: fullUrl,
      where_clause: where,
    }, { status: 500 });
  }
}

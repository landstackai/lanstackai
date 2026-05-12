import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/health/txgio
 * GET /api/health/txgio?bbox=minLng,minLat,maxLng,maxLat
 *
 * One-shot diagnostic for TxGIO upstream. Reports:
 *   - HTTP status + statusText
 *   - latency (ms)
 *   - response headers (so we can spot 429 rate-limit headers, retry-after, etc.)
 *   - feature_count for a known-good rural-TX bbox
 *   - and (optional) for the user-supplied bbox
 *
 * Use this to distinguish:
 *   - 403 / 429              → we're blocked / rate limited
 *   - 5xx                    → TxGIO is broken
 *   - Slow but 200           → just upstream latency, retry will save us
 *   - 200 with 0 features    → bbox is over empty area (water / outside TX)
 */

const TXGIO_QUERY =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query';

// A known-good small bbox over rural Frio County, TX. Always returns parcels
// under normal operation. If THIS bbox returns nothing, the service is broken.
const CONTROL_BBOX = '-99.20,28.92,-99.18,28.94';

async function probe(bbox: string) {
  const params = new URLSearchParams({
    geometry: bbox,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'prop_id,owner_name,gis_area,county',
    returnGeometry: 'false',
    outSR: '4326',
    resultRecordCount: '50',
    f: 'geojson',
  });
  const url = `${TXGIO_QUERY}?${params}`;
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const ms = Date.now() - started;
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    let body: any = null;
    let parseError: string | null = null;
    try {
      body = await res.json();
    } catch (e: any) {
      parseError = e?.message || 'parse failed';
    }
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      latency_ms: ms,
      bbox,
      headers,
      feature_count: Array.isArray(body?.features) ? body.features.length : 0,
      sample_feature: Array.isArray(body?.features) && body.features.length > 0
        ? body.features[0].properties
        : null,
      parse_error: parseError,
      url,
    };
  } catch (e: any) {
    const ms = Date.now() - started;
    return {
      ok: false,
      status: 0,
      statusText: e?.name || 'fetch-error',
      latency_ms: ms,
      bbox,
      headers: {},
      feature_count: 0,
      sample_feature: null,
      parse_error: null,
      error: e?.message || 'unknown',
      url,
    };
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userBbox = searchParams.get('bbox');

  const control = await probe(CONTROL_BBOX);
  const user = userBbox && userBbox.split(',').length === 4 ? await probe(userBbox) : null;

  // Verdict
  let verdict = 'unknown';
  let recommendation = '';
  if (control.status === 0) {
    verdict = 'network_failure';
    recommendation = `Could not reach TxGIO at all. ${control.statusText} after ${control.latency_ms}ms. Either DNS / your network is blocking outbound, or TxGIO is completely down.`;
  } else if (control.status === 403) {
    verdict = 'blocked';
    recommendation = 'TxGIO returned 403 Forbidden. Your server IP may be banned. Check headers for clues, or contact geographic.texas.gov.';
  } else if (control.status === 429) {
    verdict = 'rate_limited';
    recommendation = 'TxGIO returned 429 Too Many Requests. Slow down call rate, or use the retry-after header.';
  } else if (control.status >= 500) {
    verdict = 'upstream_down';
    recommendation = `TxGIO returned ${control.status}. Their service is broken — wait and retry.`;
  } else if (control.ok && control.feature_count === 0) {
    verdict = 'empty_response';
    recommendation = 'TxGIO returned 200 OK but zero features for the control bbox over rural Frio County. Service is functional but data may be missing.';
  } else if (control.ok && control.latency_ms > 15000) {
    verdict = 'severely_slow';
    recommendation = `TxGIO works but took ${(control.latency_ms / 1000).toFixed(1)}s for a small bbox. Production timeouts likely. Their service is overloaded.`;
  } else if (control.ok && control.latency_ms > 5000) {
    verdict = 'slow';
    recommendation = `TxGIO works but is slow (${(control.latency_ms / 1000).toFixed(1)}s). The retry pipeline should mask this.`;
  } else if (control.ok) {
    verdict = 'healthy';
    recommendation = `TxGIO is healthy (${control.latency_ms}ms, ${control.feature_count} features). If your map still shows nothing, the issue is on the client side — check browser console for [txgio-bbox] logs.`;
  }

  return NextResponse.json({
    verdict,
    recommendation,
    timestamp: new Date().toISOString(),
    control_probe: control,
    user_bbox_probe: user,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

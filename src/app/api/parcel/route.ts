import { NextRequest, NextResponse } from 'next/server';

// Allow the function to run up to 30s — needed when TxGIO is slow.
// Note: requires Vercel Pro plan. On Hobby (10s cap) we'll still get
// timed out at 10s no matter what fetch timeout we set internally.
export const maxDuration = 30;

const TXGIO_QUERY_URL =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query';

const REGRID_API_KEY = process.env.REGRID_API_KEY;
const REGRID_BASE = 'https://app.regrid.com/api/v2';

type Parcel = {
  parcel_id: string;
  owner_name: string | null;
  acres: number | null;
  address: string | null;
  county: string | null;
  state: string;
  latitude: number;
  longitude: number;
  geometry: any;
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const lat = searchParams.get('lat');
  const lng = searchParams.get('lng');
  const parcelId = searchParams.get('parcel_id');

  if (!lat && !lng && !parcelId) {
    return NextResponse.json({ error: 'lat/lng or parcel_id required' }, { status: 400 });
  }

  // Prefer Regrid when configured — it's sub-second, US-wide, and reliable.
  // Fall back to TxGIO (slower, free) only if Regrid is unavailable or empty.
  if (REGRID_API_KEY) {
    const regrid = await tryRegrid(lat, lng, parcelId);
    if (regrid) {
      return NextResponse.json(regrid, {
        headers: {
          'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
          'X-Parcel-Source': 'regrid',
        },
      });
    }
    console.warn('[api/parcel] Regrid returned no data, falling back to TxGIO');
  }

  let txGioErr: string | null = null;
  if (lat && lng) {
    const result = await tryTxGIO(parseFloat(lat), parseFloat(lng));
    if (result.parcel) {
      return NextResponse.json(result.parcel, {
        headers: {
          'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
          'X-Parcel-Source': 'txgio',
        },
      });
    }
    txGioErr = result.error;
  }

  return NextResponse.json(
    { error: 'No parcel data at this location', reason: txGioErr || 'no_match' },
    { status: 404 }
  );
}

async function tryTxGIO(lat: number, lng: number): Promise<{ parcel: Parcel | null; error: string | null }> {
  // ~10m envelope around the click point
  const d = 0.0001;
  const params = new URLSearchParams({
    geometry: `${lng - d},${lat - d},${lng + d},${lat + d}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'prop_id,owner_name,gis_area,situs_addr,county,situs_stat,mkt_value,land_value',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '1',
    f: 'geojson',
  });

  // TxGIO is severely slow under load (~20s for tiny queries). Try twice
  // with forgiving timeouts before giving up.
  async function fetchOnce(timeoutMs: number) {
    const res = await fetch(`${TXGIO_QUERY_URL}?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    return res.json();
  }

  let data: any = null;
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      data = await fetchOnce(attempt === 0 ? 12000 : 14000);
      break;
    } catch (e: any) {
      lastErr = `${e?.name || 'err'}: ${e?.message || 'unknown'}`;
      if (attempt === 1) console.warn('[api/parcel] TxGIO failed after retry:', lastErr);
    }
  }
  if (!data) return { parcel: null, error: lastErr || 'no_data' };

  const f = data.features?.[0];
  if (!f) return { parcel: null, error: 'no_match' };
  const p = f.properties || {};
  const acres = parseFloat(p.gis_area);
  const cleanAddr = (p.situs_addr || '').replace(/[\s,]+/g, '').length === 0 ? null : p.situs_addr;
  const cleanState = (p.situs_stat || '').trim() || 'TX';
  return {
    parcel: {
      parcel_id: p.prop_id || String(f.id || ''),
      owner_name: p.owner_name || null,
      acres: Number.isFinite(acres) ? acres : null,
      address: cleanAddr,
      county: p.county || null,
      state: cleanState,
      latitude: lat,
      longitude: lng,
      geometry: f.geometry || null,
    },
    error: null,
  };
}

async function tryRegrid(
  lat: string | null,
  lng: string | null,
  parcelId: string | null
): Promise<Parcel | null> {
  if (!REGRID_API_KEY) {
    console.warn('[api/parcel] REGRID_API_KEY not set');
    return null;
  }
  try {
    // Try the standard Regrid v2 point query first, then v1 as a fallback if
    // the v2 endpoint shape doesn't match what we expect.
    const candidates: string[] = [];
    if (lat && lng) {
      candidates.push(
        `${REGRID_BASE}/parcels.json?lat=${lat}&lon=${lng}&token=${REGRID_API_KEY}`,
        `${REGRID_BASE}/query?lat=${lat}&lon=${lng}&token=${REGRID_API_KEY}&fields=fields.basic,fields.owner,fields.boundary`,
        `https://app.regrid.com/api/v1/search.json?query=${lat},${lng}&token=${REGRID_API_KEY}`,
      );
    } else if (parcelId) {
      candidates.push(
        `${REGRID_BASE}/parcels/${parcelId}.json?token=${REGRID_API_KEY}`,
        `${REGRID_BASE}/query?parcel_id=${parcelId}&token=${REGRID_API_KEY}&fields=fields.basic,fields.owner,fields.boundary`,
      );
    } else {
      return null;
    }

    let parcel: any = null;
    let lastDiag = '';
    for (const url of candidates) {
      const safeUrl = url.replace(REGRID_API_KEY, 'TOKEN_REDACTED');
      const t0 = Date.now();
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const ms = Date.now() - t0;
        const text = await response.text();
        let data: any = null;
        try { data = JSON.parse(text); } catch {}
        lastDiag = `[regrid] ${response.status} ${ms}ms ${safeUrl} → ${text.slice(0, 200)}`;
        if (!response.ok) {
          console.warn(lastDiag);
          continue;
        }
        // Try several known Regrid response shapes
        parcel = data?.parcels?.[0]
          || data?.results?.[0]
          || data?.features?.[0]
          || (Array.isArray(data) ? data[0] : null);
        if (parcel) {
          console.log(`[regrid] ✓ hit at ${safeUrl} (${ms}ms)`);
          break;
        }
        console.warn(`[regrid] 200 but no parcel found: ${text.slice(0, 200)}`);
      } catch (e: any) {
        lastDiag = `[regrid] threw ${e?.name}: ${e?.message} (${safeUrl})`;
        console.warn(lastDiag);
      }
    }

    if (!parcel) {
      console.warn('[api/parcel] All Regrid endpoints failed. Last diag:', lastDiag);
      return null;
    }
    // Regrid responses can come in multiple shapes — fields could be on
    // `fields`, `properties`, or directly on the parcel object.
    const f = parcel.fields || parcel.properties || parcel;
    return {
      parcel_id: f.parno || f.parcelnumb || parcel.id || f.ogc_fid || '',
      owner_name: f.owner || f.owner_name || null,
      acres: f.gisacre || f.calc_acreage || f.ll_gisacre || f.acres || null,
      address: f.address || f.saddno && f.saddstr ? `${f.saddno || ''} ${f.saddstr || ''}`.trim() || f.address : f.address || null,
      county: f.county || f.county_name || null,
      state: f.state_abbr || f.state || 'TX',
      latitude: parseFloat(lat || '0'),
      longitude: parseFloat(lng || '0'),
      geometry: parcel.geometry || null,
    };
  } catch (e: any) {
    console.warn('[api/parcel] tryRegrid threw:', e?.message);
    return null;
  }
}


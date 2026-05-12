import { NextRequest, NextResponse } from 'next/server';

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

  if (lat && lng) {
    const txgio = await tryTxGIO(parseFloat(lat), parseFloat(lng));
    if (txgio) {
      return NextResponse.json(txgio, {
        headers: {
          // Lat/lng to ~10m precision → cache hits when user re-clicks same spot.
          'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
        },
      });
    }
  }

  if (REGRID_API_KEY) {
    const regrid = await tryRegrid(lat, lng, parcelId);
    if (regrid) {
      return NextResponse.json(regrid, {
        headers: { 'Cache-Control': 'public, max-age=300, s-maxage=86400' },
      });
    }
  }

  return NextResponse.json({ error: 'No parcel data at this location' }, { status: 404 });
}

async function tryTxGIO(lat: number, lng: number): Promise<Parcel | null> {
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
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      data = await fetchOnce(attempt === 0 ? 25000 : 30000);
      break;
    } catch (e: any) {
      if (attempt === 1) console.warn('[api/parcel] TxGIO failed after retry:', e?.message);
    }
  }
  if (!data) return null;

  const f = data.features?.[0];
  if (!f) return null;
  const p = f.properties || {};
  const acres = parseFloat(p.gis_area);
  const cleanAddr = (p.situs_addr || '').replace(/[\s,]+/g, '').length === 0 ? null : p.situs_addr;
  const cleanState = (p.situs_stat || '').trim() || 'TX';
  return {
    parcel_id: p.prop_id || String(f.id || ''),
    owner_name: p.owner_name || null,
    acres: Number.isFinite(acres) ? acres : null,
    address: cleanAddr,
    county: p.county || null,
    state: cleanState,
    latitude: lat,
    longitude: lng,
    geometry: f.geometry || null,
  };
}

async function tryRegrid(
  lat: string | null,
  lng: string | null,
  parcelId: string | null
): Promise<Parcel | null> {
  try {
    let url = '';
    if (lat && lng) {
      url = `${REGRID_BASE}/query?lat=${lat}&lon=${lng}&token=${REGRID_API_KEY}&fields=fields.basic,fields.owner,fields.boundary`;
    } else if (parcelId) {
      url = `${REGRID_BASE}/query?parcel_id=${parcelId}&token=${REGRID_API_KEY}&fields=fields.basic,fields.owner,fields.boundary`;
    } else {
      return null;
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    const parcel = data.parcels?.[0];
    if (!parcel) return null;
    return {
      parcel_id: parcel.fields?.parno || parcel.id,
      owner_name: parcel.fields?.owner || null,
      acres: parcel.fields?.gisacre || parcel.fields?.calc_acreage || null,
      address: parcel.fields?.address || null,
      county: parcel.fields?.county || null,
      state: parcel.fields?.state_abbr || 'TX',
      latitude: parseFloat(lat || '0'),
      longitude: parseFloat(lng || '0'),
      geometry: parcel.geometry || null,
    };
  } catch {
    return null;
  }
}


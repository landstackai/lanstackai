import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';

// Self-hosted parcels DB now handles the primary lookup. Regrid stays as
// a fallback for the 2 counties our import missed (Jones 48253, Stonewall
// 48445 — data-quality issues in numeric columns) and for any future
// non-TX queries.
export const maxDuration = 15;

const REGRID_API_KEY = process.env.REGRID_API_KEY;
const REGRID_BASE = 'https://app.regrid.com/api/v2';

// Module-level pool. Same pattern as /api/parcels-by-owner: derive the
// transaction-pooler URL (port 6543) from PARCELS_POOLER_URL (port 5432).
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
    return NextResponse.json(
      { error: 'lat/lng or parcel_id required' },
      { status: 400 }
    );
  }

  // Primary: self-hosted parcels_tx via PostGIS ST_Contains. Sub-50ms with
  // the GIST index. Works for 251 of 253 TX counties.
  if (lat && lng && pool) {
    const result = await tryParcelsTx(parseFloat(lat), parseFloat(lng));
    if (result.parcel) {
      return NextResponse.json(result.parcel, {
        headers: {
          'Cache-Control':
            'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
          'X-Parcel-Source': 'self-hosted',
        },
      });
    }
    // Don't return yet — try Regrid fallback for the gap counties.
  }
  if (parcelId && pool) {
    const result = await tryParcelsTxById(parcelId);
    if (result.parcel) {
      return NextResponse.json(result.parcel, {
        headers: {
          'Cache-Control':
            'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
          'X-Parcel-Source': 'self-hosted',
        },
      });
    }
  }

  // Fallback: Regrid (if configured). Catches the 2 TX counties we don't
  // host yet, plus any non-TX queries we might add later.
  if (REGRID_API_KEY) {
    const regrid = await tryRegrid(lat, lng, parcelId);
    if (regrid) {
      return NextResponse.json(regrid, {
        headers: {
          'Cache-Control':
            'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
          'X-Parcel-Source': 'regrid',
        },
      });
    }
  }

  return NextResponse.json(
    { error: 'No parcel data at this location', reason: 'no_match' },
    { status: 404 }
  );
}

async function tryParcelsTx(
  lat: number,
  lng: number
): Promise<{ parcel: Parcel | null; error: string | null }> {
  if (!pool) return { parcel: null, error: 'pool_unconfigured' };
  try {
    // ST_Contains uses the GIST index automatically when the geom column is
    // indexed. LIMIT 1 because a click point lands in at most one parcel
    // (Texas parcels don't overlap meaningfully).
    const sql = `
      SELECT
        prop_id,
        owner_name,
        gis_area,
        situs_addr,
        county,
        situs_stat,
        mkt_value,
        land_value,
        ST_AsGeoJSON(geom, 6)::jsonb AS geometry
      FROM parcels_tx
      WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
      LIMIT 1
    `;
    const result = await pool.query(sql, [lng, lat]);
    if (result.rows.length === 0) {
      return { parcel: null, error: 'no_match' };
    }
    const r = result.rows[0];
    const acres = parseFloat(r.gis_area);
    const cleanAddr =
      (r.situs_addr || '').replace(/[\s,]+/g, '').length === 0
        ? null
        : r.situs_addr;
    const cleanState = (r.situs_stat || '').trim() || 'TX';
    return {
      parcel: {
        parcel_id: r.prop_id || '',
        owner_name: r.owner_name || null,
        acres: Number.isFinite(acres) ? acres : null,
        address: cleanAddr,
        county: r.county || null,
        state: cleanState,
        latitude: lat,
        longitude: lng,
        geometry: r.geometry || null,
      },
      error: null,
    };
  } catch (e: any) {
    console.warn('[api/parcel] tryParcelsTx threw:', e?.message);
    return { parcel: null, error: `db_error: ${e?.message || 'unknown'}` };
  }
}

async function tryParcelsTxById(
  parcelId: string
): Promise<{ parcel: Parcel | null; error: string | null }> {
  if (!pool) return { parcel: null, error: 'pool_unconfigured' };
  try {
    const sql = `
      SELECT
        prop_id,
        owner_name,
        gis_area,
        situs_addr,
        county,
        situs_stat,
        mkt_value,
        land_value,
        ST_Y(ST_Centroid(geom)) AS lat,
        ST_X(ST_Centroid(geom)) AS lng,
        ST_AsGeoJSON(geom, 6)::jsonb AS geometry
      FROM parcels_tx
      WHERE prop_id = $1
      LIMIT 1
    `;
    const result = await pool.query(sql, [parcelId]);
    if (result.rows.length === 0) {
      return { parcel: null, error: 'no_match' };
    }
    const r = result.rows[0];
    const acres = parseFloat(r.gis_area);
    const cleanAddr =
      (r.situs_addr || '').replace(/[\s,]+/g, '').length === 0
        ? null
        : r.situs_addr;
    const cleanState = (r.situs_stat || '').trim() || 'TX';
    return {
      parcel: {
        parcel_id: r.prop_id || '',
        owner_name: r.owner_name || null,
        acres: Number.isFinite(acres) ? acres : null,
        address: cleanAddr,
        county: r.county || null,
        state: cleanState,
        latitude: r.lat,
        longitude: r.lng,
        geometry: r.geometry || null,
      },
      error: null,
    };
  } catch (e: any) {
    console.warn('[api/parcel] tryParcelsTxById threw:', e?.message);
    return { parcel: null, error: `db_error: ${e?.message || 'unknown'}` };
  }
}

async function tryRegrid(
  lat: string | null,
  lng: string | null,
  parcelId: string | null
): Promise<Parcel | null> {
  if (!REGRID_API_KEY) return null;
  try {
    const candidates: string[] = [];
    if (lat && lng) {
      candidates.push(
        `${REGRID_BASE}/parcels.json?lat=${lat}&lon=${lng}&token=${REGRID_API_KEY}`,
        `${REGRID_BASE}/query?lat=${lat}&lon=${lng}&token=${REGRID_API_KEY}&fields=fields.basic,fields.owner,fields.boundary`,
        `https://app.regrid.com/api/v1/search.json?query=${lat},${lng}&token=${REGRID_API_KEY}`
      );
    } else if (parcelId) {
      candidates.push(
        `${REGRID_BASE}/parcels/${parcelId}.json?token=${REGRID_API_KEY}`,
        `${REGRID_BASE}/query?parcel_id=${parcelId}&token=${REGRID_API_KEY}&fields=fields.basic,fields.owner,fields.boundary`
      );
    } else {
      return null;
    }

    let parcel: any = null;
    for (const url of candidates) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) continue;
        const data = await response.json().catch(() => null);
        parcel =
          data?.parcels?.[0] ||
          data?.results?.[0] ||
          data?.features?.[0] ||
          (Array.isArray(data) ? data[0] : null);
        if (parcel) break;
      } catch {
        // try next candidate
      }
    }

    if (!parcel) return null;
    const f = parcel.fields || parcel.properties || parcel;
    return {
      parcel_id: f.parno || f.parcelnumb || parcel.id || f.ogc_fid || '',
      owner_name: f.owner || f.owner_name || null,
      acres: f.gisacre || f.calc_acreage || f.ll_gisacre || f.acres || null,
      address:
        f.address ||
        (f.saddno && f.saddstr
          ? `${f.saddno || ''} ${f.saddstr || ''}`.trim() || f.address
          : f.address || null),
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

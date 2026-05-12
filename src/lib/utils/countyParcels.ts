// Shared per-county CAD parcel data layer.
//
// Used by:
//   - /api/county-parcels/[county]      — proxies to the browser as GeoJSON
//   - /api/import-chat                  — enriches imported comps with the
//                                         owner's full contiguous holding
//
// The fetched FeatureCollection is cached in module memory for `CACHE_TTL_MS`,
// so subsequent reads inside the same Node.js process don't re-pay the upstream
// download cost. In production behind a CDN, the proxy's `s-maxage=86400`
// header handles cross-process caching.

// @ts-expect-error — turf v6.5 types not exposed via package "exports"
import * as turf from '@turf/turf';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type CountySource = {
  queryBase: string;
  outFields: string;
  pageSize: number;
  ownerField: string;
  parcelIdField: string;
  acresField: string;
  attribution: string;
  // Optional: build a human address from per-county field names
  addressFromProps?: (p: any) => string | null;
};

export const COUNTY_SOURCES: Record<string, CountySource> = {
  blanco: {
    queryBase:
      'https://services7.arcgis.com/GsFOwV8KcywEbxTn/arcgis/rest/services/BlancoCADWebService/FeatureServer/0/query',
    outFields:
      'prop_id,prop_id_text,file_as_name,legal_acreage,situs_num,situs_street_prefx,situs_street,situs_street_sufix,situs_city,legal_desc,market,land_val,imprv_val',
    pageSize: 2000,
    ownerField: 'file_as_name',
    parcelIdField: 'prop_id',
    acresField: 'legal_acreage',
    attribution: 'Parcels © Blanco CAD',
    addressFromProps: (p) => {
      const street = [p.situs_num, p.situs_street_prefx, p.situs_street, p.situs_street_sufix]
        .map((s: any) => (s == null ? '' : String(s).trim()))
        .filter(Boolean)
        .join(' ')
        .trim();
      const city = (p.situs_city || '').trim();
      const out = [street, city].filter(Boolean).join(', ');
      return out || null;
    },
  },

  // Frio County direct integration is PENDING — needs the actual Frio CAD
  // ArcGIS service URL. Until added here, Frio queries fall through to the
  // TxGIO statewide layer (which DOES have Frio parcel data, just less fresh).
  //
  // To add it later:
  //   1. Visit friocad.org → "GIS Maps" / "Interactive Map"
  //   2. Open the map. In Safari DevTools → Network, filter for
  //      "FeatureServer" or "MapServer". Find an XHR to a URL like
  //      `services<N>.arcgis.com/<orgID>/arcgis/rest/services/<...>/FeatureServer/0/query`
  //   3. Paste that URL here as a new `frio:` entry with appropriate
  //      outFields/ownerField/acresField for that service's schema.
};

type CacheEntry = { fetchedAt: number; data: any };
const memCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<any>>();

async function fetchPage(base: string, outFields: string, offset: number, limit: number) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    resultOffset: String(offset),
    resultRecordCount: String(limit),
  });
  const res = await fetch(`${base}?${params}`);
  if (!res.ok) throw new Error(`Upstream ${res.status}`);
  return res.json();
}

async function fetchAllPages(source: CountySource) {
  const features: any[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetchPage(source.queryBase, source.outFields, offset, source.pageSize);
    const got = (page.features || []) as any[];
    features.push(...got);
    if (got.length < source.pageSize) break;
    offset += source.pageSize;
    if (offset > 100_000) break;
  }
  return { type: 'FeatureCollection', features };
}

export async function getCountyParcels(countyKey: string): Promise<any> {
  const key = countyKey.toLowerCase();
  const source = COUNTY_SOURCES[key];
  if (!source) throw new Error(`Unknown county: ${key}`);

  const cached = memCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const data = await fetchAllPages(source);
      // Never cache empty results — a transient upstream failure (rate limit,
      // partial timeout) can return an inline error JSON which yields 0
      // features. Caching that would mean 0 parcels for 24h.
      const featureCount = data?.features?.length || 0;
      if (featureCount > 0) {
        memCache.set(key, { fetchedAt: Date.now(), data });
      }
      return data;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function getCountySource(countyKey: string): CountySource | null {
  return COUNTY_SOURCES[countyKey.toLowerCase()] || null;
}

export function findParcelAt(lat: number, lng: number, features: any[]): any | null {
  const point = turf.point([lng, lat]);
  for (const f of features) {
    if (!f?.geometry) continue;
    try {
      if (turf.booleanPointInPolygon(point, f as any)) return f;
    } catch {
      /* skip malformed */
    }
  }
  return null;
}

// BFS from a seed parcel through neighbors that share the same owner. A
// "neighbor" is any same-owner parcel whose geometry intersects (touches or
// overlaps) the current frontier — i.e. a connected component on the
// same-owner subgraph. Returns the seed alone if no neighbors are found.
export function findContiguousSameOwner(
  seed: any,
  features: any[],
  ownerField: string
): any[] {
  const norm = (s: any) => String(s ?? '').trim().toUpperCase();
  const ownerName = norm(seed.properties?.[ownerField]);
  if (!ownerName) return [seed];

  const candidates = features.filter(
    (f) => f !== seed && norm(f.properties?.[ownerField]) === ownerName
  );
  if (candidates.length === 0) return [seed];

  const selected = new Set<any>([seed]);
  let frontier: any[] = [seed];

  while (frontier.length > 0) {
    const nextFrontier: any[] = [];
    for (const cand of candidates) {
      if (selected.has(cand)) continue;
      let touches = false;
      for (const sel of frontier) {
        try {
          if (turf.booleanIntersects(cand as any, sel as any)) {
            touches = true;
            break;
          }
        } catch {
          /* malformed geometry — ignore */
        }
      }
      if (touches) {
        selected.add(cand);
        nextFrontier.push(cand);
      }
    }
    frontier = nextFrontier;
  }

  return Array.from(selected);
}

// If the merged contiguous same-owner holding differs from the
// reportedAcres (from the appraisal) by more than `tolerance` (default 10%),
// fall back to just the seed parcel — most likely a partial sale where the
// owner kept some adjoining land. Returns the chosen feature list plus a
// `mismatch` flag so the caller can surface a warning to the user.
export function selectBoundaryByAcreage<T extends { properties?: any }>(
  seed: T,
  holding: T[],
  reportedAcres: number | null | undefined,
  acresField: string,
  tolerance = 0.1
): { features: T[]; totalAcres: number; mismatch: boolean; rejected: boolean } {
  const seedAcres = parseFloat((seed as any).properties?.[acresField]) || 0;
  const totalAcres = holding.reduce(
    (sum, f) => sum + (parseFloat((f as any).properties?.[acresField]) || 0),
    0
  );
  if (!reportedAcres || reportedAcres <= 0) {
    return { features: holding, totalAcres, mismatch: false, rejected: false };
  }
  const within = (n: number) => {
    const r = n / reportedAcres;
    return r >= 1 - tolerance && r <= 1 + tolerance;
  };
  if (within(totalAcres)) {
    return { features: holding, totalAcres, mismatch: false, rejected: false };
  }
  if (within(seedAcres)) {
    // Holding is too big/small but the seed parcel matches the appraisal.
    // Common: seller owns adjacent land they kept; the seed alone is the sold tract.
    return { features: [seed], totalAcres: seedAcres, mismatch: true, rejected: false };
  }
  // Neither merge nor seed matches — refuse to save a boundary. The caller
  // should leave geometry null so the user can manually draw one via Edit
  // Boundary instead of seeing a wrong polygon.
  return { features: [], totalAcres: 0, mismatch: true, rejected: true };
}

export function mergeFeatures(features: any[]): any | null {
  if (features.length === 0) return null;
  let merged = features[0];
  for (let i = 1; i < features.length; i++) {
    try {
      const u = turf.union(merged, features[i]);
      if (u) merged = u;
    } catch {
      /* skip pairs that turf can't union */
    }
  }
  return merged;
}

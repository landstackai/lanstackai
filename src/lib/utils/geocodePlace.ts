// Forward-geocode helper for "best-effort map zoom" fallbacks.
//
// Used by the review page when a comp has no lat/lng + no boundary —
// instead of leaving the broker at the default wide-Texas view, we try
// to land them at something useful:
//
//   1. The comp's address (street-level zoom 14) if present
//   2. The county centroid (county-level zoom 9) as a last resort
//
// Both reuse the same Mapbox forward geocoder; only the query string +
// accepted feature types differ.
//
// Free tier covers 100K geocodes/month — generous for this use case
// since brokers only hit it on review-page page-load for comps lacking
// coordinates (rare after the import flow's autoLocate succeeds).

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export type GeocodeResult = {
  lat: number;
  lng: number;
  // Suggested zoom level matched to the precision of the result —
  // address: 14, place/POI: 12, postal: 11, county-centroid: 9.
  zoom: number;
  // Resolved admin context from Mapbox v6 context object. Used by the
  // Phase 2b address-county sanity check (extractionSanity.ts) to flag
  // comps where the AI-extracted county disagrees with what Mapbox
  // says the address actually sits in. Null when Mapbox didn't return
  // that context key for this address (rare for US street addresses).
  county?: string | null;   // e.g. "Comal" — bare name, no "County" suffix
  city?: string | null;     // locality / place name
  state?: string | null;    // 2-letter, "TX"
};

// US-state bounding boxes (SW lng, SW lat, NE lng, NE lat). When the
// AI-extracted state is known, we pass `bbox=` to Mapbox so it
// PHYSICALLY CAN NOT return a hit outside the state. Without this,
// vague rural descriptions ("approximately 6.8 miles north of
// Hamilton") match the wrong-state homonym — Christina 2026-06-19,
// Hamilton-County-TX appraisal landed at 37.29, -121.94 (San Jose,
// California) because Mapbox saw "Hamilton" and picked the nearest
// match unconstrained. Bbox kills that class of failure outright.
//
// Data: 50 states + DC. Source: US Census Cartographic Boundary Files
// 2020, rounded to 2 decimal places (~1 km precision — plenty for a
// bias hint). PR is invariant rather than data we'd ever need to
// update; keeping it inline rather than a JSON file for the
// zero-dependency, never-stale property.
const STATE_BBOXES: Record<string, [number, number, number, number]> = {
  AL: [-88.47, 30.22, -84.89, 35.01],   AK: [-179.15, 51.21, 179.78, 71.44],
  AZ: [-114.82, 31.33, -109.05, 37.00], AR: [-94.62, 33.00, -89.64, 36.50],
  CA: [-124.41, 32.53, -114.13, 42.01], CO: [-109.06, 36.99, -102.04, 41.00],
  CT: [-73.73, 40.95, -71.79, 42.05],   DE: [-75.79, 38.45, -75.05, 39.84],
  DC: [-77.12, 38.79, -76.91, 38.99],   FL: [-87.63, 24.52, -80.03, 31.00],
  GA: [-85.61, 30.36, -80.84, 35.00],   HI: [-160.24, 18.91, -154.81, 22.24],
  ID: [-117.24, 41.99, -111.04, 49.00], IL: [-91.51, 36.97, -87.50, 42.51],
  IN: [-88.10, 37.77, -84.78, 41.76],   IA: [-96.64, 40.38, -90.14, 43.50],
  KS: [-102.05, 36.99, -94.59, 40.00],  KY: [-89.57, 36.50, -81.96, 39.15],
  LA: [-94.04, 28.93, -88.82, 33.02],   ME: [-71.08, 43.07, -66.95, 47.46],
  MD: [-79.49, 37.91, -75.05, 39.72],   MA: [-73.51, 41.24, -69.93, 42.89],
  MI: [-90.42, 41.70, -82.40, 48.31],   MN: [-97.24, 43.50, -89.49, 49.39],
  MS: [-91.66, 30.17, -88.10, 35.01],   MO: [-95.77, 35.99, -89.10, 40.62],
  MT: [-116.05, 44.36, -104.04, 49.00], NE: [-104.05, 39.99, -95.31, 43.00],
  NV: [-120.01, 35.00, -114.04, 42.00], NH: [-72.56, 42.70, -70.61, 45.31],
  NJ: [-75.56, 38.93, -73.89, 41.36],   NM: [-109.05, 31.33, -103.00, 37.00],
  NY: [-79.76, 40.50, -71.86, 45.02],   NC: [-84.32, 33.84, -75.46, 36.59],
  ND: [-104.05, 45.94, -96.55, 49.00],  OH: [-84.82, 38.40, -80.52, 42.00],
  OK: [-103.00, 33.62, -94.43, 37.00],  OR: [-124.57, 41.99, -116.46, 46.30],
  PA: [-80.52, 39.72, -74.69, 42.27],   RI: [-71.86, 41.15, -71.12, 42.02],
  SC: [-83.35, 32.03, -78.54, 35.22],   SD: [-104.06, 42.48, -96.44, 45.95],
  TN: [-90.31, 34.98, -81.65, 36.68],   TX: [-106.65, 25.84, -93.51, 36.50],
  UT: [-114.05, 36.99, -109.04, 42.00], VT: [-73.44, 42.73, -71.46, 45.02],
  VA: [-83.68, 36.54, -75.24, 39.47],   WA: [-124.76, 45.54, -116.92, 49.00],
  WV: [-82.64, 37.20, -77.72, 40.64],   WI: [-92.89, 42.49, -86.81, 47.31],
  WY: [-111.06, 40.99, -104.05, 45.01],
};

/**
 * Geocode a free-text address to street-level coordinates. Returns null
 * if Mapbox couldn't resolve it or the result isn't precise enough to
 * trust (e.g. fell back to a region).
 *
 * Use this FIRST when a comp has an address — the broker lands near
 * the actual property instead of a county centroid.
 *
 * @param address  The address string to geocode
 * @param state    Optional 2-letter state code from the document (e.g.
 *                 "TX"). When provided, geocode is hard-bounded to that
 *                 state's bbox so vague rural addresses like "north of
 *                 Hamilton" can't pull a wrong-state homonym.
 */
export async function geocodeAddress(address: string, stateHint?: string | null): Promise<GeocodeResult | null> {
  if (!MAPBOX_TOKEN) return null;
  const q = address.trim();
  if (!q || q.length < 4) return null;
  try {
    const stateCode = stateHint ? stateHint.trim().toUpperCase() : null;
    const bbox = stateCode && STATE_BBOXES[stateCode] ? STATE_BBOXES[stateCode] : null;
    const bboxParam = bbox ? `&bbox=${bbox.join(',')}` : '';
    const url =
      `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}` +
      `&access_token=${MAPBOX_TOKEN}&country=us&limit=1${bboxParam}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const f = data?.features?.[0];
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const featureType = f?.properties?.feature_type || f?.place_type?.[0];
    // Acceptable: anything that's NOT region/country/district (those would
    // be a county-centroid-quality match — handled by geocodeCounty below).
    if (featureType && ['region', 'country', 'district'].includes(featureType)) {
      return null;
    }
    const zoomByType: Record<string, number> = {
      address: 14,
      street: 13,
      poi: 13,
      place: 12,
      postcode: 11,
      locality: 11,
    };
    const zoom = featureType ? (zoomByType[featureType] ?? 12) : 12;

    // Mapbox v6 context: an OBJECT keyed by admin level. For US street
    // addresses, `district` is the county. Strip the "County" suffix so
    // it matches the canonical storage format from normalizeCounty.ts.
    const ctx = f?.properties?.context ?? {};
    const rawDistrict = typeof ctx?.district?.name === 'string' ? ctx.district.name : null;
    const county = rawDistrict ? rawDistrict.replace(/\s+County\s*$/i, '').trim() || null : null;
    const city = typeof ctx?.place?.name === 'string'
      ? ctx.place.name
      : (typeof ctx?.locality?.name === 'string' ? ctx.locality.name : null);
    const stateRaw = typeof ctx?.region?.region_code === 'string'
      ? ctx.region.region_code
      : (typeof ctx?.region?.name === 'string' ? ctx.region.name : null);
    const state = stateRaw
      ? (stateRaw.length === 2 ? stateRaw.toUpperCase() : stateRaw)
      : null;

    return { lng: coords[0], lat: coords[1], zoom, county, city, state };
  } catch {
    return null;
  }
}

/**
 * Geocode a "county, state" pair to the county centroid at zoom 9 —
 * the broker won't see the actual property, but at least they're in the
 * right county. From there they can pan/zoom to the right area.
 *
 * Always-works fallback: every comp has a county + state. If both
 * geocodeAddress AND this fail, the map stays at its default viewport
 * (which is fine — broker still has the side panel data).
 */
export async function geocodeCounty(
  county: string,
  state: string
): Promise<GeocodeResult | null> {
  if (!MAPBOX_TOKEN) return null;
  const c = county.trim();
  const s = state.trim();
  if (!c || !s) return null;
  try {
    // Mapbox accepts "Gonzales County, Texas" — be explicit so it doesn't
    // pick a city named "Gonzales" by mistake.
    const q = `${c} County, ${s}`;
    const url =
      `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}` +
      `&access_token=${MAPBOX_TOKEN}&country=us&limit=1&types=district,region`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const f = data?.features?.[0];
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    return { lng: coords[0], lat: coords[1], zoom: 9 };
  } catch {
    return null;
  }
}

/**
 * Best-effort cascade: try address, then county. Returns the first hit
 * or null. Caller uses the returned `zoom` for the flyTo call.
 */
export async function geocodeBestEffort(opts: {
  address?: string | null;
  county?: string | null;
  state?: string | null;
}): Promise<GeocodeResult | null> {
  if (opts.address) {
    const hit = await geocodeAddress(opts.address);
    if (hit) return hit;
  }
  if (opts.county && opts.state) {
    return geocodeCounty(opts.county, opts.state);
  }
  return null;
}

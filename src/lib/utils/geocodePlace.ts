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
};

/**
 * Geocode a free-text address to street-level coordinates. Returns null
 * if Mapbox couldn't resolve it or the result isn't precise enough to
 * trust (e.g. fell back to a region).
 *
 * Use this FIRST when a comp has an address — the broker lands near
 * the actual property instead of a county centroid.
 */
export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  if (!MAPBOX_TOKEN) return null;
  const q = address.trim();
  if (!q || q.length < 4) return null;
  try {
    const url =
      `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}` +
      `&access_token=${MAPBOX_TOKEN}&country=us&limit=1`;
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
    return { lng: coords[0], lat: coords[1], zoom };
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

// Server-safe geocoding helper — uses Mapbox v6 forward geocoding to attach
// lat/lng to comp records that were extracted from documents without coords.
// Falls back through several query forms; returns the comp unchanged if all fail.

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

type Locatable = {
  latitude?: number | null;
  longitude?: number | null;
  address?: string | null;
  county?: string | null;
  state?: string | null;
  property_name?: string | null;
};

export async function geocodeComp<T extends Locatable>(comp: T): Promise<T> {
  if (comp.latitude != null && comp.longitude != null) return comp;
  if (!MAPBOX_TOKEN) return comp;

  const state = comp.state || 'TX';

  // ONLY try queries that have a real address signal. We deliberately do NOT
  // fall back to "County, State" alone — that returns the county centroid,
  // which lands the pin miles from the actual property and creates the
  // illusion that we located it. Better to leave coords null so the broker
  // sees the comp in the "Needs Location" filter and sets it manually via
  // the LocationPicker.
  const queries = [
    comp.address && comp.county ? `${comp.address}, ${comp.county} County, ${state}` : null,
    comp.address ? `${comp.address}, ${state}` : null,
    comp.address ? comp.address : null,
    // Property-name queries can also be too generic ("Wright Farm, Frio
    // County, TX" doesn't pin the right farm) so we keep this one but
    // require BOTH name and county to make it less ambiguous.
    comp.property_name && comp.county ? `${comp.property_name}, ${comp.county} County, ${state}` : null,
  ].filter(Boolean) as string[];

  for (const q of queries) {
    try {
      const url =
        `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}` +
        `&access_token=${MAPBOX_TOKEN}&country=us&limit=1`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      const f = json.features?.[0];
      const coords = f?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      // Reject results that are too coarse — only ACCEPT if Mapbox returns
      // an address-level, POI, or place-level match. County-level results
      // are returned with feature types like "district" or "region" and we
      // skip them.
      const place_type = f?.properties?.feature_type || f?.place_type?.[0];
      const acceptable = ['address', 'poi', 'place', 'street', 'postcode'];
      if (place_type && !acceptable.includes(place_type)) {
        continue;
      }
      const [lng, lat] = coords;
      return { ...comp, latitude: lat, longitude: lng };
    } catch {
      // try next query form
    }
  }
  return comp;
}

export async function geocodeComps<T extends Locatable>(comps: T[]): Promise<T[]> {
  return Promise.all(comps.map(geocodeComp));
}

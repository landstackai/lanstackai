// Reverse-geocode a lat/lng to the nearest city/town name via Mapbox.
//
// Used by the vault to fall back when the comp's address doesn't yield
// a clean city (descriptive appraisal addresses like "East side of CR
// 2875" or "approximately 11 miles NE of Pleasanton" — neither parses
// to a useful city, but the coords pin us to a real geographic point).
//
// Endpoint: Mapbox Geocoding v5, types=place restricts results to the
// place/town/city level (excludes streets, neighborhoods, regions).
// Returns just the place name ("Pearsall") — not the full label
// ("Pearsall, Texas, United States").
//
// Free tier covers 100K requests/month — plenty for this use case
// since results get cached back to comp.city in the DB on first call.

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export async function reverseGeocodeCity(
  lat: number,
  lng: number
): Promise<string | null> {
  if (!MAPBOX_TOKEN) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  try {
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
      `?types=place&limit=1&access_token=${MAPBOX_TOKEN}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const feature = data?.features?.[0];
    // `text` is the bare place name; `place_name` is the full hierarchical
    // label. We want the bare name for the City column.
    return typeof feature?.text === 'string' ? feature.text : null;
  } catch {
    return null;
  }
}

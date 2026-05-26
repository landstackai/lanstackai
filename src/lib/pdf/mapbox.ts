// Mapbox Static Images API helpers for the marketing CMA PDF.
//
// Two URL builders:
//   buildCoverAerial(subject)
//     A close-in satellite image of the subject property — used as
//     the Page 1 cover hero. Prefers the GeoJSON boundary overlay
//     (parcel shape outlined in gold) and falls back to a pin if no
//     boundary is set.
//
//   buildCompMapUrl(subject, comps)
//     A wider satellite image showing the subject (warm-brick pin)
//     and every comp (olive-numbered pins, 1..N matching the row
//     numbers on the Comparable Sales table). Uses Mapbox's `auto`
//     viewport so the framing snaps to fit every pin.
//
// Both return null when:
//   - NEXT_PUBLIC_MAPBOX_TOKEN isn't configured
//   - The relevant coordinates aren't available
//   - The encoded URL would exceed Mapbox's 8KB limit (we silently
//     drop overlays in priority order before giving up)
//
// Returning null is fine — the page components render a graceful
// fallback ("Map unavailable") when the URL is empty.

const MAPBOX_BASE = 'https://api.mapbox.com/styles/v1/mapbox';
const MAX_URL_LENGTH = 8000;

type Subject = {
  latitude: number | null;
  longitude: number | null;
  boundary_geojson: any | null;
};

type CompCoord = {
  latitude: number | null;
  longitude: number | null;
};

/**
 * Cover aerial — close in on the subject. Prefer boundary overlay if
 * available; fall back to a labeled pin.
 */
export function buildCoverAerial(subject: Subject): string | null {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return null;
  if (!Number.isFinite(subject.latitude) || !Number.isFinite(subject.longitude)) return null;

  const lat = subject.latitude as number;
  const lng = subject.longitude as number;

  // Cover hero is wide+short — 1200x700 looks great as a header
  // crop. Retina @2x for sharp print output.
  const W = 1200;
  const H = 700;
  const RETINA = '@2x';

  // Try boundary overlay first
  if (subject.boundary_geojson) {
    const overlay = encodeBoundary(subject.boundary_geojson);
    if (overlay) {
      const url =
        `${MAPBOX_BASE}/satellite-v9/static/` +
        `${overlay}/auto/${W}x${H}${RETINA}?access_token=${token}`;
      if (url.length <= MAX_URL_LENGTH) return url;
      // fall through to pin-only
    }
  }

  // Pin-only fallback at fixed zoom. Zoom 15 = roughly 0.5mi across,
  // which is the right scale for a ranch parcel hero.
  return (
    `${MAPBOX_BASE}/satellite-v9/static/` +
    `pin-l+C8503F(${lng},${lat})/${lng},${lat},14/${W}x${H}${RETINA}?access_token=${token}`
  );
}

/**
 * Annotated comp map — subject + numbered comps, auto-framed to fit
 * every pin. Used on Page 4.
 *
 * Pin colors (hex without #, as Mapbox Static API expects):
 *   Subject: C8503F (warm brick — matches the workspace pin)
 *   Comps:   B68A35 (gold — brand accent, pops on satellite imagery)
 *
 * Why gold for comps: olive (#6B7B3F) was camouflaged against
 * satellite vegetation. Gold provides high contrast against both
 * green vegetation and brown bare ground, and ties into the
 * report's gold accent system so the map feels visually cohesive
 * with the rest of the document.
 *
 * Pin label: comps get their row number (1..9). Mapbox marker labels
 * only support a-z 0-9, so we use the row index. For comp counts
 * >9 we drop the label past 9 (still pin-visible).
 */
export function buildCompMapUrl(subject: Subject, comps: CompCoord[]): string | null {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return null;

  // Collect overlays in priority order — subject first so it draws
  // on top of comps if they overlap visually.
  const overlays: string[] = [];

  // Comps (numbered)
  let compCount = 0;
  comps.forEach((comp, i) => {
    if (Number.isFinite(comp.latitude) && Number.isFinite(comp.longitude)) {
      // Marker label: row number 1-9 fits Mapbox's single-char label.
      // For comp 10+, use a plain pin (still visible, just unlabeled).
      const rowNum = i + 1;
      const label = rowNum <= 9 ? `-${rowNum}` : '';
      overlays.push(`pin-l${label}+B68A35(${comp.longitude},${comp.latitude})`);
      compCount++;
    }
  });

  // Subject (drawn last so it sits on top)
  if (Number.isFinite(subject.latitude) && Number.isFinite(subject.longitude)) {
    overlays.push(`pin-l+C8503F(${subject.longitude},${subject.latitude})`);
  }

  if (overlays.length === 0) return null;

  // Auto-framing if we have multiple pins; fixed zoom if only the
  // subject is mappable (no comps with coords).
  const framing = overlays.length >= 2 ? 'auto' : `${subject.longitude},${subject.latitude},11`;

  const W = 1200;
  const H = 900;
  const RETINA = '@2x';

  // Try with all overlays first
  let url =
    `${MAPBOX_BASE}/satellite-streets-v12/static/` +
    `${overlays.join(',')}/${framing}/${W}x${H}${RETINA}?access_token=${token}`;

  if (url.length <= MAX_URL_LENGTH) return url;

  // URL too long — degrade gracefully by dropping pin labels (the
  // hyphen+label adds a few chars each).
  const stripped = overlays.map((o) => o.replace(/^pin-l-\d/, 'pin-l'));
  url =
    `${MAPBOX_BASE}/satellite-streets-v12/static/` +
    `${stripped.join(',')}/${framing}/${W}x${H}${RETINA}?access_token=${token}`;
  if (url.length <= MAX_URL_LENGTH) return url;

  // Still too long (unlikely at typical comp counts) — give up.
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────

function encodeBoundary(geojson: any): string | null {
  let geometry = geojson;
  if (geojson?.type === 'Feature') geometry = geojson.geometry;
  if (!geometry || typeof geometry !== 'object') return null;
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;

  const feature = {
    type: 'Feature',
    properties: {
      stroke: '#B68A35',
      'stroke-width': 3,
      'stroke-opacity': 0.95,
      fill: '#B68A35',
      'fill-opacity': 0.12,
    },
    geometry,
  };

  const encoded = encodeURIComponent(JSON.stringify(feature));
  return `geojson(${encoded})`;
}

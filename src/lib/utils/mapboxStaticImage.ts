// Build Mapbox Static Images API URLs for verification thumbnails.
//
// V1 keeps this simple: centered satellite image with a marker pin at
// the given coordinates. Polygon boundary overlay is deferred to V2
// (requires encoded-polyline serialization of the parcel geometry).
//
// Cost: ~$0.001 per request. A batch of 10 comps × 2 thumbnails = $0.02.
// Free tier covers 50,000 requests/month — orders of magnitude above
// typical broker usage.

const MAPBOX_BASE = 'https://api.mapbox.com/styles/v1/mapbox';

export type StaticImageOpts = {
  lat: number;
  lng: number;
  /** Map style. Satellite is the most useful for "does this look right". */
  style?: 'satellite-v9' | 'satellite-streets-v12' | 'streets-v12';
  /** Zoom level. 14 = full parcel view for typical TX ranch; 16 = closer. */
  zoom?: number;
  /** Image dimensions in pixels. 300×300 fits the verification card. */
  width?: number;
  height?: number;
  /** Show a marker pin at the coords. Defaults to true. */
  showMarker?: boolean;
  /** Pixel ratio for retina displays. */
  retina?: boolean;
};

/**
 * Returns a fully-qualified Mapbox static image URL for the given
 * coordinates. Returns null if the Mapbox token isn't configured —
 * caller should fall back to a text panel in that case.
 */
export function mapboxStaticUrl(opts: StaticImageOpts): string | null {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return null;
  if (!Number.isFinite(opts.lat) || !Number.isFinite(opts.lng)) return null;

  const style = opts.style || 'satellite-v9';
  const zoom = opts.zoom ?? 14;
  const width = opts.width ?? 300;
  const height = opts.height ?? 300;
  const showMarker = opts.showMarker !== false;
  const suffix = opts.retina ? '@2x' : '';

  // Mapbox URL format:
  // {base}/{style}/static/[overlays]/{lng},{lat},{zoom}/{width}x{height}{@2x}?access_token={token}
  // Overlay format for a labelled marker:
  // pin-l+{color}({lng},{lat})
  const overlay = showMarker
    ? `pin-l+ffd700(${opts.lng},${opts.lat})/`
    : '';

  return (
    `${MAPBOX_BASE}/${style}/static/` +
    `${overlay}${opts.lng},${opts.lat},${zoom}/` +
    `${width}x${height}${suffix}?access_token=${token}`
  );
}

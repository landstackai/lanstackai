// Build Mapbox Static Images API URLs for verification thumbnails.
//
// Two flavors:
//   1. Pin marker centered on (lat, lng) at a fixed zoom — for cases
//      where we have a coordinate but no boundary geometry.
//   2. GeoJSON polygon overlay with auto-fit framing — for cases where
//      autoLocate produced a parcel boundary. Strongly preferred because
//      the broker can see the parcel SHAPE, not just a dot.
//
// Cost: ~$0.001 per request. A batch of 10 comps × 2 thumbnails = $0.02.
// Free tier covers 50,000 requests/month — orders of magnitude above
// typical broker usage.

const MAPBOX_BASE = 'https://api.mapbox.com/styles/v1/mapbox';

// Mapbox URLs have a hard length limit (~16,000 chars). Complex parcel
// boundaries with hundreds of vertices can easily exceed this. We
// simplify the geometry before encoding to stay safely under the limit.
const MAX_URL_LENGTH = 8000;

export type StaticImageOpts = {
  lat: number;
  lng: number;
  /** Map style. Satellite is the most useful for "does this look right". */
  style?: 'satellite-v9' | 'satellite-streets-v12' | 'streets-v12';
  /** Zoom level (ignored when `boundary` is provided — that uses auto-fit). */
  zoom?: number;
  /** Image dimensions in pixels. 300×300 fits the verification card. */
  width?: number;
  height?: number;
  /** Show a marker pin at (lat, lng). Defaults to true when no boundary. */
  showMarker?: boolean;
  /** Pixel ratio for retina displays. */
  retina?: boolean;
  /**
   * Optional GeoJSON geometry (Polygon | MultiPolygon | Feature) to overlay
   * as a yellow outline. When provided, the image auto-fits to the boundary
   * and the marker pin defaults to off. Falls back to pin-only rendering
   * if the boundary serialization exceeds URL length limits.
   */
  boundary?: any;
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
  const suffix = opts.retina ? '@2x' : '';

  // Default: marker pin on by default when no boundary; off by default
  // when boundary is provided (the polygon itself shows the location).
  const showMarker = opts.showMarker ?? !opts.boundary;
  const markerOverlay = showMarker ? `pin-l+ffd700(${opts.lng},${opts.lat})` : '';

  // Try a GeoJSON polygon overlay first when a boundary was provided.
  // If the encoded URL would be too long, drop the overlay and fall back
  // to pin-only — better to show something than nothing.
  if (opts.boundary) {
    const overlay = buildGeoJsonOverlay(opts.boundary);
    if (overlay) {
      const overlays = markerOverlay ? `${overlay},${markerOverlay}` : overlay;
      // `auto` means Mapbox computes the bbox of all overlays and fits the
      // image to it — no need to pre-compute zoom for arbitrary polygon size.
      const url =
        `${MAPBOX_BASE}/${style}/static/` +
        `${overlays}/auto/${width}x${height}${suffix}?access_token=${token}`;
      if (url.length <= MAX_URL_LENGTH) return url;
      // Overlay made the URL too long even after simplification — fall through
      // to pin-only below. The boundary won't show; at least the location will.
    }
  }

  // Pin-only (or no boundary at all): center on (lat, lng) at fixed zoom.
  const overlay = markerOverlay ? `${markerOverlay}/` : '';
  return (
    `${MAPBOX_BASE}/${style}/static/` +
    `${overlay}${opts.lng},${opts.lat},${zoom}/` +
    `${width}x${height}${suffix}?access_token=${token}`
  );
}

/**
 * Wrap a polygon/multipolygon in a styled Feature, simplify it to keep
 * the URL short, and URL-encode for embedding in the Static Images path.
 * Returns null if the geometry isn't a polygon-shaped thing.
 *
 * Mapbox honors the simplestyle-spec when GeoJSON is overlaid via the
 * `geojson(...)` path component:
 *   stroke, stroke-width, stroke-opacity, fill, fill-opacity
 */
function buildGeoJsonOverlay(geomOrFeature: any): string | null {
  let geometry: any = geomOrFeature;
  if (geomOrFeature?.type === 'Feature') geometry = geomOrFeature.geometry;
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
    return null;
  }

  // Simplify coordinates inline. Mapbox URL limit means we can't ship
  // raw TxGIO geometry which often has hundreds of vertices per parcel
  // (and we may have several parcels merged in a cluster). Reduce
  // precision to 5 decimals (~1m at TX latitudes) and skip near-duplicate
  // adjacent points.
  const simplified = simplifyGeometry(geometry, 5, 0.00005);

  const feature = {
    type: 'Feature',
    geometry: simplified,
    properties: {
      stroke: '#ffd700',
      'stroke-width': 2,
      'stroke-opacity': 1,
      fill: '#ffd700',
      'fill-opacity': 0.2,
    },
  };

  try {
    return `geojson(${encodeURIComponent(JSON.stringify(feature))})`;
  } catch {
    return null;
  }
}

/**
 * Reduce coordinate precision and prune near-duplicate adjacent vertices.
 * Lossy but visually indistinguishable at thumbnail resolution.
 *
 * @param geom    Polygon or MultiPolygon GeoJSON geometry
 * @param decimals Decimal places to keep (5 ≈ 1m precision)
 * @param minDelta Minimum lng/lat distance between adjacent points to keep
 */
function simplifyGeometry(geom: any, decimals: number, minDelta: number): any {
  const round = (n: number) => Math.round(n * Math.pow(10, decimals)) / Math.pow(10, decimals);

  const simplifyRing = (ring: number[][]): number[][] => {
    if (!Array.isArray(ring) || ring.length === 0) return ring;
    const out: number[][] = [];
    let last: number[] | null = null;
    for (const pt of ring) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const rounded = [round(pt[0]), round(pt[1])];
      if (
        last &&
        Math.abs(rounded[0] - last[0]) < minDelta &&
        Math.abs(rounded[1] - last[1]) < minDelta
      ) {
        continue;
      }
      out.push(rounded);
      last = rounded;
    }
    // Ensure ring closure (first === last) is preserved
    if (out.length > 0 && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) {
      out.push([out[0][0], out[0][1]]);
    }
    return out;
  };

  if (geom.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: (geom.coordinates || []).map(simplifyRing),
    };
  }
  if (geom.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: (geom.coordinates || []).map((poly: number[][][]) =>
        poly.map(simplifyRing)
      ),
    };
  }
  return geom;
}

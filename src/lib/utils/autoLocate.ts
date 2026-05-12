// Iron-clad auto-locate. Stripped-down version: keeps the parts that actually
// worked (county+acreage, owner-name match, multi-parcel sum, AI vision text+
// aerial signals, cascading intersection geocoding). Drops the speculative
// pieces (visual image matching, approximate-pin fallback).
//
// Cascade (each step only runs if the previous didn't resolve):
//   1. TxGIO county + acreage query (single-parcel match)
//   2. Owner-name disambiguation across candidates
//   3. AI vision: extract search_hint from aerial + description text
//   4. Geocode the hint (with cascade for road intersections)
//   5. Multi-parcel sum match in the geocoded area (handles "100 ac = 2 × 50 ac parcels")
//   6. Spatial single-parcel match as fallback within that area
//
// Returns null when no confident match exists — broker fixes manually via
// the LocationPicker. Never guesses.

// @ts-expect-error — turf v6.5 types not exposed via package "exports"
import * as turf from '@turf/turf';
import { mergeFeatures } from './countyParcels';

const TXGIO_QUERY =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query';

export type AutoLocateResult = {
  latitude: number;
  longitude: number;
  parcel_id: string | null;
  boundary_geojson: any;
  match_confidence: 'high' | 'medium';
  match_reason: string;
};

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function safeCountyName(county: string): string {
  return county.replace(/[^a-zA-Z\s\-]/g, '').trim();
}

function normalizeOwner(s: string): string {
  return s
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(LLC|LTD|INC|TRUSTEE|TRUST|FAMILY|REVOCABLE|LIVING)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ownerMatches(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack || !needle) return false;
  const h = normalizeOwner(haystack);
  const n = normalizeOwner(needle);
  if (!n || !h) return false;
  const tokens = n.split(/\s+/).filter((t) => t.length >= 3);
  if (tokens.length === 0) return false;
  return tokens.every((t) => h.includes(t));
}

function sumAcres(parcels: any[]): number {
  return parcels.reduce((s, p) => s + (Number(p.properties?.gis_area) || 0), 0);
}

function featureToResult(
  feature: any,
  confidence: 'high' | 'medium',
  reason: string
): AutoLocateResult | null {
  if (!feature?.geometry) return null;
  try {
    const centroid = turf.centroid(feature);
    const [lng, lat] = centroid.geometry.coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return {
      latitude: lat,
      longitude: lng,
      parcel_id: feature.properties?.prop_id ? String(feature.properties.prop_id) : null,
      boundary_geojson: feature.geometry,
      match_confidence: confidence,
      match_reason: reason,
    };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// TxGIO queries
// ──────────────────────────────────────────────────────────────────────────

async function queryByCountyAndAcreage(
  county: string,
  minAcres: number,
  maxAcres: number
): Promise<any[]> {
  const safeCounty = safeCountyName(county);
  if (!safeCounty) return [];
  const u = safeCounty.toUpperCase();
  const where = `(UPPER(county) = '${u}' OR UPPER(county) = '${u} COUNTY') AND gis_area BETWEEN ${minAcres} AND ${maxAcres}`;
  const params = new URLSearchParams({
    where,
    outFields: 'prop_id,owner_name,gis_area,county',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '6',
    resultRecordCount: '200',
    f: 'geojson',
  });
  try {
    const res = await fetch(`${TXGIO_QUERY}?${params}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      console.warn(`TxGIO county query failed: ${res.status}`);
      return [];
    }
    const json = await res.json();
    const features = Array.isArray(json?.features) ? json.features : [];
    console.log(`TxGIO: county=${county} acres=${minAcres.toFixed(0)}-${maxAcres.toFixed(0)} → ${features.length}`);
    return features;
  } catch (e: any) {
    console.warn('TxGIO county query threw:', e?.message);
    return [];
  }
}

async function queryBboxAllParcels(
  centerLat: number,
  centerLng: number,
  radiusMiles: number
): Promise<any[]> {
  const dLat = radiusMiles / 69;
  const dLng = radiusMiles / 60;
  const bbox = `${centerLng - dLng},${centerLat - dLat},${centerLng + dLng},${centerLat + dLat}`;
  const params = new URLSearchParams({
    geometry: bbox,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'prop_id,owner_name,gis_area,county',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '6',
    resultRecordCount: '2000',
    f: 'geojson',
  });
  try {
    const res = await fetch(`${TXGIO_QUERY}?${params}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const features = Array.isArray(json?.features) ? json.features : [];
    console.log(`TxGIO: bbox ${radiusMiles}mi → ${features.length} parcels`);
    return features;
  } catch (e: any) {
    console.warn('TxGIO bbox query threw:', e?.message);
    return [];
  }
}

async function queryBboxAndAcreage(
  centerLat: number,
  centerLng: number,
  radiusMiles: number,
  minAcres: number,
  maxAcres: number
): Promise<any[]> {
  const dLat = radiusMiles / 69;
  const dLng = radiusMiles / 60;
  const bbox = `${centerLng - dLng},${centerLat - dLat},${centerLng + dLng},${centerLat + dLat}`;
  const params = new URLSearchParams({
    geometry: bbox,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    where: `gis_area BETWEEN ${minAcres} AND ${maxAcres}`,
    outFields: 'prop_id,owner_name,gis_area,county',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '6',
    resultRecordCount: '200',
    f: 'geojson',
  });
  try {
    const res = await fetch(`${TXGIO_QUERY}?${params}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.features) ? json.features : [];
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Mapbox geocoding with intersection cascade
// ──────────────────────────────────────────────────────────────────────────

async function geocodeSearchHint(hint: string): Promise<{ lat: number; lng: number } | null> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return null;

  // Build cascade for "X and Y, county, state" patterns. Try full, then
  // each road alone.
  const cascade: string[] = [hint];
  const intersection = hint.match(/^(.+?)\s+(?:and|&)\s+(.+?)(,.*)?$/i);
  if (intersection) {
    const [, roadA, roadB, tail] = intersection;
    cascade.push(`${roadA.trim()}${tail || ''}`);
    cascade.push(`${roadB.trim()}${tail || ''}`);
  }

  for (const q of cascade) {
    try {
      const res = await fetch(
        `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}` +
          `&access_token=${token}&country=us&limit=1`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) continue;
      const json = await res.json();
      const f = json?.features?.[0];
      const coords = f?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const place_type = f?.properties?.feature_type || f?.place_type?.[0];
      // Accept address-level results only — reject region/district (county centroid).
      const acceptable = ['address', 'poi', 'place', 'street', 'postcode'];
      if (place_type && !acceptable.includes(place_type)) continue;
      console.log(`geocode: "${q}" → ${coords[1].toFixed(4)},${coords[0].toFixed(4)} (${place_type})`);
      return { lng: coords[0], lat: coords[1] };
    } catch {
      // try next
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────────────────

export type LocatableComp = {
  county?: string | null;
  acres?: number | null;
  grantee?: string | null;
  grantor?: string | null;
  property_name?: string | null;
  description?: string | null;
  address?: string | null;
  aerialImage?: string | null;
};

export async function autoLocateFromMetadata(
  comp: LocatableComp
): Promise<AutoLocateResult | null> {
  const acres = Number(comp.acres);
  if (!Number.isFinite(acres) || acres <= 0) return null;

  // Parse county field — may contain multiple counties ("Frio and Medina").
  const counties = (comp.county || '')
    .split(/\s+and\s+|\s*&\s*|,/i)
    .map((c) => c.replace(/\bcount(y|ies)\b/gi, '').trim())
    .filter(Boolean);

  const minAcres = acres * 0.9;
  const maxAcres = acres * 1.1;
  const ownerSignals = [comp.grantee, comp.grantor, comp.property_name].filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0
  );

  // ── STEP 1: County + acreage single-parcel match ─────────────────────
  let candidates: any[] = [];
  for (const c of counties) {
    candidates.push(...(await queryByCountyAndAcreage(c, minAcres, maxAcres)));
  }
  if (candidates.length === 0 && counties.length > 0) {
    // Wider tolerance
    for (const c of counties) {
      candidates.push(...(await queryByCountyAndAcreage(c, acres * 0.85, acres * 1.15)));
    }
  }

  if (candidates.length === 1) {
    return featureToResult(
      candidates[0],
      'high',
      `Unique parcel at ${candidates[0].properties?.gis_area?.toFixed?.(2) ?? '?'} ac in ${counties.join('/')} County.`
    );
  }

  // ── STEP 2: Owner-name disambiguation across candidates ──────────────
  if (candidates.length > 1) {
    for (const owner of ownerSignals) {
      const matched = candidates.filter((f) => ownerMatches(f.properties?.owner_name, owner));
      if (matched.length === 1) {
        return featureToResult(
          matched[0],
          'high',
          `Matched by owner "${owner}" among ${candidates.length} acreage candidates.`
        );
      }
    }
  }

  // ── STEP 3-5: AI vision search hint → geocode → multi-parcel sum match
  const hasTextSignal = Boolean(comp.description?.trim()) || Boolean(comp.address?.trim());
  if (!comp.aerialImage && !hasTextSignal) return null;

  const { extractLocationSignals } = await import('./aerialAnalysis');
  const signals = await extractLocationSignals(comp.aerialImage ?? null, {
    description: comp.description,
    address: comp.address,
  });
  if (!signals?.search_hint) return null;

  const center = await geocodeSearchHint(signals.search_hint);
  if (!center) return null;

  // ── STEP 5: Multi-parcel sum match in the geocoded area ──────────────
  // Critical for rural land: a "100 ac Wright Farm" might be 2 × 50 ac
  // parcels. Pull ALL parcels in 10mi bbox, group by owner, find the
  // owner whose total acreage matches the appraisal.
  const allParcels = await queryBboxAllParcels(center.lat, center.lng, 10);
  if (allParcels.length > 0) {
    const groups = new Map<string, any[]>();
    for (const p of allParcels) {
      const owner = (p.properties?.owner_name || '').toString();
      const key = normalizeOwner(owner);
      if (!key) continue;
      const list = groups.get(key) || [];
      list.push(p);
      groups.set(key, list);
    }

    for (const ownerSignal of ownerSignals) {
      const normSignal = normalizeOwner(ownerSignal);
      const tokens = normSignal.split(/\s+/).filter((t) => t.length >= 3);
      if (tokens.length === 0) continue;

      const matchedGroups: Array<{ parcels: any[]; totalAcres: number; delta: number }> = [];
      groups.forEach((parcels, ownerKey) => {
        if (tokens.every((t) => ownerKey.includes(t))) {
          const totalAcres = sumAcres(parcels);
          matchedGroups.push({
            parcels,
            totalAcres,
            delta: Math.abs(totalAcres - acres) / acres,
          });
        }
      });

      const inTolerance = matchedGroups
        .filter((g) => g.delta <= 0.10)
        .sort((a, b) => a.delta - b.delta);

      if (inTolerance.length > 0) {
        const best = inTolerance[0];
        const merged = mergeFeatures(best.parcels);
        if (merged) {
          return featureToResult(
            merged,
            best.delta < 0.03 ? 'high' : 'medium',
            `Multi-parcel match: "${ownerSignal}" owns ${best.parcels.length} parcels totaling ` +
              `${best.totalAcres.toFixed(1)} ac near ${signals.search_hint} (target ${acres} ac).`
          );
        }
      }
    }
  }

  // ── STEP 6: Spatial single-parcel match (fallback within the area) ───
  const spatialCandidates = await queryBboxAndAcreage(
    center.lat,
    center.lng,
    10,
    minAcres,
    maxAcres
  );
  if (spatialCandidates.length === 1) {
    return featureToResult(
      spatialCandidates[0],
      'high',
      `Single parcel match near ${signals.search_hint} at ${spatialCandidates[0].properties?.gis_area?.toFixed?.(1)} ac.`
    );
  }
  if (spatialCandidates.length > 1) {
    for (const owner of ownerSignals) {
      const matched = spatialCandidates.filter((f) =>
        ownerMatches(f.properties?.owner_name, owner)
      );
      if (matched.length === 1) {
        return featureToResult(
          matched[0],
          'high',
          `Spatial + owner match: "${owner}" near ${signals.search_hint}.`
        );
      }
    }
  }

  // No confident match — broker fixes via LocationPicker.
  return null;
}

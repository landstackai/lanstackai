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
  // 'low' is used by carve-out detection (Phase 3) when we pin to grantor's
  // parent tract because the actual subdivided parcel isn't recorded yet.
  // Broker still needs to trace the actual boundary.
  match_confidence: 'high' | 'medium' | 'low';
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
  confidence: 'high' | 'medium' | 'low',
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

// Cluster type used by the spatial-clustering helper below.
type ParcelCluster = {
  parcels: any[];
  centroid: [number, number]; // [lng, lat]
  totalAcres: number;
};

// Group parcels into spatial clusters by centroid distance. Parcels whose
// centroids are within ~1mi (0.015°) of an existing cluster's centroid join
// that cluster; otherwise a new cluster is started.
//
// Why this matters: a TX rancher commonly owns multiple unrelated tracts in
// the same county. Lumping them all into one "sum-all" check misses the
// right tract. Clustering separates them so each tract is sized independently.
async function clusterParcelsSpatially(features: any[]): Promise<ParcelCluster[]> {
  if (features.length === 0) return [];
  // @ts-expect-error — turf v6.5 .d.ts not fully exposed
  const turf = (await import('@turf/turf')) as any;

  const MAX_DEGREES = 0.015; // ~1 mile in TX latitudes

  // Pre-compute centroid + acres for each feature
  const items = features.map((f) => {
    let centroid: [number, number] | null = null;
    try {
      const c = turf.centroid(f);
      const coords = c?.geometry?.coordinates;
      if (Array.isArray(coords) && coords.length >= 2) {
        centroid = [coords[0], coords[1]];
      }
    } catch {}
    return {
      feature: f,
      centroid,
      acres: Number(f.properties?.gis_area) || 0,
    };
  }).filter((i) => i.centroid !== null) as Array<{
    feature: any;
    centroid: [number, number];
    acres: number;
  }>;

  const clusters: ParcelCluster[] = [];
  for (const item of items) {
    // Find closest existing cluster within threshold
    let bestCluster: ParcelCluster | null = null;
    let bestDist = Infinity;
    for (const cluster of clusters) {
      const dx = item.centroid[0] - cluster.centroid[0];
      const dy = item.centroid[1] - cluster.centroid[1];
      const d = Math.hypot(dx, dy);
      if (d < bestDist && d <= MAX_DEGREES) {
        bestDist = d;
        bestCluster = cluster;
      }
    }
    if (bestCluster) {
      bestCluster.parcels.push(item.feature);
      bestCluster.totalAcres += item.acres;
      // Running-average centroid update
      const n = bestCluster.parcels.length;
      bestCluster.centroid = [
        (bestCluster.centroid[0] * (n - 1) + item.centroid[0]) / n,
        (bestCluster.centroid[1] * (n - 1) + item.centroid[1]) / n,
      ];
    } else {
      clusters.push({
        parcels: [item.feature],
        centroid: item.centroid,
        totalAcres: item.acres,
      });
    }
  }
  return clusters;
}

// Convert a parcel cluster to a single merged feature for featureToResult.
function clusterToMergedFeature(cluster: ParcelCluster): any {
  if (cluster.parcels.length === 1) return cluster.parcels[0];
  const merged = mergeFeatures(cluster.parcels);
  if (merged) return merged;
  // Fallback: just use the largest parcel
  return cluster.parcels.reduce((a, b) =>
    (Number(a.properties?.gis_area) || 0) > (Number(b.properties?.gis_area) || 0) ? a : b
  );
}

// Pick the best cluster from a set of candidates using landmark proximity.
// Calls aerialAnalysis to extract a search_hint from the comp's description/
// image, geocodes it, then picks the cluster whose centroid is closest.
//
// Returns null if no landmark could be extracted or geocoded — caller should
// fall back to alternate disambiguation.
async function pickClusterByLandmark(
  clusters: ParcelCluster[],
  comp: { aerialImage?: string | null; description?: string | null; address?: string | null }
): Promise<{ cluster: ParcelCluster; distMiles: number } | null> {
  if (clusters.length === 0) return null;
  if (clusters.length === 1) return { cluster: clusters[0], distMiles: 0 };

  const { extractLocationSignals } = await import('./aerialAnalysis');
  const signals = await extractLocationSignals(comp.aerialImage ?? null, {
    description: comp.description,
    address: comp.address,
  });
  if (!signals?.search_hint) return null;

  const center = await geocodeSearchHint(signals.search_hint);
  if (!center) return null;

  // For each cluster, compute haversine distance from cluster centroid to
  // the geocoded landmark. Pick the closest.
  // @ts-expect-error — turf v6.5 .d.ts not fully exposed
  const turf = (await import('@turf/turf')) as any;
  const landmarkPt = turf.point([center.lng, center.lat]);

  let best: { cluster: ParcelCluster; distMiles: number } | null = null;
  for (const cluster of clusters) {
    const clusterPt = turf.point(cluster.centroid);
    try {
      const distMiles = turf.distance(landmarkPt, clusterPt, { units: 'miles' });
      if (!best || distMiles < best.distMiles) {
        best = { cluster, distMiles };
      }
    } catch {}
  }
  return best;
}

// Fetch parcels for a given owner + county set, then return the subset whose
// owner_name contains every normalized token of the search owner. Extracted
// as a helper so Phase 1 and Phase 2 of the strategy can reuse it without
// duplicating fetch/filter code.
async function fetchOwnerParcels(
  base: string,
  owner: string,
  countyParam: string
): Promise<any[]> {
  const normalized = normalizeOwner(owner);
  const tokens = normalized.split(/\s+/).filter((t) => t.length >= 4);
  if (tokens.length === 0) return [];
  const query = tokens.sort((a, b) => b.length - a.length)[0];

  let features: any[] = [];
  try {
    const url = `${base}/api/parcels-by-owner?q=${encodeURIComponent(query)}&county=${encodeURIComponent(countyParam)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(28000) });
    if (!res.ok) return [];
    const data = await res.json();
    features = Array.isArray(data?.features) ? data.features : [];
  } catch {
    return [];
  }

  const allTokens = normalized.split(/\s+/).filter((t) => t.length >= 3);
  return features.filter((f) => {
    const own = (f.properties?.owner_name || '').toString().toUpperCase();
    return allTokens.every((t) => own.includes(t));
  });
}

// Owner-first strategy. Tries each owner signal (grantee → grantor → property_name)
// against TxGIO with a county filter, looking for either (a) a single-parcel
// acreage match or (b) a multi-parcel subset whose summed acreage matches.
//
// Phases:
//   1. Strict (current behavior): single-parcel and sum-all matches within 10%
//      acreage tolerance, plus an existing MEDIUM-confidence vision-verify
//      branch when 1-5 tight matches don't pass strict.
//   2. NEW Relaxed + cluster (A+B): if Phase 1 fails for all owners, cluster
//      each owner's parcels spatially and accept any cluster whose summed
//      acreage is within 50% of target. Disambiguate multiple clusters using
//      landmark proximity from aerialAnalysis + geocoding.
//   3. NEW Carve-out (C): if grantor is set and grantor's largest cluster is
//      ≥2× target acreage with ≤3 clusters total, treat as a carve-out — pin
//      to the grantor's parcel cluster (best one by landmark proximity if
//      multiple). LOW confidence so the broker traces the actual boundary.
//
// Returns null if no confident match was found, allowing the caller to fall
// through to the existing pipeline. MEDIUM matches get a vision sanity-check
// before being returned with 'medium' confidence; HIGH matches skip vision.
async function tryOwnerSearchStrategy(
  comp: {
    aerialImage?: string | null;
    description?: string | null;
    address?: string | null;
    grantor?: string | null;
  },
  acres: number,
  counties: string[],
  ownerSignals: string[]
): Promise<AutoLocateResult | null> {
  if (ownerSignals.length === 0) return null;

  // Build the county query param ("Frio,Medina") for the API
  const countyParam = counties.join(',');
  // Use absolute URL when running on the server side
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

  // Cache tight matches per owner so Phase 2 (relaxed) doesn't refetch.
  const tightMatchesCache: Map<string, any[]> = new Map();

  // ── PHASE 1: Strict tolerance (existing behavior) ────────────────────
  for (const owner of ownerSignals) {
    const tightMatches = await fetchOwnerParcels(base, owner, countyParam);
    if (tightMatches.length === 0) continue;
    tightMatchesCache.set(owner, tightMatches);

    // (a) Single-parcel acreage match
    const singleMatches = tightMatches
      .map((f) => ({
        feature: f,
        gisAcres: Number(f.properties?.gis_area) || 0,
        delta: Math.abs((Number(f.properties?.gis_area) || 0) - acres) / acres,
      }))
      .filter((x) => x.delta <= 0.10)
      .sort((a, b) => a.delta - b.delta);

    if (singleMatches.length > 0) {
      const best = singleMatches[0];
      return featureToResult(
        best.feature,
        best.delta < 0.05 ? 'high' : 'medium',
        `Owner+acreage: "${owner}" owns ${best.gisAcres.toFixed(1)} ac in ${counties.join('/')} County (target ${acres} ac, Δ${(best.delta * 100).toFixed(1)}%).`
      );
    }

    // (b) Multi-parcel subset sum: do all the matched parcels together
    // sum to the target acreage? Common for rural ranches split across
    // 3-10 contiguous parcels under one owner.
    const totalAcres = sumAcres(tightMatches);
    const sumDelta = Math.abs(totalAcres - acres) / acres;
    if (sumDelta <= 0.10) {
      const merged = mergeFeatures(tightMatches);
      if (merged) {
        return featureToResult(
          merged,
          sumDelta < 0.05 ? 'high' : 'medium',
          `Owner+multi-parcel sum: "${owner}" owns ${tightMatches.length} parcels totaling ${totalAcres.toFixed(1)} ac in ${counties.join('/')} County (target ${acres} ac, Δ${(sumDelta * 100).toFixed(1)}%).`
        );
      }
    }

    // (c) MEDIUM confidence: owner matches but acreage is off > 10%.
    // Run vision verification before returning.
    if (tightMatches.length <= 5) {
      const best = tightMatches
        .map((f) => ({
          feature: f,
          delta: Math.abs((Number(f.properties?.gis_area) || 0) - acres) / acres,
        }))
        .sort((a, b) => a.delta - b.delta)[0];

      if (comp.aerialImage) {
        const { verifyParcelMatch } = await import('./aerialAnalysis');
        const verdict = await verifyParcelMatch(comp.aerialImage, {
          county: best.feature.properties?.county,
          acres: Number(best.feature.properties?.gis_area) || 0,
          owner_name: best.feature.properties?.owner_name,
        });
        if (verdict?.matches && verdict.confidence >= 70) {
          return featureToResult(
            best.feature,
            'medium',
            `Owner match + vision-verified: "${owner}" — ${verdict.reason}`
          );
        }
      }
      // No vision, or vision said no → don't return medium yet, let
      // the existing pipeline take a shot.
    }
  }

  // ── PHASE 2 (NEW A+B): Relaxed acreage + spatial clustering ──────────
  // Phase 1 found no strict-tolerance match. For each owner, cluster their
  // parcels spatially and accept any cluster whose summed acreage is within
  // 50% of target — wider than Phase 1's 10% tolerance, because TX appraisal
  // vs CAD acreage routinely diverges by 20-40% (carve-outs, easements, road
  // exclusions). Disambiguate multiple clusters via landmark proximity.
  for (const owner of ownerSignals) {
    const tightMatches = tightMatchesCache.get(owner) || [];
    if (tightMatches.length === 0) continue;

    const clusters = await clusterParcelsSpatially(tightMatches);
    if (clusters.length === 0) continue;

    // Find clusters within ±50% of target
    const relaxedMatches = clusters
      .map((c) => ({ cluster: c, delta: Math.abs(c.totalAcres - acres) / acres }))
      .filter(({ delta }) => delta <= 0.50)
      .sort((a, b) => a.delta - b.delta);

    if (relaxedMatches.length === 0) continue;

    if (relaxedMatches.length === 1) {
      // Single cluster within tolerance — pin to it
      const { cluster, delta } = relaxedMatches[0];
      const merged = clusterToMergedFeature(cluster);
      return featureToResult(
        merged,
        'medium',
        `Owner+relaxed-acreage: "${owner}" cluster of ${cluster.parcels.length} parcels totaling ${cluster.totalAcres.toFixed(1)} ac in ${counties.join('/')} County (target ${acres} ac, Δ${(delta * 100).toFixed(1)}%).`
      );
    }

    // Multiple clusters within tolerance → disambiguate via landmark
    const candidateClusters = relaxedMatches.map((m) => m.cluster);
    const pick = await pickClusterByLandmark(candidateClusters, comp);
    if (pick && pick.distMiles <= 10) {
      const delta = Math.abs(pick.cluster.totalAcres - acres) / acres;
      const merged = clusterToMergedFeature(pick.cluster);
      // HIGH only if BOTH proximity is tight AND acreage delta is small
      const confidence: 'high' | 'medium' = pick.distMiles < 2 && delta < 0.10 ? 'high' : 'medium';
      return featureToResult(
        merged,
        confidence,
        `Owner+landmark: "${owner}" cluster (${pick.cluster.totalAcres.toFixed(1)} ac, target ${acres}, Δ${(delta * 100).toFixed(1)}%) ${pick.distMiles.toFixed(1)}mi from landmark.`
      );
    }

    // Landmark couldn't disambiguate — pick the closest acreage as best guess
    // but only if owner is uniquely-enough identified (≤3 clusters)
    if (clusters.length <= 3) {
      const { cluster, delta } = relaxedMatches[0];
      const merged = clusterToMergedFeature(cluster);
      return featureToResult(
        merged,
        'medium',
        `Owner-unique in county: "${owner}" — picking closest-acreage cluster (${cluster.totalAcres.toFixed(1)} ac, target ${acres}, Δ${(delta * 100).toFixed(1)}%). Verify boundary manually.`
      );
    }
  }

  // ── PHASE 3 (NEW C): Carve-out detection from grantor ────────────────
  // Scenario: "Joe Smith sold 100 of his 1,000 acres". TxGIO still shows
  // Joe owning the full parent tract; the 100 ac carve-out isn't recorded
  // yet. Pin to grantor's parent cluster (best one by landmark if multiple).
  // LOW confidence — broker traces the actual boundary.
  if (comp.grantor) {
    const grantorMatches = tightMatchesCache.get(comp.grantor)
      || await fetchOwnerParcels(base, comp.grantor, countyParam);
    if (grantorMatches.length > 0) {
      const clusters = await clusterParcelsSpatially(grantorMatches);
      // Grantor must be uniquely-enough identifiable in this county.
      // More than 3 clusters = too noisy; we'd be guessing.
      if (clusters.length > 0 && clusters.length <= 3) {
        const largest = clusters.reduce((a, b) => a.totalAcres > b.totalAcres ? a : b);
        // Target must be notably smaller than the largest cluster. If target
        // is ≥50% of the largest cluster, Phase 2 should have caught it.
        // 2× threshold (target < 50% of cluster) catches the real carve-outs.
        if (acres < largest.totalAcres * 0.5) {
          let pickedCluster: ParcelCluster | null = null;
          let pickReason = '';
          if (clusters.length === 1) {
            pickedCluster = clusters[0];
            pickReason = `grantor uniquely owns ${clusters[0].parcels.length} parcels in ${counties.join('/')}`;
          } else {
            const pick = await pickClusterByLandmark(clusters, comp);
            if (pick) {
              pickedCluster = pick.cluster;
              pickReason = `grantor's cluster ${pick.distMiles.toFixed(1)}mi from landmark`;
            } else {
              // Without a landmark we can't safely pick — default to largest
              pickedCluster = largest;
              pickReason = `grantor's largest cluster (no landmark to disambiguate)`;
            }
          }
          if (pickedCluster) {
            const merged = clusterToMergedFeature(pickedCluster);
            return featureToResult(
              merged,
              'low',
              `Likely carve-out from grantor "${comp.grantor}": ${pickReason}. Grantor cluster ${pickedCluster.totalAcres.toFixed(1)} ac, appraisal ${acres} ac — pinning to parent tract. Trace actual boundary manually.`
            );
          }
        }
      }
    }
  }

  return null;
}

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

  // ── STEP 0 (NEW, behind feature flag): Owner-first strategy ──────────
  // Search TxGIO by owner name + county, looking for an acreage match.
  // This is the most direct signal — when the grantee on the appraisal
  // matches what TxGIO has as owner_name, we know we found the right
  // property without needing aerial vision.
  //
  // Gated behind OWNER_SEARCH_FIRST env var so we can disable instantly
  // if it misbehaves. Falls through to the existing pipeline (Steps 1-6)
  // when it can't find a high-confidence match.
  if (process.env.OWNER_SEARCH_FIRST === '1' && counties.length > 0) {
    const ownerMatch = await tryOwnerSearchStrategy(comp, acres, counties, ownerSignals);
    if (ownerMatch) return ownerMatch;
  }

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

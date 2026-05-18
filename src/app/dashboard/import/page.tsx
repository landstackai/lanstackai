'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { ExtractedComp } from '@/types';
import { Upload, Send, FileText, CheckCircle, AlertCircle, Plus, X, AlertTriangle, Clock, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { pdfToImages } from '@/lib/utils/pdfToImages';
import { mapboxStaticUrl } from '@/lib/utils/mapboxStaticImage';

// Browser-side auto-locate: uses our cached /api/parcels-by-owner endpoint
// (which the browser CAN cache, unlike Vercel function-to-self calls).
// Mirrors the server-side autoLocateFromMetadata logic but runs in the
// browser context to get the cache hits the manual search bar gets.
//
// Strategy: query by longest single owner-name token (cache-friendly),
// filter client-side for all tokens, cluster spatially, pick the cluster
// whose summed acreage matches the appraisal within 50%.
//
// Returns { latitude, longitude, parcel_id, geometry, match_reason } or null.
async function autoLocateInBrowser(comp: any, _diag?: AutoLocateDiagCollector): Promise<{
  latitude: number;
  longitude: number;
  parcel_id: string | null;
  geometry: any;
  match_reason: string;
  match_confidence: 'high' | 'medium' | 'low';
} | null> {
  const acres = Number(comp?.acres);
  const county = String(comp?.county || '').trim();
  if (!Number.isFinite(acres) || acres <= 0 || !county) {
    if (_diag) _diag.reject_reason = 'missing_acres_or_county';
    return null;
  }

  const ownerSignals = [comp.grantee, comp.grantor, comp.property_name]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  if (ownerSignals.length === 0) {
    if (_diag) _diag.reject_reason = 'no_owner_signals';
    return null;
  }

  // @ts-expect-error — turf v6.5 .d.ts not exposed
  const turf = await import('@turf/turf') as any;

  // Strip more punctuation than before — apostrophes (curly + straight),
  // hyphens, slashes, ampersands all become spaces. Previously only [.,]
  // were stripped, which broke tokenizing for owners like "Turner Kids'"
  // (apostrophe stayed glued to KIDS') and "Smith-Jones" (hyphen kept).
  const normalize = (s: string) => s.toUpperCase()
    .replace(/[.,'’\-\/&]/g, ' ')
    .replace(/\b(LLC|LTD|INC|TRUSTEE|TRUST|FAMILY|REVOCABLE|LIVING|JR|SR)\b/g, '')
    .replace(/\s+/g, ' ').trim();

  // Stop words to drop from token set (super-common short words that
  // would otherwise match everything in a query).
  const CLIENT_STOP_WORDS = new Set(['THE', 'OF', 'AND', 'ET', 'AL']);

  const tokensFor = (s: string): string[] =>
    normalize(s).split(/\s+/)
      .filter((t) => (t.length >= 3 || /\d/.test(t)) && !CLIENT_STOP_WORDS.has(t));

  // ─────────────────────────────────────────────────────────────────────
  // LAT/LNG-FIRST SEED PATH (new, additive)
  // ─────────────────────────────────────────────────────────────────────
  // When the appraisal printed explicit Geographic Location coordinates
  // (Stouffer-format reports sometimes do), use them as a deterministic
  // seed BEFORE running owner search. Lat/lng is the only direct location
  // signal — every other signal is an inference.
  //
  // Flow:
  //   1. Point-in-polygon TxGIO query at (lat, lng) → seed parcel
  //   2. Use seed's owner_name as the tokens to query the county
  //   3. Apply same tight-filter + adjacency-cluster as the owner-search path
  //   4. Find the cluster CONTAINING the seed parcel
  //   5. CORROBORATE: either the seed's owner_name matches one of the
  //      appraisal owner signals (grantee/grantor/property_name) OR the
  //      cluster total acres matches the appraisal acres within 15%.
  //   6. If corroborated → return early with HIGH (both) or MEDIUM (one).
  //   7. If neither → DROP the seed, fall through to existing owner search.
  //
  // Safety: this path runs ONLY when lat/lng is present. The corroboration
  // guard means a typo'd lat/lng (lands in wrong parcel) gets dropped
  // cleanly and the existing pipeline runs — same as if lat/lng were absent.
  const lat = Number(comp?.latitude);
  const lng = Number(comp?.longitude);
  const hasLatLng = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;

  if (hasLatLng) {
    // Local mutable record we fill in as the lat/lng path runs. Mirrored to
    // _diag.lat_lng_data at the end so TypeScript can narrow the optional
    // _diag without lots of `if (_diag)` guards.
    const lld: NonNullable<AutoLocateDiagCollector['lat_lng_data']> = { tried: true };
    try {
      // Step 1: point-in-polygon via /api/parcel (existing endpoint, cached)
      const seedRes = await fetch(`/api/parcel?lat=${lat}&lng=${lng}`);
      const seedJson = seedRes.ok ? await seedRes.json() : null;
      const seedOwner: string | null = seedJson?.parcel?.owner_name || null;
      const seedParcelId: string | null = seedJson?.parcel?.parcel_id || null;
      lld.seed_found = Boolean(seedOwner && seedParcelId);
      lld.seed_owner = seedOwner;
      lld.seed_parcel_id = seedParcelId;

      if (seedOwner && seedParcelId) {
        // Step 2: use seed's owner tokens to query the full county set
        const seedTokens = tokensFor(seedOwner);
        if (seedTokens.length > 0) {
          const longestSeedToken = [...seedTokens].sort((a, b) => b.length - a.length)[0];
          const url = `/api/parcels-by-owner?q=${encodeURIComponent(longestSeedToken)}&county=${encodeURIComponent(county)}`;
          const res = await fetch(url);
          if (res.ok) {
            const data = await res.json();
            const features: any[] = Array.isArray(data?.features) ? data.features : [];
            // Tight filter on ALL seed-owner tokens
            const tight = features.filter((f: any) => {
              const own = (f.properties?.owner_name || '').toString().toUpperCase();
              return seedTokens.every((t) => own.includes(t));
            });

            if (tight.length > 0) {
              // Step 3: cluster (adjacency or centroid, same as owner path)
              const items = tight.map((f: any) => {
                let centroid: [number, number] | null = null;
                try {
                  const c = turf.centroid(f);
                  const coords = c?.geometry?.coordinates;
                  if (Array.isArray(coords) && coords.length >= 2) centroid = [coords[0], coords[1]];
                } catch {}
                return {
                  feature: f,
                  centroid,
                  acres: Number(f.properties?.gis_area) || 0,
                };
              }).filter((i: any) => i.centroid) as Array<{ feature: any; centroid: [number, number]; acres: number }>;

              const useAdjacency = process.env.NEXT_PUBLIC_ADJACENCY_CLUSTERING === '1';
              let clusters: Array<{ parcels: any[]; centroid: [number, number]; totalAcres: number }> = [];
              if (useAdjacency) {
                const buffered: any[] = items.map((it: any) => {
                  try { return turf.buffer(it.feature, 2, { units: 'meters' }); } catch { return null; }
                });
                const parent: number[] = items.map((_: any, i: number) => i);
                const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
                const union = (i: number, j: number) => {
                  const ri = find(i), rj = find(j);
                  if (ri !== rj) parent[ri] = rj;
                };
                for (let i = 0; i < items.length; i++) {
                  if (!buffered[i]) continue;
                  for (let j = i + 1; j < items.length; j++) {
                    if (!buffered[j]) continue;
                    try { if (turf.booleanIntersects(buffered[i], buffered[j])) union(i, j); } catch {}
                  }
                }
                const groups = new Map<number, any[]>();
                for (let i = 0; i < items.length; i++) {
                  const r = find(i);
                  if (!groups.has(r)) groups.set(r, []);
                  groups.get(r)!.push(items[i]);
                }
                clusters = Array.from(groups.values()).map((groupItems: any[]) => {
                  let sx = 0, sy = 0;
                  for (const it of groupItems) { sx += it.centroid[0]; sy += it.centroid[1]; }
                  return {
                    parcels: groupItems.map((it) => it.feature),
                    centroid: [sx / groupItems.length, sy / groupItems.length] as [number, number],
                    totalAcres: groupItems.reduce((s: number, it: any) => s + it.acres, 0),
                  };
                });
              } else {
                const GRID_DEG = 0.015;
                for (const it of items) {
                  let best: typeof clusters[number] | null = null;
                  let bestDist = Infinity;
                  for (const c of clusters) {
                    const d = Math.hypot(it.centroid[0] - c.centroid[0], it.centroid[1] - c.centroid[1]);
                    if (d < bestDist && d <= GRID_DEG) { bestDist = d; best = c; }
                  }
                  if (best) {
                    best.parcels.push(it.feature);
                    best.totalAcres += it.acres;
                    const n = best.parcels.length;
                    best.centroid = [
                      (best.centroid[0] * (n - 1) + it.centroid[0]) / n,
                      (best.centroid[1] * (n - 1) + it.centroid[1]) / n,
                    ];
                  } else {
                    clusters.push({ parcels: [it.feature], centroid: it.centroid, totalAcres: it.acres });
                  }
                }
              }

              // Recompute cluster acreage from unioned area (handles TxGIO duplicates)
              for (const c of clusters) {
                if (c.parcels.length > 1) {
                  try {
                    let u = c.parcels[0];
                    for (let i = 1; i < c.parcels.length; i++) {
                      try { const next = turf.union(u, c.parcels[i]); if (next) u = next; } catch {}
                    }
                    if (u?.geometry) {
                      const a = turf.area(u) / 4046.8564224;
                      if (Number.isFinite(a) && a > 0) c.totalAcres = a;
                    }
                  } catch {}
                }
              }

              // Step 4: find the cluster containing the seed parcel
              const seedCluster = clusters.find((c) =>
                c.parcels.some((p: any) => String(p.properties?.prop_id || '') === String(seedParcelId))
              );

              if (seedCluster) {
                // Step 5: corroborate
                const ownerCorroborated = ownerSignals.some((sig) => {
                  const sigTokens = tokensFor(sig);
                  if (sigTokens.length === 0) return false;
                  const seedOwnerUpper = seedOwner.toUpperCase();
                  return sigTokens.every((t) => seedOwnerUpper.includes(t));
                });
                const acreDelta = Math.abs(seedCluster.totalAcres - acres) / acres;
                const acresCorroborated = acreDelta <= 0.15;

                lld.cluster_count = clusters.length;
                lld.cluster_acres = seedCluster.totalAcres;
                lld.cluster_parcel_count = seedCluster.parcels.length;
                lld.cluster_delta = acreDelta;
                lld.owner_corroborated = ownerCorroborated;
                lld.acres_corroborated = acresCorroborated;

                if (ownerCorroborated || acresCorroborated) {
                  // Build pin from the seed cluster
                  let merged: any = seedCluster.parcels[0];
                  for (let i = 1; i < seedCluster.parcels.length; i++) {
                    try { const u = turf.union(merged, seedCluster.parcels[i]); if (u) merged = u; } catch {}
                  }
                  let pinCoords = seedCluster.centroid;
                  try {
                    const c = turf.centroid(merged);
                    if (c?.geometry?.coordinates) pinCoords = c.geometry.coordinates;
                  } catch {}

                  const confidence: 'high' | 'medium' =
                    (ownerCorroborated && acresCorroborated) ? 'high' : 'medium';
                  const corrobNote =
                    ownerCorroborated && acresCorroborated ? 'owner+acres corroborated'
                    : ownerCorroborated ? 'owner corroborated, acres Δ' + (acreDelta * 100).toFixed(1) + '%'
                    : 'acres corroborated (Δ' + (acreDelta * 100).toFixed(1) + '%), owner mismatch';

                  if (_diag) {
                    _diag.path_used = 'latlng';
                    _diag.lat_lng_data = lld;
                  }
                  return {
                    latitude: pinCoords[1],
                    longitude: pinCoords[0],
                    parcel_id: seedCluster.parcels.map((p: any) => p.properties?.prop_id).filter(Boolean).join(',') || null,
                    geometry: merged.geometry || merged,
                    match_reason: `Lat/lng seed → "${seedOwner}" cluster of ${seedCluster.parcels.length} parcels (${seedCluster.totalAcres.toFixed(1)}ac, target ${acres}; ${corrobNote}).`,
                    match_confidence: confidence,
                  };
                }
                // Corroboration failed — fall through to owner search
                lld.dropped_reason = 'no_corroboration';
              } else {
                lld.dropped_reason = 'seed_not_in_any_cluster';
              }
            } else {
              lld.dropped_reason = 'no_tight_matches_for_seed_owner';
            }
          } else {
            lld.dropped_reason = 'parcels_by_owner_query_failed';
          }
        } else {
          lld.dropped_reason = 'seed_owner_no_tokens';
        }
      } else {
        lld.dropped_reason = 'no_seed_found_at_latlng';
      }
    } catch (e: any) {
      // Any error → fall through to existing pipeline (no behavior change)
      lld.dropped_reason = `error: ${e?.message || 'unknown'}`;
      console.warn('[autoLocate] lat/lng-first path threw, falling through:', e?.message);
    }
    // Mirror collected lat/lng diagnostics back to the optional _diag so the
    // wrapper sees them in the payload (whether the path succeeded or fell
    // through). When path_used was set to 'latlng' above, this is redundant
    // but harmless; in all other cases this is the only assignment.
    if (_diag) _diag.lat_lng_data = lld;
  }
  // ─────────────────────────────────────────────────────────────────────
  // END LAT/LNG-FIRST. Existing owner-search loop below runs unchanged.
  // ─────────────────────────────────────────────────────────────────────

  for (const owner of ownerSignals) {
    const normalized = normalize(owner);
    // Keep tokens that are ≥3 chars OR contain a digit (so short LLC
    // prefixes like "9L", "4F", "2L" survive — they're very distinctive
    // and the only way to disambiguate from generic words like "FARMS").
    const allTokens = normalized.split(/\s+/)
      .filter((t) => (t.length >= 3 || /\d/.test(t)) && !CLIENT_STOP_WORDS.has(t));
    if (allTokens.length === 0) continue;
    const longest = [...allTokens].sort((a, b) => b.length - a.length)[0];

    // Hit the cached endpoint. Browser fetch DOES hit the edge cache.
    let features: any[] = [];
    try {
      const url = `/api/parcels-by-owner?q=${encodeURIComponent(longest)}&county=${encodeURIComponent(county)}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      features = Array.isArray(data?.features) ? data.features : [];
    } catch {
      continue;
    }

    // Filter to records that contain every owner token
    const tight = features.filter((f: any) => {
      const own = (f.properties?.owner_name || '').toString().toUpperCase();
      return allTokens.every((t) => own.includes(t));
    });
    console.log(`[client-autoLocate] "${owner}" → ${features.length} raw, ${tight.length} tight`);

    // Per-signal diagnostic capture — useful for analyzing which owner
    // signals (grantee vs grantor vs property_name) tend to find vs fail.
    if (_diag) {
      _diag.owner_search_data = _diag.owner_search_data || [];
      _diag.owner_search_data.push({
        signal: owner,
        tokens: allTokens,
        raw_count: features.length,
        tight_count: tight.length,
      });
    }

    if (tight.length === 0) continue;

    // Cluster by centroid distance (~1mi threshold)
    const GRID_DEG = 0.015;
    const items = tight.map((f: any) => {
      let centroid: [number, number] | null = null;
      try {
        const c = turf.centroid(f);
        const coords = c?.geometry?.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) centroid = [coords[0], coords[1]];
      } catch {}
      return {
        feature: f,
        centroid,
        acres: Number(f.properties?.gis_area) || 0,
      };
    }).filter((i: any) => i.centroid) as Array<{ feature: any; centroid: [number, number]; acres: number }>;

    // FLAG: NEXT_PUBLIC_ADJACENCY_CLUSTERING=1 → use geometric edge-adjacency
    // (2m buffer + intersection check) instead of centroid distance.
    const useAdjacency = process.env.NEXT_PUBLIC_ADJACENCY_CLUSTERING === '1';
    let clusters: Array<{ parcels: any[]; centroid: [number, number]; totalAcres: number }> = [];

    if (useAdjacency) {
      // Buffer each parcel by 2m then connect via union-find on
      // boolean intersection of the buffered polygons.
      const buffered: any[] = items.map((it: any) => {
        try { return turf.buffer(it.feature, 2, { units: 'meters' }); } catch { return null; }
      });
      const parent: number[] = items.map((_: any, i: number) => i);
      const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
      const union = (i: number, j: number) => {
        const ri = find(i), rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      };
      for (let i = 0; i < items.length; i++) {
        if (!buffered[i]) continue;
        for (let j = i + 1; j < items.length; j++) {
          if (!buffered[j]) continue;
          try { if (turf.booleanIntersects(buffered[i], buffered[j])) union(i, j); } catch {}
        }
      }
      const groups = new Map<number, any[]>();
      for (let i = 0; i < items.length; i++) {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r)!.push(items[i]);
      }
      clusters = Array.from(groups.values()).map((groupItems: any[]) => {
        let sx = 0, sy = 0;
        for (const it of groupItems) { sx += it.centroid[0]; sy += it.centroid[1]; }
        return {
          parcels: groupItems.map((it) => it.feature),
          centroid: [sx / groupItems.length, sy / groupItems.length] as [number, number],
          totalAcres: groupItems.reduce((s: number, it: any) => s + it.acres, 0),
        };
      });
    } else {
      // Centroid clustering (current default behavior)
      for (const it of items) {
        let best: typeof clusters[number] | null = null;
        let bestDist = Infinity;
        for (const c of clusters) {
          const d = Math.hypot(it.centroid[0] - c.centroid[0], it.centroid[1] - c.centroid[1]);
          if (d < bestDist && d <= GRID_DEG) { bestDist = d; best = c; }
        }
        if (best) {
          best.parcels.push(it.feature);
          best.totalAcres += it.acres;
          const n = best.parcels.length;
          best.centroid = [
            (best.centroid[0] * (n - 1) + it.centroid[0]) / n,
            (best.centroid[1] * (n - 1) + it.centroid[1]) / n,
          ];
        } else {
          clusters.push({ parcels: [it.feature], centroid: it.centroid, totalAcres: it.acres });
        }
      }
    }

    // Recompute cluster acreage from unioned area (handles TxGIO duplicates)
    for (const c of clusters) {
      if (c.parcels.length > 1) {
        try {
          let u = c.parcels[0];
          for (let i = 1; i < c.parcels.length; i++) {
            try { const next = turf.union(u, c.parcels[i]); if (next) u = next; } catch {}
          }
          if (u?.geometry) {
            const a = turf.area(u) / 4046.8564224;
            if (Number.isFinite(a) && a > 0) c.totalAcres = a;
          }
        } catch {}
      }
    }

    console.log(`[client-autoLocate] clusters:`, clusters.map(c => `${c.totalAcres.toFixed(1)}ac(${c.parcels.length}p)`).join(', '));

    // Find cluster within 50% acreage tolerance, closest delta wins
    const matched = clusters
      .map((c) => ({ c, delta: Math.abs(c.totalAcres - acres) / acres }))
      .filter(({ delta }) => delta <= 0.50)
      .sort((a, b) => a.delta - b.delta);

    if (matched.length === 0) continue;

    const winner = matched[0];
    let merged: any = winner.c.parcels[0];
    for (let i = 1; i < winner.c.parcels.length; i++) {
      try { const u = turf.union(merged, winner.c.parcels[i]); if (u) merged = u; } catch {}
    }

    // Use turf centroid for the pin (more accurate than running average)
    let pinCoords = winner.c.centroid;
    try {
      const c = turf.centroid(merged);
      if (c?.geometry?.coordinates) pinCoords = c.geometry.coordinates;
    } catch {}

    // Capture winning cluster details for diagnostics — useful for
    // "which cluster size wins most often" and "how often does the
    // winning cluster have multiple alternatives within tolerance"
    // type queries.
    if (_diag) {
      _diag.cluster_data = {
        cluster_count: clusters.length,
        picked_parcel_count: winner.c.parcels.length,
        picked_acres: winner.c.totalAcres,
        picked_delta: winner.delta,
        winning_signal: owner,
        alternatives_within_tolerance: matched.length,
      };
      _diag.path_used = 'owner';
    }

    return {
      latitude: pinCoords[1],
      longitude: pinCoords[0],
      parcel_id: winner.c.parcels.map((p: any) => p.properties?.prop_id).filter(Boolean).join(',') || null,
      geometry: merged.geometry || merged,
      match_reason: `Owner "${owner}" → ${winner.c.parcels.length} parcels, ${winner.c.totalAcres.toFixed(1)}ac (target ${acres}, Δ${(winner.delta * 100).toFixed(1)}%)`,
      match_confidence: winner.delta < 0.10 ? 'high' : 'medium',
    };
  }

  return null;
}

// Type for the optional diagnostic collector that autoLocateInBrowser fills
// in as it runs. The wrapper below builds it up + POSTs to the diagnostic
// endpoint at the end of each call.
type AutoLocateDiagCollector = {
  reject_reason?: string;
  // Which path produced the returned result, if any. Set by the function
  // when it commits to a pin. The wrapper uses this to compute exit_stage.
  path_used?: 'latlng' | 'owner';
  // Captures what happened in the lat/lng-first seed path (only set when
  // the appraisal had explicit lat/lng coordinates and we attempted it).
  lat_lng_data?: {
    tried: boolean;
    seed_found?: boolean;
    seed_owner?: string | null;
    seed_parcel_id?: string | null;
    cluster_count?: number;
    cluster_acres?: number;
    cluster_parcel_count?: number;
    cluster_delta?: number;
    owner_corroborated?: boolean;
    acres_corroborated?: boolean;
    dropped_reason?: string;
  };
  owner_search_data?: Array<{
    signal: string;
    tokens: string[];
    raw_count: number;
    tight_count: number;
  }>;
  cluster_data?: {
    cluster_count: number;
    picked_parcel_count: number;
    picked_acres: number;
    picked_delta: number;
    winning_signal: string;
    alternatives_within_tolerance: number;
  };
};

// Wrapper around autoLocateInBrowser that captures input + per-stage data
// + outcome and POSTs a diagnostic row (fire-and-forget). Use this from
// import flows instead of calling autoLocateInBrowser directly.
//
// Hard rule: this function NEVER throws and NEVER blocks. Even if the
// diagnostic POST fails or the wrapped call throws, the user-facing
// pipeline gets back whatever autoLocateInBrowser would have returned
// (or null on error). Observability is invisible to the user.
async function autoLocateInBrowserLogged(comp: any) {
  const diag: AutoLocateDiagCollector = {};
  const startMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let result: Awaited<ReturnType<typeof autoLocateInBrowser>> = null;
  let threw = false;
  try {
    result = await autoLocateInBrowser(comp, diag);
  } catch (e: any) {
    threw = true;
    console.warn('[autoLocate] threw:', e?.message);
  }
  const ms_total = Math.round(
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startMs
  );

  // Decide exit_stage. Order matters — error trumps everything else.
  // path_used distinguishes lat/lng-first wins from owner-search wins
  // so we can analyze "how often does lat/lng-first actually pay off?"
  let exit_stage: string;
  if (threw) {
    exit_stage = 'error';
  } else if (result) {
    exit_stage = diag.path_used === 'latlng' ? 'latlng_seed_cluster' : 'owner_search_cluster';
  } else if (diag.reject_reason) {
    exit_stage = 'manual_placeholder';
  } else if (diag.lat_lng_data?.tried) {
    // Lat/lng path was attempted but didn't corroborate, and then owner
    // search also failed. Distinct stage so analysis can show "how often
    // did lat/lng get dropped AND owner-search also returned nothing?"
    exit_stage = 'latlng_dropped_owner_null';
  } else {
    exit_stage = 'owner_search_null';
  }

  // Pick final_cluster_acres from whichever path produced the result.
  const finalClusterAcres =
    diag.path_used === 'latlng'
      ? (diag.lat_lng_data?.cluster_acres ?? null)
      : (diag.cluster_data?.picked_acres ?? null);

  // Stash lat_lng_data inside cluster_data (JSONB) under a nested key so we
  // don't need a schema migration. Queries can extract via
  //   cluster_data->'lat_lng_path'->>'owner_corroborated' etc.
  const cluster_data_to_send: any = {
    ...(diag.cluster_data || {}),
    ...(diag.lat_lng_data ? { lat_lng_path: diag.lat_lng_data } : {}),
  };

  const payload = {
    input_acres: Number(comp?.acres) || null,
    input_sale_price: Number(comp?.sale_price) || null,
    input_ppa: Number(comp?.price_per_acre) || null,
    input_grantee: comp?.grantee || null,
    input_grantor: comp?.grantor || null,
    input_property_name: comp?.property_name || null,
    input_county: comp?.county || null,
    input_lat: typeof comp?.latitude === 'number' ? comp.latitude : null,
    input_lng: typeof comp?.longitude === 'number' ? comp.longitude : null,
    input_has_aerial: Boolean(comp?.aerialImage),
    input_has_description: Boolean(
      typeof comp?.description === 'string' && comp.description.trim().length > 0
    ),
    exit_stage,
    // owner_search_data is captured even when lat/lng path won (when lat/lng
    // fell through and then owner search ran, both paths' data is useful).
    owner_search_data: diag.owner_search_data || null,
    cluster_data: Object.keys(cluster_data_to_send).length > 0 ? cluster_data_to_send : null,
    final_pin_lat: result?.latitude ?? null,
    final_pin_lng: result?.longitude ?? null,
    final_parcel_ids: result?.parcel_id
      ? String(result.parcel_id).split(',').filter(Boolean)
      : null,
    final_cluster_acres: finalClusterAcres,
    final_confidence: result?.match_confidence ?? null,
    final_match_reason: result?.match_reason ?? null,
    ms_total,
  };

  // Fire-and-forget. NEVER await, NEVER throw upward.
  try {
    void fetch('/api/diagnostics/autolocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true, // survives the page-navigation race
    }).catch(() => { /* swallow */ });
  } catch {
    // Even constructing the fetch shouldn't be able to throw, but be defensive
  }

  return result;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  comps?: ExtractedComp[];
  timestamp: string;
}

export default function ImportPage() {
  const [messages, setMessages] = useState<Message[]>([{
    role: 'assistant',
    content: "Hi! I'm ready to help you import comps. Upload a PDF, paste text from an appraisal or closing statement, or share a property description. I'll extract the comparable sales data automatically.",
    timestamp: new Date().toISOString(),
  }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingComps, setPendingComps] = useState<ExtractedComp[]>([]);
  // Drag-and-drop state. Counter handles nested drag enter/leave events
  // (which fire for every child element the cursor crosses).
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const isDocumentPaste = (text: string): boolean => {
    if (text.length < 150) return false;
    const patterns = [
      /sale price/i, /acres/i, /county/i, /grantor/i, /grantee/i,
      /recording number/i, /price per acre/i, /land sale/i,
      /property identification/i, /transaction data/i, /sale date/i,
    ];
    return patterns.filter(p => p.test(text)).length >= 3;
  };

  const sendMessage = async (
    text: string,
    fileContent?: string,
    images?: string[]
  ) => {
    const userMessage: Message = {
      role: 'user',
      content: fileContent || images?.length ? `[Document uploaded]\n${text}` : text,
      timestamp: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('/api/import-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMessage].map(m => ({
            role: m.role,
            content: m.content,
          })),
          documentContent: fileContent || (isDocumentPaste(text) ? text : undefined),
          images,
        }),
      });

      const data = await response.json();

      // Attach the page-1 aerial to the extracted comp so the verification
      // card can show it on the LEFT side (vs. the matched parcel on the
      // RIGHT). For single-comp PDFs (the common Stouffer "Farm Sale" format
      // pattern) page 1 IS the aerial of the subject property. For multi-
      // comp PDFs we can't reliably attribute one image to one comp without
      // per-page AI extraction, so we leave aerialImage null and the card
      // falls back to the text panel. Conservative on purpose — better to
      // show no aerial than the WRONG aerial.
      if (Array.isArray(data.comps) && data.comps.length === 1 && Array.isArray(images) && images.length > 0) {
        (data.comps[0] as any).aerialImage = images[0];
      }

      // Browser-side auto-locate: server-side auto-locate fails inside Vercel
      // functions because function-to-self URL calls don't hit the edge cache.
      // Re-run from the browser where /api/parcels-by-owner cache hits work.
      //
      // SKIP when the AI already extracted explicit coords (from a "Geographic
      // Location" field in the doc). Those are authoritative — running browser
      // auto-locate on top could replace them with a less-precise match.
      if (Array.isArray(data.comps)) {
        for (let i = 0; i < data.comps.length; i++) {
          const c = data.comps[i];
          const label = c.property_name || c.county || 'comp';
          if (c.latitude != null && c.longitude != null) {
            console.log(`[import] ${label}: using AI-extracted coords (${c.latitude}, ${c.longitude}) — skipping browser auto-locate`);
            continue;
          }
          try {
            const located = await autoLocateInBrowserLogged(c);
            if (located) {
              console.log(`[import] auto-locate ✓ ${label}: ${located.match_reason}`);
              toast.success(`📍 ${label}: ${located.match_reason}`, { duration: 8000 });
              data.comps[i] = {
                ...c,
                latitude: located.latitude,
                longitude: located.longitude,
                parcel_id: located.parcel_id ?? c.parcel_id,
                geometry: located.geometry,
                _auto_located_confidence: located.match_confidence,
              };
            } else {
              console.log(`[import] auto-locate ✗ ${label} returned null — using server coords (${c.latitude}, ${c.longitude})`);
              toast(
                `📍 ${label}: auto-locate found no match — using AI's coords (${c.latitude?.toFixed?.(4) ?? '?'}, ${c.longitude?.toFixed?.(4) ?? '?'})`,
                { duration: 8000, icon: 'ℹ️' }
              );
            }
          } catch (e: any) {
            console.error(`[import] auto-locate threw for ${label}:`, e);
            toast.error(`📍 ${label}: auto-locate error — ${e?.message || 'unknown'}`, { duration: 8000 });
          }
        }
      }

      const assistantMessage: Message = {
        role: 'assistant',
        content: data.message,
        comps: data.comps,
        timestamp: new Date().toISOString(),
      };

      setMessages(prev => [...prev, assistantMessage]);

      if (data.comps && data.comps.length > 0) {
        setPendingComps(prev => [...prev, ...data.comps]);
      }
    } catch (error) {
      toast.error('Failed to process message');
    } finally {
      setLoading(false);
    }
  };

  // === BATCH UPLOAD PATH (>1 file) ============================================
  // Each file is extracted in ISOLATION — no prior chat history attached to
  // the vision API call. This prevents the token-bloat / context-confusion
  // bug where later files in a batch get processed against the cumulative
  // chat context of earlier files.
  //
  // Successful extractions auto-save to the Vault. The user sees ONE summary
  // toast at the end with a Vault link — no per-comp clicking required.
  // ============================================================================

  // Render a file → images. PDFs go through pdfToImages, image files become
  // a single-entry data-URL array.
  const fileToImages = async (file: File): Promise<string[]> => {
    if (file.type === 'application/pdf') {
      return await pdfToImages(file, { scale: 1.0, maxPages: 15 });
    }
    if (file.type.startsWith('image/')) {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      return [dataUrl];
    }
    return [];
  };

  // Per-file outcome — used to build a persistent log in the chat after
  // the batch completes so the user (and I) can see exactly what happened.
  type ExtractOutcome =
    | { kind: 'ok'; comps: ExtractedComp[] }
    | { kind: 'no_comps'; aiMessage?: string; rawExtracted?: number; filteredOut?: number }
    | { kind: 'http_error'; status: number; statusText: string }
    | { kind: 'network_error'; message: string }
    | { kind: 'render_failed'; message: string };

  // ISOLATED extraction call. Two retry mechanisms:
  //  1. Transient errors (429, 5xx) → exponential backoff, up to 3 attempts
  //  2. Empty `comps: []` result → retry ONCE with a "look harder" prompt
  //     telling the AI this is definitely a comp record even if it only
  //     contains one property. Catches the AI's tendency to be over-cautious.
  const extractCompsFromFile = async (
    file: File,
    attempt: number = 1,
    retryAggressive: boolean = false
  ): Promise<ExtractOutcome> => {
    let images: string[] = [];
    try {
      images = await fileToImages(file);
    } catch (e: any) {
      return { kind: 'render_failed', message: e?.message || 'render error' };
    }
    if (images.length === 0) {
      return { kind: 'render_failed', message: 'no pages rendered' };
    }

    const aggressivePreamble = retryAggressive
      ? `IMPORTANT: My first attempt to extract this document returned no comps. ` +
        `Look again — this is almost certainly a Type A single-property sale ` +
        `record. If you can find ANY combination of Sale Price, Sale Date, ` +
        `Grantor, Grantee, or Recording Number anywhere in the document, ` +
        `extract that property as a comp. Set is_comparable=true. Only return ` +
        `comps:[] if this is clearly a marketing flyer or has no sale data at all.\n\n`
      : '';

    try {
      const response = await fetch('/api/import-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: `${aggressivePreamble}[Document uploaded] Uploaded: ${file.name}`,
            },
          ],
          images,
        }),
      });
      // Retry transient errors with backoff.
      if (!response.ok) {
        const transient = response.status === 429 || response.status >= 500;
        if (transient && attempt < 3) {
          const delay = attempt * 2500;
          await new Promise((r) => setTimeout(r, delay));
          return extractCompsFromFile(file, attempt + 1, retryAggressive);
        }
        return { kind: 'http_error', status: response.status, statusText: response.statusText };
      }
      const data = await response.json();
      const comps: ExtractedComp[] = Array.isArray(data?.comps) ? data.comps : [];
      if (comps.length === 0) {
        if (!retryAggressive) {
          return extractCompsFromFile(file, 1, true);
        }
        return {
          kind: 'no_comps',
          aiMessage: data?.message,
          rawExtracted: data?.diagnostic?.raw_extracted,
          filteredOut: data?.diagnostic?.filtered_out,
        };
      }

      // Browser-side auto-locate — server-side fails inside Vercel functions
      // because function-to-self URLs don't hit the edge cache. Re-run from
      // here where /api/parcels-by-owner cache hits work.
      for (let i = 0; i < comps.length; i++) {
        const located = await autoLocateInBrowserLogged(comps[i]);
        if (located) {
          console.log(`[batch] auto-located ${comps[i].property_name || comps[i].county}: ${located.match_reason}`);
          comps[i] = {
            ...comps[i],
            latitude: located.latitude,
            longitude: located.longitude,
            parcel_id: located.parcel_id ?? comps[i].parcel_id,
            geometry: located.geometry,
            _auto_located_confidence: located.match_confidence,
          } as ExtractedComp;
        }
      }

      return { kind: 'ok', comps };
    } catch (e: any) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 2500));
        return extractCompsFromFile(file, attempt + 1, retryAggressive);
      }
      return { kind: 'network_error', message: e?.message || 'fetch failed' };
    }
  };

  // Self-healing insert. If the DB schema is behind the app (e.g. a new
  // column hasn't been migrated yet), Supabase returns
  // "Could not find the 'X' column of 'comps' in the schema cache". We parse
  // that, drop the offending field from the payload, and retry. The comp
  // still saves with whatever columns DO exist — the only cost is the new
  // metadata not landing for now. Eliminates the "must run migrations
  // before importing" failure mode.
  const insertCompResilient = async (
    payload: Record<string, any>,
    maxRetries: number = 8
  ): Promise<{ data: { id: string } | null; error: any }> => {
    let current = { ...payload };
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const { data, error } = await supabase
        .from('comps')
        .insert(current)
        .select('id')
        .maybeSingle();
      if (!error) return { data, error: null };
      // Look for the column-not-found pattern from PostgREST.
      const msg = String(error.message || '');
      const m = msg.match(/Could not find the '([\w_]+)' column/);
      if (!m) return { data: null, error };
      const missingCol = m[1];
      if (!(missingCol in current)) return { data: null, error };
      delete current[missingCol];
      console.warn(`saveCompSilent: schema missing '${missingCol}' — retrying without it`);
    }
    return { data: null, error: new Error('Insert exhausted retries after schema mismatches') };
  };

  // Silent insert — same fields as saveComp() but no toast and returns a
  // boolean for the batch summary to count successes. Also writes a row to
  // import_exemplars so we have data for the learning loop (path B).
  const saveCompSilent = async (comp: ExtractedComp): Promise<boolean> => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const conf =
      comp.confidence?.overall > 80 ? 'Verified'
      : comp.confidence?.overall > 50 ? 'Estimated'
      : 'Unverified';
    const { data: inserted, error } = await insertCompResilient({
      created_by: user.id,
      property_name: comp.property_name,
      county: comp.county || '',
      state: comp.state || 'TX',
      acres: comp.acres || 0,
      sale_price: comp.sale_price || 0,
      improvements_value: (comp as any).improvements_value,
      sale_date: (comp as any).sale_date,
      address: (comp as any).address,
      latitude: (comp as any).latitude,
      longitude: (comp as any).longitude,
      parcel_id: (comp as any).parcel_id,
      recording_number: (comp as any).recording_number,
      grantor: (comp as any).grantor,
      grantee: (comp as any).grantee,
      financing: (comp as any).financing,
      minerals_sold: (comp as any).minerals_sold,
      confirmation_source: (comp as any).confirmation_source,
      description: (comp as any).description,
      water: (comp as any).water || 'None',
      road_frontage: (comp as any).road_frontage || 'None',
      has_improvements: (comp as any).has_improvements || false,
      improvements_notes: (comp as any).improvements_notes,
      has_water_rights: (comp as any).has_water_rights ?? null,
      irrigation: (comp as any).irrigation ?? null,
      flood_plain: (comp as any).flood_plain ?? null,
      status: 'Sold',
      visibility: 'team',
      confidence: conf,
      boundary_geojson: (comp as any).geometry ?? null,
      // Math identity gate flag from extraction (see /api/import-chat).
      needs_extraction_review: comp.needs_extraction_review || false,
      // Silent (batched/chunked) inserts skip the visual verification screen,
      // so always flag for review — broker can come back via the vault and
      // confirm or fix each one. Manual saves from the verification card
      // (saveComp) decide this per-row based on broker action.
      needs_location_review: true,
    });

    if (error || !inserted) return false;

    // === LEARNING LOOP — write an exemplar for this comp ==================
    // Captures what AI extracted, what auto-locate did, what the broker
    // ultimately accepted. Best-effort: if the import_exemplars table
    // doesn't exist yet (migration 016 not run), this silently no-ops.
    // ======================================================================
    try {
      const { error: exemplarError } = await supabase.from('import_exemplars').insert({
        comp_id: inserted.id,
        created_by: user.id,
        description: (comp as any).description ?? null,
        address: (comp as any).address ?? null,
        county: comp.county || null,
        state: comp.state || 'TX',
        acres: comp.acres ?? null,
        grantor: (comp as any).grantor ?? null,
        grantee: (comp as any).grantee ?? null,
        ai_auto_located: (comp as any).latitude != null && (comp as any).longitude != null,
        ai_match_confidence: (comp as any)._auto_located_confidence ?? null,
        ai_match_reason: (comp as any)._auto_located ?? null,
        final_lat: (comp as any).latitude ?? null,
        final_lng: (comp as any).longitude ?? null,
        was_manually_fixed: false,
      });
      if (exemplarError) {
        // Silently ignore — table likely doesn't exist (migration not run yet).
        // Comp itself saved successfully which is what matters.
      }
    } catch {
      // Swallow — exemplar tracking is purely opportunistic.
    }
    return true;
  };

  // Batch entrypoint. Single file → chat-based path (existing UX with
  // per-comp review). Multiple files → isolated extraction + auto-save.
  const handleMultipleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (files.length === 1) {
      await handleFileUpload(files[0]);
      return;
    }

    const toastId = 'batch-upload';
    let savedCount = 0;
    const outcomes: Array<{ file: string; outcome: ExtractOutcome }> = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      toast.loading(
        `Processing ${i + 1} of ${files.length}: ${file.name}`,
        { id: toastId }
      );
      const outcome = await extractCompsFromFile(file);
      outcomes.push({ file: file.name, outcome });
      if (outcome.kind === 'ok') {
        for (const comp of outcome.comps) {
          const ok = await saveCompSilent(comp);
          if (ok) savedCount++;
        }
      }
    }

    toast.dismiss(toastId);

    // Build a persistent, scrollable log in the chat so the user (and I) can
    // see exactly what happened to each file. Toasts disappear; chat doesn't.
    const failedCount = outcomes.filter((o) => o.outcome.kind !== 'ok').length;
    const lines = outcomes.map(({ file, outcome }) => {
      switch (outcome.kind) {
        case 'ok':
          return `✓ ${file} — saved ${outcome.comps.length} comp${outcome.comps.length === 1 ? '' : 's'}`;
        case 'no_comps': {
          const filterNote =
            outcome.rawExtracted && outcome.rawExtracted > 0
              ? ` [AI extracted ${outcome.rawExtracted}, all filtered out — likely tagged as subject_property]`
              : '';
          const aiNote = outcome.aiMessage ? ` (AI: "${outcome.aiMessage.slice(0, 120)}")` : '';
          return `⚠ ${file} — extraction returned no comps${filterNote}${aiNote}`;
        }
        case 'http_error':
          return `✗ ${file} — server error (HTTP ${outcome.status} ${outcome.statusText})`;
        case 'network_error':
          return `✗ ${file} — network error: ${outcome.message}`;
        case 'render_failed':
          return `✗ ${file} — could not render PDF (${outcome.message})`;
      }
    });
    const summary = `**Batch import complete — ${savedCount} comp${savedCount === 1 ? '' : 's'} saved, ${failedCount} issue${failedCount === 1 ? '' : 's'}.**\n\n${lines.join('\n')}`;

    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content: summary,
        timestamp: new Date().toISOString(),
      },
    ]);

    if (savedCount > 0) {
      toast.success(
        (t) => (
          <span>
            Imported <b>{savedCount}</b> comp{savedCount === 1 ? '' : 's'}
            {failedCount > 0 && <span className="text-amber-300"> ({failedCount} issue{failedCount === 1 ? '' : 's'} — see chat log)</span>}.{' '}
            <button
              onClick={() => {
                toast.dismiss(t.id);
                router.push('/dashboard/vault');
              }}
              className="underline font-bold text-sage"
            >
              View in Vault →
            </button>
          </span>
        ),
        { duration: 12000 }
      );
    } else {
      toast.error(
        `None of the ${files.length} files saved. See the chat log for per-file details.`,
        { duration: 10000 }
      );
    }
  };

  // Chunked PDF extraction for large appraisal reports. Splits images into
  // 5-page batches, runs AI extraction on each separately, accumulates the
  // unique comps, dedupes, then runs browser auto-locate on each.
  //
  // Why: GPT-4o vision has an input token budget that ~5 high-res images fits
  // comfortably but 20+ images blows past, returning "no comps" silently.
  // Chunking guarantees each call has enough budget to actually read the
  // pages it's given.
  const extractFromChunkedPdf = async (file: File, images: string[]) => {
    // 4-page chunks with 1-page overlap (stride 3). Tuned for the dominant
    // pattern in TX appraisal reports: 2 pages per comp (photo/ID/price on
    // page N, description/remarks on page N+1).
    //
    // For 24 pages (12 comps × 2 pages): 8 chunks. Each 2-page comp is
    // guaranteed to appear complete in at least one chunk — comps that
    // start on the last page of a chunk are caught whole by the next chunk
    // (which starts 3 pages back and extends 4 forward).
    //
    // Dedupe by (name|date|price) collapses the same comp seen in
    // overlapping chunks.
    const CHUNK_SIZE = 4;
    const STRIDE = 3;
    const chunks: string[][] = [];
    for (let i = 0; i < images.length; i += STRIDE) {
      const chunk = images.slice(i, i + CHUNK_SIZE);
      chunks.push(chunk);
      // Stop when we've reached the end (last chunk includes final pages)
      if (i + CHUNK_SIZE >= images.length) break;
    }

    // Show upload as one user message
    const userMessage: Message = {
      role: 'user',
      content: `[Document uploaded]\nUploaded: ${file.name} (${images.length} pages, processing ${chunks.length} chunks)`,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMessage]);

    const allComps: any[] = [];
    let errorCount = 0;
    const perChunkCounts: number[] = [];
    const perChunkMessages: string[] = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const startPage = chunkIdx * STRIDE + 1;
      const endPage = Math.min(chunkIdx * STRIDE + CHUNK_SIZE, images.length);
      const toastId = `chunk-${chunkIdx}`;
      toast.loading(`Extracting comps from pages ${startPage}-${endPage} of ${images.length}…`, { id: toastId });

      try {
        const response = await fetch('/api/import-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{
              role: 'user',
              content: `[Document uploaded]\nExtract any comparable land sales visible on these pages. This is part ${chunkIdx + 1} of ${chunks.length} of a multi-page appraisal report.`,
            }],
            images: chunks[chunkIdx],
          }),
        });
        toast.dismiss(toastId);

        if (!response.ok) {
          errorCount++;
          perChunkCounts.push(0);
          perChunkMessages.push(`HTTP ${response.status}`);
          console.warn(`Chunk ${chunkIdx + 1} HTTP ${response.status}`);
          continue;
        }
        const data = await response.json();
        const compCount = Array.isArray(data.comps) ? data.comps.length : 0;
        perChunkCounts.push(compCount);
        perChunkMessages.push(data.message?.slice(0, 80) || '');
        if (compCount > 0) {
          console.log(`[chunked] pages ${startPage}-${endPage}: ${compCount} comps`);
          allComps.push(...data.comps);
        } else {
          console.log(`[chunked] pages ${startPage}-${endPage}: 0 comps — AI said: ${data.message?.slice(0, 100)}`);
        }
      } catch (e: any) {
        toast.dismiss(toastId);
        errorCount++;
        perChunkCounts.push(0);
        perChunkMessages.push(`threw: ${e?.message || 'unknown'}`);
        console.error(`Chunk ${chunkIdx + 1} threw:`, e);
      }
    }

    // Deduplicate by (property_name + sale_date + sale_price). When the same
    // comp appears in multiple overlapping chunks, prefer the version with
    // the most complete data — specifically, the one with a boundary
    // geometry (from server-side enrichment), then the one with coords.
    // Otherwise the first occurrence wins.
    const byKey = new Map<string, any>();
    for (const c of allComps) {
      // Include grantee in the key so two distinct transactions of the SAME
      // property name (e.g. Wesla Ranches → 4F and Wesla Ranches → 9L) don't
      // collapse to one. Without grantee, AI mis-extracted or near-duplicate
      // sales got merged into one comp.
      const key = `${(c.property_name || '').toLowerCase().trim()}|${(c.grantee || '').toLowerCase().trim()}|${c.sale_date || ''}|${c.sale_price || 0}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, c);
        continue;
      }
      // Prefer the one with geometry, then with coords, then keep existing
      const newScore = (c.geometry ? 2 : 0) + (c.latitude != null ? 1 : 0);
      const oldScore = (existing.geometry ? 2 : 0) + (existing.latitude != null ? 1 : 0);
      if (newScore > oldScore) {
        byKey.set(key, c);
      }
    }
    const dedupedComps = Array.from(byKey.values());
    if (dedupedComps.length < allComps.length) {
      console.log(`[chunked] deduped: ${allComps.length} raw → ${dedupedComps.length} unique`);
    }

    // Run browser auto-locate for each unique comp (overrides any AI-guessed
    // coords for comps that don't have explicit "Geographic Location" fields).
    for (let i = 0; i < dedupedComps.length; i++) {
      const c = dedupedComps[i];
      // Skip if comp already has explicit coords (from "Geographic Location" field)
      if (c.latitude != null && c.longitude != null) {
        console.log(`[chunked] ${c.property_name}: using explicit doc coords (${c.latitude}, ${c.longitude})`);
        continue;
      }
      try {
        const located = await autoLocateInBrowserLogged(c);
        if (located) {
          dedupedComps[i] = {
            ...c,
            latitude: located.latitude,
            longitude: located.longitude,
            parcel_id: located.parcel_id ?? c.parcel_id,
            geometry: located.geometry,
            _auto_located_confidence: located.match_confidence,
          };
        }
      } catch (e) {
        console.error(`[chunked] autoLocate failed for ${c.property_name}:`, e);
      }
    }

    // Build diagnostic summary message — shows per-chunk counts so we can
    // see EXACTLY where extraction succeeded/failed across the document.
    const chunkBreakdown = perChunkCounts.length > 0
      ? `\n\nPer-chunk: ${perChunkCounts.map((n, i) => {
          const sp = i * STRIDE + 1;
          const ep = Math.min(i * STRIDE + CHUNK_SIZE, images.length);
          return `pp${sp}-${ep}: ${n}${perChunkMessages[i] && n === 0 ? ` (${perChunkMessages[i]})` : ''}`;
        }).join(' · ')}`
      : '';

    const summary = dedupedComps.length === 0
      ? errorCount > 0
        ? `Extraction failed for ${errorCount} of ${chunks.length} chunks. No comps recovered.${chunkBreakdown}`
        : `No comps extracted from ${chunks.length} chunks across ${images.length} pages. AI didn't recognize comp structure.${chunkBreakdown}`
      : `Extracted ${dedupedComps.length} comp${dedupedComps.length === 1 ? '' : 's'} from ${images.length} pages${errorCount > 0 ? ` (${errorCount} chunk${errorCount === 1 ? '' : 's'} errored)` : ''}.${chunkBreakdown}`;

    const assistantMessage: Message = {
      role: 'assistant',
      content: summary,
      comps: dedupedComps,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, assistantMessage]);

    if (dedupedComps.length > 0) {
      setPendingComps(prev => [...prev, ...dedupedComps]);
      toast.success(`Found ${dedupedComps.length} comp${dedupedComps.length === 1 ? '' : 's'}`, { duration: 4000 });
    } else {
      toast.error('No comps extracted from this document');
    }
  };

  const handleFileUpload = async (file: File) => {
    if (!file) return;
    setLoading(true);

    try {
      // PDFs: render pages client-side and send as images for vision extraction.
      // Images (jpg/png): pass straight through as a single-image array.
      if (file.type === 'application/pdf') {
        toast.loading('Rendering PDF pages…', { id: 'pdf-render' });
        // Higher quality now that we chunk — no token-budget worry per call
        const images = await pdfToImages(file, { scale: 1.5, maxPages: 60 });
        toast.dismiss('pdf-render');
        if (images.length === 0) {
          toast.error('Could not render PDF');
          return;
        }
        // For PDFs with >5 pages: chunked extraction (5 pages per AI call,
        // accumulate + dedupe comps from each chunk). Single-shot extraction
        // hits GPT-4o's input limit on large appraisal reports (20+ pages)
        // and returns "no comps" even when comps exist.
        if (images.length > 5) {
          await extractFromChunkedPdf(file, images);
          return;
        }
        await sendMessage(`Uploaded: ${file.name} (${images.length} pages)`, undefined, images);
        return;
      }

      if (file.type.startsWith('image/')) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        await sendMessage(`Uploaded: ${file.name}`, undefined, [dataUrl]);
        return;
      }

      // Fallback to server-side text parsing for other formats
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/parse-pdf', { method: 'POST', body: formData });
      const data = await response.json();
      if (data.text) {
        await sendMessage(`Uploaded: ${file.name}`, data.text);
      } else {
        toast.error('Could not read document');
      }
    } catch (err: any) {
      toast.dismiss('pdf-render');
      toast.error(err?.message || 'Failed to upload file');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!input.trim() || loading) return;
    await sendMessage(input.trim());
  };

  // saveComp accepts an optional second arg controlling the location
  // review state. Called from the verification card with one of two
  // intents:
  //   { needsReview: false } — broker clicked "Looks right" (verified)
  //   { needsReview: true }  — broker clicked "Needs review" (skipped
  //                            the visual check or flagged it as wrong;
  //                            either way the row lands with a clock
  //                            badge in the vault for follow-up)
  // When called without the second arg, defaults to false to preserve
  // existing behavior for any non-verification-flow callers.
  const saveComp = async (comp: ExtractedComp, opts?: { needsReview?: boolean }) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const needsReview = opts?.needsReview ?? false;

    const { error } = await supabase.from('comps').insert({
      created_by: user.id,
      property_name: comp.property_name,
      county: comp.county || '',
      state: comp.state || 'TX',
      acres: comp.acres || 0,
      sale_price: comp.sale_price || 0,
      improvements_value: comp.improvements_value,
      sale_date: comp.sale_date,
      address: comp.address,
      latitude: comp.latitude,
      longitude: comp.longitude,
      parcel_id: comp.parcel_id,
      recording_number: comp.recording_number,
      grantor: comp.grantor,
      grantee: comp.grantee,
      financing: comp.financing,
      minerals_sold: comp.minerals_sold,
      confirmation_source: comp.confirmation_source,
      description: comp.description,
      water: comp.water || 'None',
      road_frontage: comp.road_frontage || 'None',
      has_improvements: comp.has_improvements || false,
      improvements_notes: comp.improvements_notes,
      wildlife_notes: comp.wildlife_notes,
      flood_plain_pct: comp.flood_plain_pct,
      status: 'Sold',
      visibility: 'team',
      confidence: comp.confidence.overall > 80 ? 'Verified' : comp.confidence.overall > 50 ? 'Estimated' : 'Unverified',
      boundary_geojson: (comp as any).geometry ?? null,
      // Carry the math-identity-gate flag through to the row so the vault
      // UI can show its warning badge. False (default) if the gate passed
      // or couldn't run (one of price/ppa/acres was missing).
      needs_extraction_review: comp.needs_extraction_review || false,
      // From the verification screen: TRUE when broker skipped/flagged
      // (clock badge in vault); FALSE when broker visually confirmed.
      needs_location_review: needsReview,
    });

    if (error) {
      toast.error('Failed to save comp');
    } else {
      const label = comp.property_name || `${comp.county || 'Comp'}`;
      if (comp.latitude != null && comp.longitude != null) {
        toast.success(
          (t) => (
            <span>
              {label} added to vault.{' '}
              <button
                onClick={() => {
                  toast.dismiss(t.id);
                  router.push(`/dashboard/map?focus=${comp.latitude},${comp.longitude},14`);
                }}
                className="underline font-bold text-sage"
              >
                View on map →
              </button>
            </span>
          ),
          { duration: 6000 }
        );
      } else {
        toast.success(`${label} added to vault!`);
      }
      setPendingComps(prev => prev.filter(c => c !== comp));
    }
  };

  // Bulk-save shortcut — broker chose to skip the per-comp visual
  // verification and triage the batch later from the vault. Every row
  // gets flagged needs_location_review=true so the vault badge surfaces
  // them for follow-up.
  const saveAllComps = async () => {
    for (const comp of pendingComps) {
      await saveComp(comp, { needsReview: true });
    }
  };

  // Drag-and-drop handlers — accept PDFs + images, ignore everything else.
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
      setIsDraggingOver(true);
    }
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDraggingOver(false);
    }
  };
  const handleDragOver = (e: React.DragEvent) => {
    // Required to enable drop behavior.
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    dragCounterRef.current = 0;
    const files = Array.from(e.dataTransfer?.files || []).filter(
      (f) => f.type === 'application/pdf' || f.type.startsWith('image/')
    );
    const skipped = (e.dataTransfer?.files?.length ?? 0) - files.length;
    if (skipped > 0) {
      toast(`Skipped ${skipped} non-PDF/image file${skipped === 1 ? '' : 's'}`, { icon: '⚠️', duration: 4000 });
    }
    if (files.length > 0) handleMultipleFiles(files);
  };

  return (
    <div className="flex h-full bg-night">
      {/* Chat area — drag-and-drop is wired here so PDFs can be dropped
          anywhere in this column. Drop overlay sits on top when dragging. */}
      <div
        className="flex-1 flex flex-col relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drag-over overlay — covers the chat column with a dashed sage
            border + drop affordance. Pointer-events-none so the drop event
            still hits the wrapper underneath. */}
        {isDraggingOver && (
          <div className="absolute inset-0 z-50 bg-sage/10 backdrop-blur-sm border-4 border-dashed border-sage rounded-lg flex items-center justify-center pointer-events-none">
            <div className="text-center px-6">
              <Upload size={56} className="text-sage mx-auto mb-3" />
              <p className="text-xl font-bold text-sage">Drop PDFs to import</p>
              <p className="text-sm text-slate-300 mt-2">Multiple files supported · PDF or image</p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex-shrink-0 bg-panel border-b border-border px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-sage/10 border border-sage/20 flex items-center justify-center">
            <FileText size={15} className="text-sage" />
          </div>
          <div>
            <h1 className="font-bold text-sm">Import Comps</h1>
            <p className="text-xs text-slate-500">Upload PDF, paste text, or describe a property</p>
          </div>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-card border border-border rounded-lg text-xs font-bold text-slate-300 hover:text-white hover:border-sage transition-colors"
            >
              <Upload size={12} />
              Upload PDFs
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length > 0) handleMultipleFiles(files);
                // Reset so the user can re-pick the same files later if needed.
                if (e.target) e.target.value = '';
              }}
            />
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                msg.role === 'user'
                  ? 'bg-sage/10 border border-sage/20 text-white'
                  : 'bg-card border border-border text-slate-200'
              }`}>
                {msg.role === 'assistant' && (
                  <div className="flex items-center gap-1.5 mb-2">
                    <div className="w-4 h-4 rounded bg-sage/20 flex items-center justify-center">
                      <span className="text-sage text-[8px] font-bold">AI</span>
                    </div>
                    <span className="text-xs font-bold text-sage">Landstack AI</span>
                  </div>
                )}
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>

                {/* Extracted comps — verification cards with thumbnails.
                    Each card shows a source thumbnail (aerial from PDF if
                    extracted, satellite of source-provided coords, or a
                    text fallback) alongside a system-pinned thumbnail
                    (Mapbox satellite centered on the autoLocate result).
                    Broker picks "Looks right" (save verified) or "Needs
                    review" (save flagged) per comp. */}
                {msg.comps && msg.comps.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {msg.comps.map((comp, ci) => {
                      const aerial = (comp as any).aerialImage as string | undefined;
                      const sysLat = comp.latitude;
                      const sysLng = comp.longitude;
                      // When autoLocate produced a parcel boundary, pass it
                      // to Mapbox as a polygon overlay so the broker sees the
                      // actual parcel SHAPE, not just a pin in the middle.
                      // When no boundary (manual entry, autoLocate null), the
                      // helper falls back to pin-only rendering.
                      const sysBoundary = (comp as any).geometry;
                      const sysPinUrl = (sysLat != null && sysLng != null)
                        ? mapboxStaticUrl({
                            lat: sysLat,
                            lng: sysLng,
                            zoom: 14,
                            boundary: sysBoundary || undefined,
                          })
                        : null;
                      // Source thumbnail priority: explicit aerial from PDF >
                      // source-provided lat/lng (rare — Stouffer-format) >
                      // text panel.
                      const sourceLatLng = (comp as any)._source_latitude != null
                        && (comp as any)._source_longitude != null
                        ? { lat: (comp as any)._source_latitude, lng: (comp as any)._source_longitude }
                        : null;
                      const sourceMapUrl = !aerial && sourceLatLng
                        ? mapboxStaticUrl({ lat: sourceLatLng.lat, lng: sourceLatLng.lng, zoom: 14 })
                        : null;

                      return (
                      <div key={ci} className="bg-night border border-border rounded-xl p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1">
                            <p className="text-sm font-bold text-white">
                              {comp.property_name || `${comp.county} County — ${comp.acres} ac`}
                            </p>
                            <p className="text-xs text-slate-400 mt-0.5">
                              {comp.county}, {comp.state} · {comp.acres} acres
                            </p>
                            <div className="flex items-center gap-3 mt-1.5">
                              <span className="text-emerald-400 font-mono text-xs font-bold">
                                ${comp.sale_price?.toLocaleString()}
                              </span>
                              {comp.ppa_land_only && (
                                <span className="text-emerald-400 font-mono text-xs">
                                  ${Math.round(comp.ppa_land_only).toLocaleString()}/ac (land)
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <div className={`w-2 h-2 rounded-full ${
                              comp.confidence.overall >= 80 ? 'bg-emerald-400' :
                              comp.confidence.overall >= 50 ? 'bg-amber-400' : 'bg-red-400'
                            }`} />
                            <span className="text-xs text-slate-500">{comp.confidence.overall}%</span>
                          </div>
                        </div>

                        {/* Side-by-side thumbnails: source vs system match */}
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          {/* LEFT: source */}
                          <div>
                            {aerial ? (
                              // Aerial is the FULL PDF page (~portrait letter
                              // ratio with the aerial at the top, data tables
                              // below). Default `object-cover` centered would
                              // show the data tables; anchor to top + scale up
                              // via CSS background so the thumbnail crops to
                              // just the aerial portion. 240% zoom is tuned to
                              // Stouffer-format pages where the aerial occupies
                              // roughly the top 20-30% — most appraisal pages
                              // have generous margins above the aerial so we
                              // need more zoom than first guess. Adjust here
                              // if other appraisal formats have different
                              // layouts.
                              <div
                                role="img"
                                aria-label="From source"
                                className="w-full h-32 rounded border border-border bg-night"
                                style={{
                                  backgroundImage: `url("${aerial}")`,
                                  backgroundSize: '240% auto',
                                  backgroundPosition: 'center top',
                                  backgroundRepeat: 'no-repeat',
                                }}
                              />
                            ) : sourceMapUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={sourceMapUrl}
                                alt="Source coords"
                                className="w-full h-32 object-cover rounded border border-border"
                              />
                            ) : (
                              <div className="w-full h-32 bg-card border border-border rounded p-2 text-[10px] text-slate-400 flex flex-col gap-0.5 overflow-hidden">
                                <div className="text-slate-500 uppercase tracking-wide">Source data</div>
                                {comp.grantee && <div className="text-white truncate">→ {comp.grantee}</div>}
                                {comp.grantor && <div className="text-slate-400 truncate">from {comp.grantor}</div>}
                                {comp.address && <div className="text-slate-400 truncate">{comp.address}</div>}
                                {comp.description && (
                                  <div className="text-slate-500 line-clamp-3 mt-0.5">
                                    {comp.description.slice(0, 120)}{comp.description.length > 120 ? '…' : ''}
                                  </div>
                                )}
                              </div>
                            )}
                            <div className="text-[10px] text-slate-500 text-center mt-1">From source</div>
                          </div>

                          {/* RIGHT: system match */}
                          <div>
                            {sysPinUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={sysPinUrl}
                                alt="System pin"
                                className="w-full h-32 object-cover rounded border border-border"
                              />
                            ) : (
                              <div className="w-full h-32 bg-amber-900/20 border border-amber-700/40 rounded p-2 text-[10px] flex flex-col items-center justify-center text-center gap-1">
                                <AlertTriangle className="text-amber-400" size={20} />
                                <div className="text-amber-300 font-bold">Could not locate</div>
                                <div className="text-amber-200/70 text-[9px]">Place manually in vault</div>
                              </div>
                            )}
                            <div className="text-[10px] text-slate-500 text-center mt-1">System pinned</div>
                          </div>
                        </div>

                        {/* Two-button verification action row */}
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <button
                            onClick={() => saveComp(comp, { needsReview: false })}
                            disabled={sysLat == null || sysLng == null}
                            title={sysLat == null ? 'No pin to confirm — use Needs review and fix manually' : 'Mark this comp as verified and save to vault'}
                            className="py-2 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Check size={12} />
                            Looks right
                          </button>
                          <button
                            onClick={() => saveComp(comp, { needsReview: true })}
                            title="Save the comp but flag it for review — broker comes back later via the vault"
                            className="py-2 bg-slate-500/10 hover:bg-slate-500/20 border border-slate-500/30 text-slate-300 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1"
                          >
                            <Clock size={12} />
                            Needs review
                          </button>
                        </div>
                      </div>
                      );
                    })}

                    {msg.comps.length > 1 && (
                      <button
                        onClick={saveAllComps}
                        className="w-full py-2 bg-slate-500/10 hover:bg-slate-500/20 border border-slate-500/30 text-slate-300 rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1"
                      >
                        <Clock size={12} />
                        Save all {msg.comps.length} for review later
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-card border border-border rounded-2xl px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded bg-sage/20 flex items-center justify-center">
                    <span className="text-sage text-[8px] font-bold">AI</span>
                  </div>
                  <div className="flex gap-1">
                    <div className="w-1.5 h-1.5 bg-sage rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-1.5 h-1.5 bg-sage rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-1.5 h-1.5 bg-sage rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="flex-shrink-0 bg-panel border-t border-border p-3">
          <div className="flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-2.5 bg-card border border-border rounded-xl text-slate-400 hover:text-sage hover:border-sage transition-colors flex-shrink-0"
            >
              <Upload size={16} />
            </button>
            <div className="flex-1 relative">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder="Paste appraisal text, describe a sale, or ask a question..."
                rows={1}
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-sage transition-colors resize-none"
                style={{ minHeight: '42px', maxHeight: '120px' }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = 'auto';
                  target.style.height = Math.min(target.scrollHeight, 120) + 'px';
                }}
              />
            </div>
            <button
              onClick={handleSubmit}
              disabled={loading || !input.trim()}
              className="p-2.5 bg-sage hover:bg-sage2 text-black rounded-xl transition-colors flex-shrink-0 disabled:opacity-50"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="text-[10px] text-slate-600 mt-1.5 text-center">
            Paste from email, upload PDF, or take a photo · Press Enter to send
          </p>
        </div>
      </div>
    </div>
  );
}

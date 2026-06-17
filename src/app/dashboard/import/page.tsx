'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { ExtractedComp } from '@/types';
import { Upload, Send, FileText, CheckCircle, AlertCircle, Plus, X, AlertTriangle, Clock, Check } from 'lucide-react';
import DeleteConfirmButton from '@/components/ui/DeleteConfirmButton';
import toast from 'react-hot-toast';
import { pdfToImages } from '@/lib/utils/pdfToImages';
import { detectCompBoundaries, type CompMap } from '@/lib/utils/pdfBoundaryDetection';
import { detectCompBoundariesViaVision } from '@/lib/utils/visionBoundaryDetection';
import { sanitizeExtractedBatch } from '@/lib/utils/extractionSanity';
import {
  uploadSourceDocument,
  attachSourceDocumentToComps,
} from '@/lib/utils/compDocuments';
import { extractLargestAerial, extractLargestAerialPerPage } from '@/lib/utils/pdfExtractAerial';
import { mapboxStaticUrl } from '@/lib/utils/mapboxStaticImage';
import { normalizeCountyForStorage } from '@/lib/utils/normalizeCounty';
import { findDuplicateCandidates, type DuplicateMatch } from '@/lib/utils/findDuplicates';
import { TieredLoadingMessage } from '@/components/TieredLoadingMessage';

// ─── Tier-field sanitizers ─────────────────────────────────────────────
// The DB enforces CHECK constraints on these fields (migration 001):
//   water         ∈ {'None', 'Seasonal', 'Strong'}
//   road_frontage ∈ {'None', 'Low', 'Medium', 'High'}
//   dev_potential ∈ {'Low', 'Medium', 'High'}
//   irrigation    ∈ {'None', 'Medium', 'Strong'}  (migration 012)
//
// The AI sometimes returns appraisal-language ("Paved", "County Road",
// "Excellent", "Limited") that doesn't match the schema enum — saves
// then fail with "violates check constraint comps_X_check". These
// helpers normalize raw AI output to a known-valid value, with
// best-effort mappings from common appraisal phrasing.
//
// Unknown values fall back to the column's safest default (typically
// 'None' for water/road/irrigation; 'Low' for dev_potential).

function sanitizeWater(raw: unknown): 'None' | 'Seasonal' | 'Strong' {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'None';
  if (/strong|live|year[- ]?round|perennial|active/.test(s)) return 'Strong';
  if (/seasonal|wet[- ]?weather|intermittent|spring[- ]?fed/.test(s)) return 'Seasonal';
  if (s === 'none' || s === 'no' || s === 'n/a' || /\bnone\b/.test(s)) return 'None';
  // Title-case match (most common AI output)
  if (s === 'strong') return 'Strong';
  if (s === 'seasonal') return 'Seasonal';
  return 'None';
}

function sanitizeRoadFrontage(raw: unknown): 'None' | 'Low' | 'Medium' | 'High' {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'None';
  // Exact enum matches first
  if (s === 'high') return 'High';
  if (s === 'medium' || s === 'med') return 'Medium';
  if (s === 'low') return 'Low';
  if (s === 'none' || s === 'no' || s === 'n/a' || /\bnone\b/.test(s)) return 'None';
  // Appraisal-language mappings
  if (/paved|highway|state\s?road|good\s?frontage|excellent|interstate/.test(s)) return 'High';
  if (/gravel|caliche|all[- ]weather|county\s?road|fair/.test(s)) return 'Medium';
  if (/dirt|easement|limited|minimal|rough|poor/.test(s)) return 'Low';
  return 'None';
}

function sanitizeDevPotential(raw: unknown): 'Low' | 'Medium' | 'High' {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'Low';
  if (s === 'high') return 'High';
  if (s === 'medium' || s === 'med') return 'Medium';
  if (s === 'low') return 'Low';
  if (/strong|excellent|prime|imminent/.test(s)) return 'High';
  if (/moderate|fair|potential/.test(s)) return 'Medium';
  if (/none|limited|remote|rural/.test(s)) return 'Low';
  return 'Low';
}

function sanitizeIrrigation(raw: unknown): 'None' | 'Medium' | 'Strong' | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null; // irrigation is nullable; preserve "unknown"
  if (s === 'strong') return 'Strong';
  if (s === 'medium' || s === 'med') return 'Medium';
  if (s === 'none' || s === 'no' || s === 'n/a') return 'None';
  if (/center\s?pivot|drip|active|strong/.test(s)) return 'Strong';
  if (/some|partial|limited|medium/.test(s)) return 'Medium';
  if (/dry|dryland|none/.test(s)) return 'None';
  return null;
}

// Build a patch object that updates an existing comp with newly-extracted
// data WITHOUT overwriting fields the broker has already verified.
//
// Policy: only fill values where the existing comp has nothing (null,
// empty string, or missing). Never overwrite existing data — the broker
// may have manually corrected it, and a re-extraction could regress.
//
// Defining-the-duplicate fields (sale_price, sale_date, acres) are
// explicitly excluded — if these differ, it's not a duplicate, and the
// dedup detection would have caught it before this merge runs.
function buildMergePatch(existing: any, fresh: any): Record<string, any> {
  const patch: Record<string, any> = {};
  // Fields that fill if existing is null/empty.
  const fillIfEmpty: Array<[string, any]> = [
    ['aerial_image', fresh.aerialImage ?? fresh.aerial_image],
    ['latitude', fresh.latitude],
    ['longitude', fresh.longitude],
    ['parcel_id', fresh.parcel_id],
    ['boundary_geojson', fresh.geometry ?? fresh.boundary_geojson],
    ['description', fresh.description],
    ['address', fresh.address],
    ['property_name', fresh.property_name],
    ['grantor', fresh.grantor],
    ['grantee', fresh.grantee],
    ['price_per_acre', fresh.price_per_acre],
    ['ppa_land_only', fresh.ppa_land_only],
    ['improvements_value', fresh.improvements_value],
  ];
  for (const [field, value] of fillIfEmpty) {
    const existingVal = existing?.[field];
    const isEmpty = existingVal == null || existingVal === '' ||
      (typeof existingVal === 'string' && existingVal.trim() === '');
    if (isEmpty && value != null && value !== '') {
      patch[field] = value;
    }
  }
  return patch;
}

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

// ─── Address-geocode fallback ──────────────────────────────────────────
// When parcel-level auto-locate strikes out (no owner-name match in the
// county roll), forward-geocode the comp's address as a best-effort
// "pin somewhere useful" so the broker isn't left with a vault entry
// at (null, null).
//
// Real-world trigger: MLS sold sheets where grantor/grantee are blank
// (or were correctly null'd because the doc only listed agents). We
// have a street address, so we can at least drop a pin at the building.
// The broker enters review mode and reselects parcels from there.
//
// Hard rules:
//   - Requires a real street address (must contain a digit). City-only
//     strings like "Pearsall, TX" would just geocode to a centroid and
//     mislead the broker — don't bother.
//   - Confidence is always "low" — we have no boundary, no parcel match,
//     and no acreage verification. Broker MUST refine.
//   - Returns the same shape as autoLocateInBrowser so call sites can
//     treat it identically.
async function geocodeAddressFallback(comp: any): Promise<{
  latitude: number;
  longitude: number;
  parcel_id: string | null;
  geometry: any;
  match_reason: string;
  match_confidence: 'high' | 'medium' | 'low';
  // Phase 2b: Mapbox v6 also returns the county that contains the
  // geocoded address. We surface it here so the caller (locateCompForImport)
  // can cross-check it against the AI-extracted county.
  geocoded_county?: string | null;
} | null> {
  const address = typeof comp?.address === 'string' ? comp.address.trim() : '';
  // No address OR address has no number → skip. Mapbox would happily
  // resolve "Pearsall, TX" to a city centroid; that's worse than no pin
  // because it implies precision we don't have.
  if (!address || !/\d/.test(address) || address.length < 6) return null;
  try {
    const { geocodeAddress } = await import('@/lib/utils/geocodePlace');
    const hit = await geocodeAddress(address);
    if (!hit) return null;
    return {
      latitude: hit.lat,
      longitude: hit.lng,
      parcel_id: null,
      geometry: null,
      match_reason: 'pinned to street address — verify boundary',
      match_confidence: 'low',
      geocoded_county: hit.county ?? null,
    };
  } catch {
    return null;
  }
}

// Combined locate: parcel-level first (best), address geocode second
// (good enough). Both call sites in the import pipeline should call
// this rather than autoLocateInBrowserLogged directly.
//
// Phase 2b cross-check: when the locator falls through to geocode (parcel
// match failed), Mapbox tells us which county the address actually sits
// in. We cross-check that against the AI-extracted county and append a
// warning to _sanity_warnings if they disagree — the broker sees this in
// review. We DON'T overwrite the extracted county; that's a broker call.
async function locateCompForImport(comp: any) {
  const located = await autoLocateInBrowserLogged(comp);
  if (located) return located;
  const fallback = await geocodeAddressFallback(comp);
  if (fallback && fallback.geocoded_county) {
    try {
      const { crossCheckGeocodedCounty } = await import('@/lib/utils/extractionSanity');
      crossCheckGeocodedCounty(comp, { county: fallback.geocoded_county });
    } catch (e) {
      console.warn('[locate] county cross-check failed:', e);
    }
  }
  return fallback;
}

// ─── Aerial attribution (shared between single-shot + chunked paths) ──
//
// Past failure mode: extractFromChunkedPdf (the >5-page path) never
// extracted aerials at all because the per-page extraction lived
// inside sendMessage and wasn't pulled into the chunked path. Every
// 6+ page upload lost its thumbnails silently.
//
// The fix is structural: both paths now route through this helper, so
// fixes to attribution heuristics auto-apply everywhere AND we get one
// place to diagnose misses. Returns the count of comps that got an
// aerial attached, so callers can surface that in the verification UX.
function attachAerialsToComps(
  comps: any[],
  sourceAerial: string | null | Array<{ page: number; dataUrl: string }>,
): { attached: number; missed: number } {
  let attached = 0;
  let missed = 0;
  if (!Array.isArray(comps) || comps.length === 0) return { attached, missed };
  if (!sourceAerial) {
    return { attached: 0, missed: comps.length };
  }

  if (typeof sourceAerial === 'string') {
    // Single-comp case: only safe to attach when exactly one comp came
    // back. Otherwise we'd put the same aerial on every comp (wrong).
    if (comps.length === 1) {
      comps[0].aerialImage = sourceAerial;
      return { attached: 1, missed: 0 };
    }
    return { attached: 0, missed: comps.length };
  }

  if (!Array.isArray(sourceAerial) || sourceAerial.length === 0) {
    return { attached: 0, missed: comps.length };
  }

  // ─── Subject-property / letterhead filter ─────────────────────────
  // Many appraisal reports embed the SUBJECT property's aerial as a
  // reference graphic on every page of the report (a small thumbnail
  // strip, a repeated banner, etc.). When extractLargestAerialPerPage
  // pulls "the largest image per page" those repeated subject
  // thumbnails dominate, and the comp aerials we actually want for
  // attribution get drowned out by the same subject image appearing on
  // 5+ pages — landing the wrong thumbnail on every comp.
  //
  // We fingerprint each aerial by a content hash and treat any
  // fingerprint appearing on ≥3 pages as letterhead/subject. Those
  // fingerprints are excluded from comp attribution; the remaining
  // aerials are unique-per-comp, which is the invariant we need.
  //
  // FINGERPRINT QUALITY MATTERS: the first 200 chars of a JPEG dataUrl
  // are mostly the `data:image/jpeg;base64,` prefix and JPEG metadata
  // headers — nearly identical across different photos. Hashing just
  // those bytes can collide two genuinely-different aerials onto the
  // same fingerprint, incorrectly classifying real comp aerials as
  // "letterhead" and dropping them.
  //
  // FNV-1a 32-bit hash over the FULL dataUrl: synchronous, fast (~10µs
  // per 100KB image), deterministic, and reliably differentiates
  // distinct images while collapsing repeats to a single value. Good
  // enough for this dedup purpose — not crypto, but not pretending to
  // be either.
  const aerialFingerprint = (url: string): string => {
    let hash = 0x811c9dc5; // FNV offset basis (32-bit)
    for (let i = 0; i < url.length; i++) {
      hash ^= url.charCodeAt(i);
      // FNV prime = 0x01000193, but JS bitwise ops force int32 so we use
      // Math.imul to keep the multiplication in 32-bit unsigned space.
      hash = Math.imul(hash, 0x01000193);
    }
    // Return as unsigned hex string so the value is stable across
    // sign-bit toggles.
    return (hash >>> 0).toString(16);
  };

  const fingerprintFrequency = new Map<string, number>();
  for (const a of sourceAerial) {
    const fp = aerialFingerprint(a.dataUrl);
    fingerprintFrequency.set(fp, (fingerprintFrequency.get(fp) || 0) + 1);
  }
  // Cutoff: appearing on 3+ pages → it's NOT a comp aerial, it's
  // letterhead or the subject property. 2+ is too aggressive
  // (legitimate 2-page comps sometimes have the same aerial repeated).
  const SUBJECT_FREQUENCY_CUTOFF = 3;
  const subjectFingerprints = new Set<string>();
  fingerprintFrequency.forEach((count, fp) => {
    if (count >= SUBJECT_FREQUENCY_CUTOFF) subjectFingerprints.add(fp);
  });
  const compAerials = sourceAerial.filter(
    (a) => !subjectFingerprints.has(aerialFingerprint(a.dataUrl)),
  );
  if (subjectFingerprints.size > 0) {
    console.log(
      `[aerial] filtered out ${subjectFingerprints.size} repeating image(s) ` +
      `(letterhead / subject property): ${sourceAerial.length} pages → ${compAerials.length} comp candidates`
    );
  }
  if (compAerials.length === 0) {
    // Edge case: every aerial in the PDF was the subject/letterhead.
    // No safe attribution possible — leave all comps without
    // thumbnails. Brokers see the source PDF link instead.
    return { attached: 0, missed: comps.length };
  }

  // Multi-comp / multi-page case: attribute each aerial to a comp via
  // its cite-the-source citations. Each citation looks like
  // "page 2 · transaction data · 'Sale Price' row" — we count which
  // page each comp's citations reference most and pick that page's
  // aerial.
  //
  // No-reuse by FINGERPRINT (not by page number): two pages can carry
  // the same image (subject repeated as small reference), so claiming
  // "page 2" doesn't prevent another comp from claiming the same
  // dataUrl on "page 4". We claim the underlying image content
  // instead — guaranteeing every comp gets a UNIQUE thumbnail or no
  // thumbnail at all.
  //
  // Index-alignment fallback restored — when citation-based attribution
  // can't resolve a candidate (citations missing, claimed already),
  // fall back to assigning by document order from the remaining
  // unclaimed comp aerials. This is intentionally a last-resort path
  // and only kicks in when better signals are absent.
  const claimedFingerprints = new Set<string>();
  const claimedPages = new Set<number>();

  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    const citations: string[] = [
      c?.acres_source,
      c?.sale_price_source,
      c?.price_per_acre_source,
      c?.ppa_land_only_source,
    ].filter((x: any) => typeof x === 'string');

    const pageHits: Record<number, number> = {};
    for (const cite of citations) {
      const matches = Array.from(cite.matchAll(/\bpage\s+(\d+)|\bp\.\s*(\d+)/gi));
      for (const m of matches) {
        const pg = Number(m[1] ?? m[2]);
        if (Number.isFinite(pg) && pg > 0) {
          pageHits[pg] = (pageHits[pg] || 0) + 1;
        }
      }
    }

    let dominantPage: number | null = null;
    let bestCount = 0;
    for (const [pg, count] of Object.entries(pageHits)) {
      if (count > bestCount) {
        dominantPage = Number(pg);
        bestCount = count;
      }
    }

    // Build candidate pages in priority order:
    //   1. Dominant citation page
    //   2. Lead-page heuristic (for 2-page comps, the aerial often lives
    //      on the odd page — page 1 of "comp pair 1-2", page 3 of "comp
    //      pair 3-4"). When dominant is even, try prior odd; when odd,
    //      try next even.
    //   3. All other pages mentioned in citations (widens net when
    //      dominant page's aerial is already claimed by an earlier comp).
    const candidatePages: number[] = [];
    if (dominantPage != null) {
      candidatePages.push(dominantPage);
      if (dominantPage % 2 === 0) candidatePages.push(dominantPage - 1);
      else candidatePages.push(dominantPage + 1);
    }
    for (const pg of Object.keys(pageHits).map(Number)) {
      if (!candidatePages.includes(pg)) candidatePages.push(pg);
    }

    // Walk candidates in priority order. First UNCLAIMED match (by both
    // page AND fingerprint) wins.
    let aerial: { page: number; dataUrl: string } | null = null;
    for (const pg of candidatePages) {
      if (claimedPages.has(pg)) continue;
      const hit = compAerials.find((a) => a.page === pg);
      if (!hit) continue;
      const fp = aerialFingerprint(hit.dataUrl);
      if (claimedFingerprints.has(fp)) continue;
      aerial = hit;
      break;
    }

    // Index-alignment fallback. When citations couldn't resolve a
    // candidate, assign by document order from the remaining
    // unclaimed aerials. Better to have a SOMEWHAT-correlated aerial
    // than no aerial — the broker can always swap it later via the
    // verification UI. The subject/letterhead filter above means
    // these fallbacks pull from genuine comp aerials only, not
    // repeating background graphics.
    if (!aerial) {
      const remaining = compAerials.filter(
        (a) =>
          !claimedPages.has(a.page) &&
          !claimedFingerprints.has(aerialFingerprint(a.dataUrl)),
      );
      if (remaining.length > 0) {
        aerial = remaining[0];
      }
    }

    if (aerial) {
      c.aerialImage = aerial.dataUrl;
      claimedPages.add(aerial.page);
      claimedFingerprints.add(aerialFingerprint(aerial.dataUrl));
      attached += 1;
      console.log(
        `[aerial] comp ${i + 1} (${c.property_name || c._boundary_label || 'unnamed'}) ` +
        `→ page ${aerial.page} (dominant ${dominantPage ?? 'n/a'})`
      );
    } else {
      missed += 1;
      console.log(
        `[aerial] comp ${i + 1} (${c.property_name || c._boundary_label || 'unnamed'}) ` +
        `→ NO aerial (candidates ${candidatePages.join(',') || 'none'}, ` +
        `all already claimed or missing). Comp will save without a thumbnail.`
      );
    }
  }
  return { attached, missed };
}

// ─── Duplicate detection (shared between single-shot + chunked paths) ─
//
// Past failure mode: dedupe lived inline in sendMessage only. PDFs
// >5 pages went through extractFromChunkedPdf and never ran the
// check — re-importing the same Wilson County 6-pager would silently
// create copies in the vault without surfacing the "Possible
// duplicate of:" banner that exists for short uploads. Same drift
// pattern that hit aerial extraction before PR #29.
//
// This helper queries Supabase for each extracted comp's possible
// duplicates (matching sale_date + sale_price within $1), runs the
// fuzzy grantor/grantee matcher (findDuplicateCandidates), and tags
// the comp with `_duplicates` for the verification card to render.
// Silent failures — dedupe is a nicety, not blocking; one comp's
// failed query never breaks the rest of the batch.
async function runDuplicateCheck(comps: any[], supabaseClient: any): Promise<void> {
  if (!Array.isArray(comps)) return;
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    if (!c?.sale_date || !(Number(c?.sale_price) > 0)) continue;
    try {
      const { data: candidates, error } = await supabaseClient
        .from('comps')
        .select('id, property_name, county, grantor, grantee, sale_date, sale_price, created_at')
        .eq('sale_date', c.sale_date)
        .gte('sale_price', Number(c.sale_price) - 1)
        .lte('sale_price', Number(c.sale_price) + 1);
      if (error || !Array.isArray(candidates)) continue;
      const matches = findDuplicateCandidates(c, candidates as any);
      if (matches.length > 0) {
        (comps[i] as any)._duplicates = matches;
      }
    } catch (e) {
      console.warn('[import] dedup check failed for', c?.property_name, e);
    }
  }
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
  // Optional specific status to surface during long-running AI ops.
  // Caller sets this when entering each phase ("Reading PDF…", "Auto-
  // locating parcels…", "Checking for duplicates…") so the tiered
  // loading message can show what's actually happening in real time.
  // Leave null when there's nothing specific worth surfacing — the
  // brand voice line carries the wait on its own.
  const [loadingStatus, setLoadingStatus] = useState<string | null>(null);
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

  // ─── Session persistence (round-trip from review page) ───────────────
  //
  // The "Needs review" button on each verification card saves all comps
  // and navigates to /dashboard/review/[id]?return=import. The review
  // page sends the broker back here after they finish (Mark verified /
  // Save reselect / Save draw). For the broker to see the OTHER unreviewed
  // comps from the same import batch when they return, we have to
  // preserve this page's state — React state is gone after navigation,
  // so we mirror messages + pendingComps to sessionStorage.
  //
  // SESSION_STORAGE_KEY scopes per-tab; survives back/forward + page
  // reload during the same session, evaporates on tab close. Don't use
  // localStorage — stale extraction cards persisting across days would
  // be more confusing than useful.
  const SESSION_STORAGE_KEY = 'import-session';

  // Restore on first mount. Wrapped in try/catch because malformed
  // sessionStorage (manual user edit, version mismatch) shouldn't crash
  // the import page — fall back to the empty-greeting initial state.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return;
      const restored = JSON.parse(raw);
      if (Array.isArray(restored?.messages) && restored.messages.length > 0) {
        setMessages(restored.messages);
      }
      if (Array.isArray(restored?.pendingComps)) {
        setPendingComps(restored.pendingComps);
      }
    } catch {
      // Stale or malformed — ignore, the user gets a fresh page.
    }
    // Run-once on mount; no dependencies (initial state restore only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on every state change. Skip the empty initial state (just
  // the greeting + no comps) to keep stored payloads small. Wrapped in
  // try/catch because sessionStorage can throw on quota exceeded — a
  // missing persist is recoverable, a thrown render is not.
  useEffect(() => {
    try {
      const hasContent = messages.length > 1 || pendingComps.length > 0;
      if (hasContent) {
        sessionStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({ messages, pendingComps })
        );
      }
    } catch {
      // Quota exceeded or storage disabled — non-fatal.
    }
  }, [messages, pendingComps]);

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
    images?: string[],
    // Optional aerial photo(s) extracted from the source PDF. For single-
    // comp uploads, pass a string (the single best aerial). For multi-
    // comp uploads (one PDF with multiple LAND COMPARABLE sections),
    // pass the per-page array — caller uses each comp's citations to
    // attribute the right aerial. NULL when no aerials were extracted.
    sourceAerial?: string | null | Array<{ page: number; dataUrl: string }>,
  ) => {
    const userMessage: Message = {
      role: 'user',
      content: fileContent || images?.length ? `[Document uploaded]\n${text}` : text,
      timestamp: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setLoadingStatus('Reading the document…');

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

      // Attach the source aerial(s) to the extracted comp(s) so the
      // verification card can show them on the LEFT side (vs. the
      // matched parcel on the RIGHT). Two cases:
      //
      // 1. Single-comp PDF — sourceAerial is a string. Attach directly.
      // 2. Multi-comp PDF — sourceAerial is an array of {page, dataUrl}.
      //    Use each comp's cite-the-source citations to find which page
      //    that comp lives on, then attach that page's aerial.
      //
      // The page-attribution heuristic: count how many citations on each
      // comp reference each page. The page with the most citations is
      // that comp's primary page. Aerial from that page → that comp.
      // Fallback: if no citation has a page number, attach the aerial
      // at the same index as the comp (comp 1 → page 1's aerial).
      if (Array.isArray(data.comps) && data.comps.length > 0) {
        const { attached, missed } = attachAerialsToComps(
          data.comps as any[],
          sourceAerial ?? null,
        );
        if (missed > 0) {
          console.warn(
            `[import] aerial attribution: ${attached}/${attached + missed} comps got a thumbnail. ` +
            `${missed} missed — either the PDF lacked embedded raster images on that page, or citation→page heuristic failed.`
          );
        }
      }

      // Browser-side auto-locate: server-side auto-locate fails inside Vercel
      // functions because function-to-self URL calls don't hit the edge cache.
      // Re-run from the browser where /api/parcels-by-owner cache hits work.
      //
      // SKIP when the AI already extracted explicit coords (from a "Geographic
      // Location" field in the doc). Those are authoritative — running browser
      // auto-locate on top could replace them with a less-precise match.
      if (Array.isArray(data.comps) && data.comps.length > 0) {
        setLoadingStatus(`Locating ${data.comps.length} ${data.comps.length === 1 ? 'property' : 'properties'} on the map…`);
      }
      if (Array.isArray(data.comps)) {
        for (let i = 0; i < data.comps.length; i++) {
          const c = data.comps[i];
          const label = c.property_name || c.county || 'comp';
          if (c.latitude != null && c.longitude != null) {
            console.log(`[import] ${label}: using AI-extracted coords (${c.latitude}, ${c.longitude}) — skipping browser auto-locate`);
            continue;
          }
          try {
            // locateCompForImport tries parcel match first, then falls
            // back to street-address geocoding so MLS sold sheets (where
            // the only locator is "Address:") still get a pin.
            const located = await locateCompForImport(c);
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

      // ─── Duplicate detection ────────────────────────────────────
      // For each extracted comp, query existing comps with matching
      // sale_date + sale_price (within $1) and check if grantor/grantee
      // also match (fuzzy). Tags each comp with _duplicates so the
      // verification card can render a warning banner.
      //
      // Targeted query (not "fetch all comps") so this scales — a broker
      // with 1000 comps only fetches the handful that share the exact
      // date + price, then fuzzy-matches the parties client-side.
      if (Array.isArray(data.comps) && data.comps.length > 0) {
        setLoadingStatus('Checking your vault for duplicates…');
      }
      if (Array.isArray(data.comps)) {
        await runDuplicateCheck(data.comps, supabase);
        // Auto-save on extraction (PR #45) — every extracted comp
        // saves immediately to the vault as needs_location_review=true.
        // See autoSaveExtracted for the silent-bulk-save loop.
        if (data.comps.length > 0) {
          await autoSaveExtracted(data.comps);
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
      setLoadingStatus(null);
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
      // here where /api/parcels-by-owner cache hits work. Falls back to
      // address geocoding for MLS sheets that don't match by owner.
      for (let i = 0; i < comps.length; i++) {
        const located = await locateCompForImport(comps[i]);
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
      // Tier fields — sanitize against schema CHECK constraints.
      water: sanitizeWater((comp as any).water),
      road_frontage: sanitizeRoadFrontage((comp as any).road_frontage),
      has_improvements: (comp as any).has_improvements || false,
      improvements_notes: (comp as any).improvements_notes,
      has_water_rights: (comp as any).has_water_rights ?? null,
      irrigation: sanitizeIrrigation((comp as any).irrigation),
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
      // Persist source aerial from PDF extraction (see saveComp comment for
      // details). insertCompResilient transparently retries without this
      // column if migration 021 hasn't been applied yet — no hard dependency.
      aerial_image: (comp as any).aerialImage || null,
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
  //
  // The batch path uses the SAME thinking-bubble UX as the single-file
  // path (loading=true → pulsing AI bubble + tiered status message)
  // plus a top-right toast for at-a-glance progress. Two reinforcing
  // surfaces: the broker who's looking at the chat sees the assistant
  // working in real-time; the broker who tabbed away sees the toast.
  // Previously the batch path was silent in the chat — only the toast
  // moved — which made multi-file uploads feel frozen.
  const handleMultipleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (files.length === 1) {
      await handleFileUpload(files[0]);
      return;
    }

    const toastId = 'batch-upload';
    let savedCount = 0;
    const outcomes: Array<{ file: string; outcome: ExtractOutcome }> = [];

    // Flip on the chat thinking bubble for the whole batch. Cleared
    // in the finally below so a partial-failure mid-batch doesn't
    // leave the AI bubble pulsing forever.
    setLoading(true);

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const progressLabel = `Processing ${i + 1} of ${files.length} · ${file.name}`;
        toast.loading(progressLabel, { id: toastId });
        setLoadingStatus(`${progressLabel} — extracting comps…`);

        const outcome = await extractCompsFromFile(file);
        outcomes.push({ file: file.name, outcome });

        if (outcome.kind === 'ok') {
          setLoadingStatus(
            `${progressLabel} — saving ${outcome.comps.length} comp${outcome.comps.length === 1 ? '' : 's'}…`
          );
          for (const comp of outcome.comps) {
            const ok = await saveCompSilent(comp);
            if (ok) savedCount++;
          }
        }

        // Stream a one-line per-file outcome into the chat as each
        // file finishes. The broker sees a running log instead of a
        // single batch summary at the end — much more reassuring on
        // a 6-file import that takes 2-3 minutes total.
        const line =
          outcome.kind === 'ok'
            ? `✓ ${file.name} — saved ${outcome.comps.length} comp${outcome.comps.length === 1 ? '' : 's'}`
            : outcome.kind === 'no_comps'
              ? `⚠ ${file.name} — no comps extracted`
              : outcome.kind === 'render_failed'
                ? `✗ ${file.name} — could not render PDF`
                : outcome.kind === 'http_error'
                  ? `✗ ${file.name} — server error (HTTP ${outcome.status})`
                  : `✗ ${file.name} — network error`;
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: line, timestamp: new Date().toISOString() },
        ]);
      }
    } finally {
      // Always clear, even on uncaught error mid-batch
      setLoading(false);
      setLoadingStatus(null);
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
            {failedCount > 0 && <span className="text-amber-600"> ({failedCount} issue{failedCount === 1 ? '' : 's'} — see chat log)</span>}.{' '}
            <button
              onClick={() => {
                toast.dismiss(t.id);
                router.push('/dashboard/vault');
              }}
              className="underline font-semibold text-olive-2"
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

  // ─── Boundary-aware extraction (Phase 1 of the extractor rebuild) ───
  //
  // Previously the only path for multi-page PDFs was extractFromChunkedPdf
  // (fixed-stride overlapping chunks → AI does boundary detection + field
  // extraction + aerial attribution all at once). That bundled three jobs
  // into one prompt and produced compounding failures:
  //   • Missing comps when boundaries fell between chunk strides
  //   • Wrong field values when narrative paragraphs competed with structured
  //     table rows for the AI's attention
  //   • Wrong thumbnails when overlapping-chunk page numbering broke the
  //     aerial → comp attribution
  //
  // This new path runs detectCompBoundaries() FIRST — a deterministic
  // text scan that finds "Land Sale N" / "Sale No N" / "Comparable N"
  // headers and builds a page-by-comp map without any AI involvement. Then:
  //
  //   1. For each detected comp, we send ONLY THAT COMP'S PAGES to the
  //      AI with a focused prompt ("extract this single comp from these
  //      pages"). No chunking, no overlap, no boundary risk.
  //   2. Aerial extraction is attributed by comp-scoped page range — each
  //      aerial belongs to exactly one comp, eliminating cross-attribution.
  //   3. No dedup needed in the output (we know we're sending one comp at
  //      a time), so the over-aggressive fragment-skip rule that dropped
  //      legit comps in the chunked path doesn't apply here.
  //
  // Falls back to extractFromChunkedPdf if boundary detection returns null
  // (PDF text layer unreadable, <2 comps detected, or non-monotonic
  // boundaries indicating a misread) — so we never regress against the
  // legacy behavior for PDFs the new detector can't handle yet.
  const extractFromBoundaryMap = async (
    file: File,
    images: string[],
    compMap: CompMap,
  ) => {
    // Kick off aerial extraction in parallel with AI calls — same pattern
    // as the chunked path. We'll attribute per-page after all AI calls land.
    const aerialsPromise = extractLargestAerialPerPage(file).catch(
      () => [] as Array<{ page: number; dataUrl: string }>
    );

    const userMessage: Message = {
      role: 'user',
      content:
        `[Document uploaded]\n` +
        `Uploaded: ${file.name} (${images.length} pages, ${compMap.comps.length} comp boundaries detected)`,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMessage]);

    const allComps: any[] = [];
    let errorCount = 0;
    const perCompCounts: number[] = [];

    for (let compIdx = 0; compIdx < compMap.comps.length; compIdx++) {
      const compBoundary = compMap.comps[compIdx];
      // Slice images to this comp's pages (boundary uses 1-indexed pages,
      // images array is 0-indexed).
      const compImages = compBoundary.pages
        .map((p) => images[p - 1])
        .filter((img): img is string => Boolean(img));

      if (compImages.length === 0) {
        console.warn(`[boundary] comp ${compIdx + 1} has no images; skipping`);
        perCompCounts.push(0);
        continue;
      }

      const toastId = `comp-${compIdx}`;
      const pageRange = compBoundary.pages.length === 1
        ? `page ${compBoundary.pages[0]}`
        : `pages ${compBoundary.pages[0]}-${compBoundary.pages[compBoundary.pages.length - 1]}`;
      toast.loading(`Extracting ${compBoundary.label} (${pageRange})…`, { id: toastId });

      try {
        const focusedPrompt =
          `[Document uploaded]\n` +
          `Extract EXACTLY ONE comparable land sale from these pages. ` +
          `The document title for this comp is "${compBoundary.label}"${
            compBoundary.saleId ? ` (Sale ID: ${compBoundary.saleId})` : ''
          }. ` +
          `These ${compBoundary.pages.length} page(s) contain ONE comp's full data — ` +
          `the Property Identification table, Transaction Data table, Property ` +
          `Description, and Remarks. Do NOT split this into multiple comps.\n\n` +
          // Hard rules — same priority order the rebuild plan calls for.
          // (1) Structured tables always win over narrative paragraphs for
          // numeric fields. (2) Required fields must be populated when the
          // source has them. (3) Never fabricate; null is better than wrong.
          `EXTRACTION RULES (in priority order):\n` +
          `1. For numeric fields (acres, sale_price, price_per_acre), ` +
          `   ALWAYS prefer values from STRUCTURED TABLE ROWS over narrative ` +
          `   prose. Example: if the "Gross Acres" row says 344.96 and the ` +
          `   Remarks paragraph says "349.7 acres in size", use 344.96.\n` +
          `2. The "Geographic Location" row (semicolon-separated lat;lng like ` +
          `   "29.81340027; -98.32949829") is the AUTHORITATIVE coordinate ` +
          `   source. If present, populate latitude + longitude from it. Do ` +
          `   not skip this field — it's structured data, always reliable.\n` +
          `3. Required: acres, sale_price, sale_date, grantor, grantee, ` +
          `   county. If a required field is genuinely absent from the source, ` +
          `   leave it null (do not fabricate or infer).\n` +
          `4. is_comparable=true unless this is clearly NOT a land sale.\n` +
          `5. Return exactly ONE comp in the comps array.`;

        const response = await fetch('/api/import-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: focusedPrompt }],
            images: compImages,
          }),
        });
        toast.dismiss(toastId);

        if (!response.ok) {
          errorCount++;
          perCompCounts.push(0);
          console.warn(`[boundary] ${compBoundary.label} HTTP ${response.status}`);
          continue;
        }

        const data = await response.json();
        const compsReturned: any[] = Array.isArray(data.comps) ? data.comps : [];
        if (compsReturned.length === 0) {
          perCompCounts.push(0);
          console.log(`[boundary] ${compBoundary.label}: 0 comps (AI: ${data.message?.slice(0, 80)})`);
          continue;
        }

        // We told the AI to return exactly one — take the first if it
        // returned multiple (defensive — shouldn't happen given the prompt).
        const comp = compsReturned[0];
        // Tag the comp with its boundary metadata for downstream debugging
        // and for confident aerial attribution. _boundary_pages is the
        // canonical page range for THIS comp; aerial attribution uses it
        // to pick the largest image from this range only.
        comp._boundary_pages = compBoundary.pages;
        comp._boundary_label = compBoundary.label;
        comp._boundary_sale_id = compBoundary.saleId;
        allComps.push(comp);
        perCompCounts.push(1);
        console.log(`[boundary] ${compBoundary.label}: extracted (pages ${compBoundary.pages.join(',')})`);
      } catch (e: any) {
        toast.dismiss(toastId);
        errorCount++;
        perCompCounts.push(0);
        console.error(`[boundary] ${compBoundary.label} threw:`, e);
      }
    }

    // ─── Per-comp aerial attribution ─────────────────────────────────
    // Each comp's aerial is drawn ONLY from its own page range — no
    // cross-attribution possible. Within range, we pick the largest
    // image (by dataUrl length, a reliable proxy for pixel area) since
    // the comp's primary aerial photo is invariably bigger than any
    // small map / icon / logo on the same page.
    //
    // SUBJECT-PROPERTY FILTER: before per-comp picking, exclude any
    // image that appears on ≥3 pages across the full document. Those
    // are subject-property aerials or letterhead graphics — present on
    // every page as a reference, NOT a comp aerial. Without this
    // filter, a 2-page comp whose pages both contain the subject's
    // repeated reference image would pick that reference as its
    // "largest" instead of the actual unique comp aerial.
    //
    // FIELD NAME: writes c.aerialImage (camelCase), which matches what
    // the verification UI and the save path BOTH read. A long-standing
    // bug had this writing c.aerial_image (snake) — the value was
    // immediately lost. Fixed.
    const aerialsPerPage = await aerialsPromise;

    // Build a set of "appears 3+ times" fingerprints to exclude.
    const aerialFingerprint = (url: string): string => {
      let hash = 0x811c9dc5;
      for (let i = 0; i < url.length; i++) {
        hash ^= url.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16);
    };
    const fpFrequency = new Map<string, number>();
    for (const a of aerialsPerPage) {
      const fp = aerialFingerprint(a.dataUrl);
      fpFrequency.set(fp, (fpFrequency.get(fp) || 0) + 1);
    }
    const subjectFps = new Set<string>();
    fpFrequency.forEach((count, fp) => {
      if (count >= 3) subjectFps.add(fp);
    });
    const compAerials = aerialsPerPage.filter(
      (a) => !subjectFps.has(aerialFingerprint(a.dataUrl))
    );
    if (subjectFps.size > 0) {
      console.log(
        `[boundary] filtered out ${subjectFps.size} repeating image(s) ` +
        `(subject/letterhead): ${aerialsPerPage.length} → ${compAerials.length}`
      );
    }

    let aerialsAttached = 0;
    for (const c of allComps) {
      const compPages: number[] = c._boundary_pages || [];
      if (compPages.length === 0) continue;
      const inRange = compAerials.filter((a) => compPages.includes(a.page));
      if (inRange.length === 0) continue;
      const biggest = inRange.reduce((best, a) =>
        a.dataUrl.length > best.dataUrl.length ? a : best
      );
      c.aerialImage = biggest.dataUrl;            // camelCase to match readers
      c._aerial_page = biggest.page;
      c._aerial_source = 'boundary-scoped';
      aerialsAttached++;
    }
    console.log(
      `[boundary] aerial attribution: ${aerialsAttached}/${allComps.length} comps ` +
      `got thumbnails (${aerialsPerPage.length} aerials total, ${compAerials.length} after subject filter)`
    );

    // ─── Phase 2a sanity layer (runs BEFORE auto-locate) ─────────────
    // Catches AI-hallucinated coords (out-of-Texas bbox), math mismatches
    // between acres × PPA and sale_price, future-dated sales, and
    // required-field gaps. Nulls out clearly-bad lat/lng so auto-locate
    // takes over. Flags everything else for review (Phase 3 will surface
    // the warnings in the UI; today they live in console + _sanity_warnings).
    {
      const sanityResult = sanitizeExtractedBatch(allComps);
      console.log(
        `[boundary] sanity: ${allComps.length} comps checked, ` +
        `${sanityResult.totalWarnings} warnings, ${sanityResult.errorCount} errors`
      );
      // Mutate the array in place (we want the sanitized values to flow
      // through the rest of the pipeline).
      for (let i = 0; i < sanityResult.comps.length; i++) {
        allComps[i] = sanityResult.comps[i];
      }
    }

    // ─── Browser auto-locate (skip if AI extracted explicit coords) ──
    // Same pattern as the chunked path. The new extraction rules tell the
    // AI to always pull "Geographic Location" lat/lng when present, so
    // most comps from appraisal-style PDFs land here with coords already.
    // Sanity layer above will have nulled coords if they were outside TX
    // — those comps fall through to the locator chain here.
    for (let i = 0; i < allComps.length; i++) {
      const c = allComps[i];
      if (c.latitude != null && c.longitude != null) {
        console.log(`[boundary] ${c.property_name || c._boundary_label}: explicit doc coords (${c.latitude}, ${c.longitude})`);
        continue;
      }
      try {
        const located = await locateCompForImport(c);
        if (located) {
          allComps[i] = {
            ...c,
            latitude: located.latitude,
            longitude: located.longitude,
            parcel_id: located.parcel_id ?? c.parcel_id,
            geometry: located.geometry,
            _auto_located_confidence: located.match_confidence,
          };
        }
      } catch (e) {
        console.error(`[boundary] autoLocate failed for ${c.property_name}:`, e);
      }
    }

    // ─── Path telemetry ──────────────────────────────────────────────
    // Tag every comp with which extraction path produced it. Useful for
    // A/B comparing accuracy between the boundary-aware and legacy
    // chunked paths over real broker usage. The field is transient
    // (underscore-prefixed) so it never lands in the DB.
    for (const c of allComps) {
      (c as any)._extraction_path = 'boundary';
    }

    // Dedupe against existing vault comps (same helper as chunked path).
    await runDuplicateCheck(allComps, supabase);

    // Auto-save — same pattern. Every comp lands as needs-review.
    if (allComps.length > 0) {
      await autoSaveExtracted(allComps);
    }

    // ─── Phase 2c source-document attachment (boundary path) ─────────
    // Upload the source PDF once and write one comp_documents row per
    // saved comp pointing back at the upload + its page range. Runs
    // AFTER autoSaveExtracted so we have the inserted comp UUIDs.
    // Boundary path always knows per-comp page ranges (compMap.comps[i].pages)
    // and the doc is by definition appraisal-shaped (that's what
    // boundary detection fires on).
    //
    // Fail-soft: if upload or attach fails (missing bucket, RLS, env
    // var miss), we log and continue. Comps still saved; only the
    // provenance link is missing — not a blocker for the broker.
    if (allComps.length > 0) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const saved = allComps.filter((c) => (c as any)._savedId);
          if (saved.length > 0) {
            const upload = await uploadSourceDocument({ file, userId: user.id });
            if (upload) {
              const pageRangeByCompId: Record<string, { start: number; end: number } | null> = {};
              for (const c of saved) {
                const pages: number[] = (c as any)._boundary_pages || [];
                if (pages.length > 0) {
                  pageRangeByCompId[(c as any)._savedId] = {
                    start: pages[0],
                    end: pages[pages.length - 1],
                  };
                }
              }
              await attachSourceDocumentToComps({
                compIds: saved.map((c) => (c as any)._savedId),
                upload,
                pageRangeByCompId,
                docType: 'appraisal',
                userId: user.id,
              });
            }
          }
        }
      } catch (e) {
        console.error('[boundary] source-document attach failed:', e);
      }
    }

    // Internal-only per-comp count log. The broker doesn't need to see
    // "Land Sale 1: 1 · Land Sale 2: 0 · Boundary confidence: high" —
    // that's developer telemetry. Logged to console for diagnosis;
    // broker sees a clean summary below.
    console.log(
      `[boundary] per-comp counts: ${compMap.comps
        .map((c, i) => `${c.label}: ${perCompCounts[i] || 0}`)
        .join(' · ')} (confidence: ${compMap.overallConfidence})`
    );

    const summary = allComps.length === 0
      ? `We couldn't extract any comps from this document. The PDF may be a scan without selectable text, or in a format we don't yet recognize. Try re-uploading, or paste the comp details directly into chat.`
      : `Extracted ${allComps.length} comp${allComps.length === 1 ? '' : 's'} from ${file.name}. Each is in your vault under Needs Review — open any to verify the details.`;

    const assistantMessage: Message = {
      role: 'assistant',
      content: summary,
      comps: allComps,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, assistantMessage]);

    if (allComps.length > 0) {
      setPendingComps(prev => [...prev, ...allComps]);
      toast.success(
        `Saved ${allComps.length} comp${allComps.length === 1 ? '' : 's'} to your vault`,
        { duration: 4000 }
      );
    } else {
      toast.error('No comps extracted from this document');
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
    //
    // ⚠️ Aerial extraction: kick this off in PARALLEL with the AI
    // chunks. Previously this path NEVER extracted aerials — only
    // sendMessage (≤5 page path) did — so every 6+ page upload lost
    // its thumbnails silently. Same per-page extractor as the
    // single-shot path, same attribution helper after dedupe.
    const aerialsPromise = extractLargestAerialPerPage(file).catch(
      () => [] as Array<{ page: number; dataUrl: string }>
    );

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
              content:
                `[Document uploaded]\n` +
                `Extract any comparable land sales visible on these pages. ` +
                `This is part ${chunkIdx + 1} of ${chunks.length} of a multi-page appraisal report.\n\n` +
                // Chunk-context guard: appraisal PDFs span 2 pages per comp
                // (aerial+ID on page N, REMARKS on page N+1). With overlapping
                // chunks the AI sometimes sees ONLY the REMARKS half and
                // fabricates a comp out of it — same property name + acres,
                // every other field null. The fragment then survives dedupe
                // because nulls don't match the full comp's key. Tell the AI
                // explicitly to skip these — the next chunk will catch the
                // same comp complete.
                `CRITICAL — only extract a comp if you can see BOTH the aerial/identification ` +
                `section AND structured transaction data (sale price, sale date, OR ` +
                `grantor/grantee names) on these pages. If you only see a property ` +
                `description / REMARKS / narrative paragraph for a sale WITHOUT the ` +
                `accompanying transaction table, DO NOT return that as a comp — it's a ` +
                `tail-end fragment from the previous chunk and the comp will be captured ` +
                `completely in another chunk. Return an empty comps array for such ` +
                `fragments.`,
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

    // ─── Two-pass dedupe ─────────────────────────────────────────────
    //
    // Pass 1 (PRIMARY KEY — exact match on transactional identity):
    //   key = property_name | grantee | sale_date | sale_price
    //   This collapses the same comp seen in multiple overlapping chunks
    //   when BOTH copies have the transactional fields populated.
    //
    // Pass 2 (SECONDARY KEY — semantic match on physical identity):
    //   key = county | round(acres, 1dp)
    //   Catches the failure mode where one chunk sees the full comp and
    //   another chunk sees ONLY the REMARKS half (no sale_date,
    //   sale_price, grantor, grantee — so the primary key differs). The
    //   fragment has the same acres + county; merge into the populated
    //   sibling, preferring the version with more transactional fields.
    //
    // Without pass 2, the user got a phantom 4th comp from a 3-comp PDF:
    // Land Sale 2 (141.88 ac) showed up twice — once fully populated,
    // once as REMARKS-only with all other fields null.
    const compleness = (c: any): number => {
      // Score of how "complete" a comp is. Higher = more fields populated.
      // Used to pick which copy wins when two comps collide.
      let s = 0;
      if (c.sale_price && Number(c.sale_price) > 0) s += 4;
      if (c.sale_date) s += 3;
      if (c.grantee) s += 2;
      if (c.grantor) s += 2;
      if (c.address) s += 1;
      if (c.property_name) s += 1;
      if (c.geometry) s += 2;
      if (c.latitude != null) s += 1;
      return s;
    };

    // Pass 1: exact-match dedupe.
    const byKey = new Map<string, any>();
    for (const c of allComps) {
      const key = `${(c.property_name || '').toLowerCase().trim()}|${(c.grantee || '').toLowerCase().trim()}|${c.sale_date || ''}|${c.sale_price || 0}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, c);
        continue;
      }
      // Pick the more complete record, with geometry/coords as a tiebreaker.
      const newScore = compleness(c);
      const oldScore = compleness(existing);
      if (newScore > oldScore) byKey.set(key, c);
    }
    let dedupedComps = Array.from(byKey.values());

    // Pass 2: collapse chunk-overlap fragments by (county | acres-to-0.1).
    // Iterate sorted by completeness DESC so the populated copy lands in
    // the map first and the fragment gets dropped (not the reverse).
    const sorted = [...dedupedComps].sort((a, b) => compleness(b) - compleness(a));
    const bySemantic = new Map<string, any>();
    for (const c of sorted) {
      const acres = Number(c.acres);
      if (!Number.isFinite(acres) || acres <= 0 || !c.county) {
        // Can't form a semantic key — keep as-is, push under a unique-by-ref key.
        bySemantic.set(`__nokey_${bySemantic.size}`, c);
        continue;
      }
      const semKey = `${String(c.county).toLowerCase().trim()}|${acres.toFixed(1)}`;
      const existing = bySemantic.get(semKey);
      if (!existing) {
        bySemantic.set(semKey, c);
        continue;
      }
      // Both have same county+acres. The richer one already won the slot
      // (we sorted DESC by completeness). This second one is the fragment
      // — drop it. Log so we can spot recurring patterns.
      console.warn(
        `[chunked] dropped chunk-overlap fragment: ${acres}ac ${c.county} ` +
        `(completeness ${compleness(c)} vs winner ${compleness(existing)}). ` +
        `Fragment description: "${(c.description || '').slice(0, 60)}..."`
      );
    }
    dedupedComps = Array.from(bySemantic.values());

    // Pass 3: drop hollow comps. A comp with NONE of {sale_price, sale_date,
    // grantor, grantee} is almost certainly a chunk fragment that escaped
    // pass 2 (e.g., AI got the acres wrong by a hair so the semantic key
    // didn't match). Better to drop than to show the broker a phantom row.
    const hollowDropped: any[] = [];
    dedupedComps = dedupedComps.filter((c) => {
      const hasAny = (c.sale_price && Number(c.sale_price) > 0) ||
        c.sale_date || c.grantor || c.grantee;
      if (!hasAny) {
        hollowDropped.push(c);
        return false;
      }
      return true;
    });
    if (hollowDropped.length > 0) {
      console.warn(
        `[chunked] dropped ${hollowDropped.length} hollow comp${hollowDropped.length === 1 ? '' : 's'} ` +
        `with no sale_price / sale_date / grantor / grantee — likely chunk fragments. ` +
        `Acres: ${hollowDropped.map((c) => c.acres).join(', ')}`
      );
    }

    if (dedupedComps.length < allComps.length) {
      console.log(`[chunked] deduped: ${allComps.length} raw → ${dedupedComps.length} unique`);
    }

    // Attach the per-page aerials that were extracted in parallel with
    // the AI chunks. Same helper the ≤5-page path uses, so improvements
    // to attribution heuristics apply everywhere automatically.
    const aerialsPerPage = await aerialsPromise;
    const sourceAerialForAttribution: string | null | Array<{ page: number; dataUrl: string }> =
      aerialsPerPage.length === 0
        ? null
        : aerialsPerPage.length === 1
          ? aerialsPerPage[0].dataUrl
          : aerialsPerPage;
    const { attached, missed } = attachAerialsToComps(
      dedupedComps,
      sourceAerialForAttribution,
    );
    if (dedupedComps.length > 0) {
      console.log(
        `[chunked] aerial attribution: ${attached}/${dedupedComps.length} comps got thumbnails ` +
        `(${aerialsPerPage.length} aerials found across ${images.length} pages)`
      );
      if (missed > 0 && aerialsPerPage.length === 0) {
        console.warn(
          `[chunked] no aerials found in PDF — embedded images may be smaller than ` +
          `MIN_IMAGE_DIMENSION (200px), or the PDF stores pages as flattened scans ` +
          `(JBIG2/grayscale) which the extractor skips. ${missed} comp${missed === 1 ? '' : 's'} ` +
          `will show without a source thumbnail.`
        );
      }
    }

    // ─── Phase 2a sanity layer (runs BEFORE auto-locate) ─────────────
    // Same checks as the boundary path: out-of-Texas lat/lng nulled,
    // math gates flag drift, required fields tagged. See
    // src/lib/utils/extractionSanity.ts for the full rule set.
    {
      const sanityResult = sanitizeExtractedBatch(dedupedComps);
      console.log(
        `[chunked] sanity: ${dedupedComps.length} comps checked, ` +
        `${sanityResult.totalWarnings} warnings, ${sanityResult.errorCount} errors`
      );
      for (let i = 0; i < sanityResult.comps.length; i++) {
        dedupedComps[i] = sanityResult.comps[i];
      }
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
        // Parcel match first, address-geocode fallback for MLS-style
        // comps with no owner-name parcel hit.
        const located = await locateCompForImport(c);
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

    // ─── Path telemetry ──────────────────────────────────────────────
    // Tag every comp with which extraction path produced it. Useful for
    // A/B comparing accuracy between the boundary-aware and legacy
    // chunked paths over real broker usage. The field is transient
    // (underscore-prefixed) so it never lands in the DB.
    for (const c of dedupedComps) {
      (c as any)._extraction_path = 'chunked';
    }

    // Per-chunk diagnostic — KEPT INTERNAL ONLY. Used to live in the
    // user-facing chat message as `\n\nPer-chunk: pp1-4: 0 (HTTP 504)…`,
    // which is developer-grade telemetry that has no business in a
    // broker-facing UI. Now logged to the console for debugging and
    // never surfaced. The user-visible summary (below) stays cleanly
    // worded regardless of which chunks errored.
    if (perChunkCounts.length > 0) {
      const internalBreakdown = perChunkCounts
        .map((n, i) => {
          const sp = i * STRIDE + 1;
          const ep = Math.min(i * STRIDE + CHUNK_SIZE, images.length);
          return `pp${sp}-${ep}: ${n}${perChunkMessages[i] && n === 0 ? ` (${perChunkMessages[i]})` : ''}`;
        })
        .join(' · ');
      console.log(`[chunked] per-chunk results: ${internalBreakdown}`);
    }
    const chunkBreakdown = ''; // intentionally empty — see comment above

    // Dedupe vs existing vault comps — same helper the single-shot
    // path uses (PR #45). Previously absent from this path, so
    // re-imports of long PDFs silently created copies without the
    // "Possible duplicate of:" banner. Tags each match-found comp
    // with _duplicates so the verification card renders the banner.
    await runDuplicateCheck(dedupedComps, supabase);

    // Auto-save on extraction (PR #45) — every extracted comp lands
    // in the vault immediately with needs_location_review=true so
    // the broker can never lose work by closing the tab or skipping
    // the verification step. The verification cards become a
    // refinement surface, not a save surface. Discard / Delete
    // buttons on each card handle the cleanup paths.
    if (dedupedComps.length > 0) {
      await autoSaveExtracted(dedupedComps);
    }

    // ─── Phase 2c source-document attachment (chunked path) ──────────
    // Mirror of the boundary path's hook, with two differences:
    //   • Page range is null per comp — chunked extraction can't
    //     reliably say which pages each comp came from once dedupe
    //     has merged near-duplicates across overlapping chunks.
    //   • doc_type is null (unclassified). A future classifier in
    //     Phase 2c.1 can backfill these rows by reading the PDF text.
    if (dedupedComps.length > 0) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const saved = dedupedComps.filter((c) => (c as any)._savedId);
          if (saved.length > 0) {
            const upload = await uploadSourceDocument({ file, userId: user.id });
            if (upload) {
              await attachSourceDocumentToComps({
                compIds: saved.map((c) => (c as any)._savedId),
                upload,
                pageRangeByCompId: undefined,
                docType: null,
                userId: user.id,
              });
            }
          }
        }
      } catch (e) {
        console.error('[chunked] source-document attach failed:', e);
      }
    }

    // Broker-facing summary. Intentionally clean — no chunk counts,
    // no HTTP status mentions, no per-section error breakdowns. The
    // broker only needs to know: how many comps came through, where
    // they are now, and what to do next.
    const summary = dedupedComps.length === 0
      ? `We couldn't extract any comps from this document. The PDF may be a scan without selectable text, or in a format we don't yet recognize. Try re-uploading, or paste the comp details directly into chat.`
      : `Extracted ${dedupedComps.length} comp${dedupedComps.length === 1 ? '' : 's'} from ${file.name}. Each is in your vault under Needs Review — open any to verify the details.`;

    const assistantMessage: Message = {
      role: 'assistant',
      content: summary,
      comps: dedupedComps,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, assistantMessage]);

    if (dedupedComps.length > 0) {
      setPendingComps(prev => [...prev, ...dedupedComps]);
      toast.success(`Saved ${dedupedComps.length} comp${dedupedComps.length === 1 ? '' : 's'} to your vault`, { duration: 4000 });
    } else {
      toast.error('No comps extracted from this document');
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // Claude PDF route — the new default for all PDF imports.
  //
  // Replaces the legacy client-side pdf.js → vision-classifier →
  // chunked-extraction pipeline. Solves two production-confirmed bugs
  // in one move:
  //
  //   1. 60+ page appraisals hung at "Rendering PDF pages…" forever
  //      because Safari throttled the tab while pdf.js held every
  //      rendered page image in browser memory. Confirmed June 17 on
  //      the Thorndale 71-page appraisal — 10 minutes of stuck spinner
  //      before the broker gave up.
  //
  //   2. Fritz Farm's improvements_value came back as $190k (the hay
  //      barn alone) and silently dropped the $575k irrigation system.
  //      The legacy prompt didn't require an improvements_value_source
  //      citation, so the model could be vague about which dollar figure
  //      it picked. The Claude route's tool schema makes that citation
  //      mandatory and the system prompt explicitly teaches Claude that
  //      irrigation/wells/fencing are improvements (not just structures).
  //
  // PDF bytes go straight from the browser to /api/import-pdf-claude
  // (no client-side render), which forwards base64 to Anthropic and
  // returns the SAME { message, comps, diagnostic } shape that the
  // legacy /api/import-chat returns. We then run the SAME
  // post-extraction pipeline that sendMessage runs after the fetch
  // (browser-side auto-locate, dedupe, auto-save, push to chat).
  // ═══════════════════════════════════════════════════════════════════
  const processPdf = async (file: File) => {
    const userMessage: Message = {
      role: 'user',
      content: `[Document uploaded]\n${file.name}`,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setLoading(true);
    // User-facing copy stays Landstack-branded — implementation
    // details (which engines we use, how we route) live in server
    // logs + the diagnostic block, not in the broker's UI.
    setLoadingStatus('Reading your document…');

    // 95-second client cap. Server's own AbortController fires at 90s,
    // Vercel kills the function at 120s. The client's 95 leaves a
    // narrow gap to receive the server's clean "timeout" response
    // rather than racing the network and showing a generic abort.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 95_000);

    try {
      const formData = new FormData();
      formData.append('file', file);

      // Orchestrator runs GPT (primary, preserves months of broker-tested
      // prompt) + Claude (shadow, instant fallback) in parallel. The
      // broker sees ONE result — whichever passed the failure-condition
      // ladder. Both engines write to extraction_runs telemetry for the
      // long-term comparison data we'll use to build an evidence-based
      // router (~30-60 days from now).
      const response = await fetch('/api/import-pdf-orchestrator', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      const data = await response.json();

      if (!response.ok || !Array.isArray(data.comps)) {
        toast.error(data?.message || 'Failed to extract from PDF');
        const errorMessage: Message = {
          role: 'assistant',
          content:
            data?.message ||
            "Couldn't read this PDF. Try a different file or split it into smaller sections.",
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errorMessage]);
        return;
      }

      // Browser-side auto-locate for comps Claude didn't already pin.
      // Most appraisal comp sheets include an explicit "Geographic
      // Location" lat/lng (Thorndale: every comp had one); we keep
      // those as-is. Only comps without coords run through the parcel
      // matcher.
      if (data.comps.length > 0) {
        setLoadingStatus(
          `Locating ${data.comps.length} ${data.comps.length === 1 ? 'property' : 'properties'} on the map…`,
        );
        for (let i = 0; i < data.comps.length; i++) {
          const c = data.comps[i];
          const label = c.property_name || c.county || 'comp';
          if (c.latitude != null && c.longitude != null) {
            console.log(
              `[import-claude] ${label}: AI-extracted coords (${c.latitude}, ${c.longitude}) — skipping auto-locate`,
            );
            continue;
          }
          try {
            const located = await locateCompForImport(c);
            if (located) {
              console.log(`[import-claude] auto-locate ✓ ${label}: ${located.match_reason}`);
              toast.success(`📍 ${label}: ${located.match_reason}`, { duration: 8000 });
              data.comps[i] = {
                ...c,
                latitude: located.latitude,
                longitude: located.longitude,
                parcel_id: located.parcel_id ?? c.parcel_id,
                geometry: located.geometry,
                _auto_located_confidence: located.match_confidence,
              };
            }
          } catch (e: any) {
            console.error(`[import-claude] auto-locate threw for ${label}:`, e);
          }
        }
      }

      // Dedupe vs the user's existing vault.
      if (data.comps.length > 0) {
        setLoadingStatus('Checking your vault for duplicates…');
        await runDuplicateCheck(data.comps, supabase);
        await autoSaveExtracted(data.comps);
      }

      const assistantMessage: Message = {
        role: 'assistant',
        content:
          data.message ||
          (data.comps.length === 0
            ? 'No comparable sales found in this document.'
            : `Extracted ${data.comps.length} ${data.comps.length === 1 ? 'comp' : 'comps'} from your PDF.`),
        comps: data.comps,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMessage]);

      if (data.comps.length > 0) {
        setPendingComps((prev) => [...prev, ...data.comps]);
      }

      // Telemetry — log timing + token usage server-returned in diagnostic.
      if (data.diagnostic) {
        console.log(
          `[import-claude] ${file.name} · ${data.comps.length} comps in ` +
            `${(data.diagnostic.elapsed_ms / 1000).toFixed(1)}s · ` +
            `tokens in=${data.diagnostic.input_tokens} out=${data.diagnostic.output_tokens}`,
        );
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        toast.error(
          'PDF extraction took longer than 90 seconds and was cancelled. Try splitting the PDF into smaller sections.',
        );
        const errorMessage: Message = {
          role: 'assistant',
          content:
            'That PDF took too long to process and was cancelled. If it has a separate Sales Comparison section, try uploading just those pages.',
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      } else {
        console.error('[import-claude] error:', error);
        toast.error(error?.message || 'Failed to process PDF');
      }
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
      setLoadingStatus(null);
    }
  };

  const handleFileUpload = async (file: File) => {
    if (!file) return;
    setLoading(true);

    try {
      // PDFs: route to Claude (server-side, no client render). Bypasses
      // the legacy pdf.js render path entirely — fixes the Safari stall
      // bug AND the improvements_value undercount bug in one move.
      // See processPdf above for the full rationale.
      if (file.type === 'application/pdf') {
        setLoading(false); // processPdf manages its own loading state
        await processPdf(file);
        return;
      }

      // Legacy client-side PDF render + vision-classifier pipeline was
      // removed when /api/import-pdf-claude went live. If Claude ever
      // needs a fallback (outage, schema regression, etc.), recover the
      // full pdfToImages → detectCompBoundariesViaVision →
      // extractFromBoundaryMap → extractFromChunkedPdf chain from git
      // history — any commit before the Claude route landed has it.
      // extractFromBoundaryMap, extractFromChunkedPdf, pdfToImages,
      // extractLargestAerialPerPage, detectCompBoundariesViaVision,
      // detectCompBoundaries are still defined elsewhere in this file
      // for batch-upload paths that haven't been migrated yet.

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

  // URL detection — broker pastes a single listing URL (LERA/ConnectMLS,
  // LandWatch, brokerage sites, etc.). Different flow than text paste:
  // server-side fetch + structured HTML parse + AI extraction via the
  // /api/import-url endpoint. Returns a single comp, not a batch.
  const isLikelyUrl = (text: string): boolean => {
    const trimmed = text.trim();
    // Single line with no surrounding prose
    if (trimmed.includes('\n') || trimmed.includes(' ')) return false;
    return /^https?:\/\/[^\s]+\.[^\s]+/i.test(trimmed);
  };

  // Single-URL listing import flow. Mirrors sendMessage's UX (user
  // message + assistant message with comps) but pulls from
  // /api/import-url and processes the single returned comp through the
  // auto-save + verification card pipeline. Errors surface as toasts +
  // an assistant message guiding the broker to download as PDF.
  const importFromUrl = async (url: string) => {
    const userMessage: Message = {
      role: 'user',
      content: url,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setLoading(true);
    setLoadingStatus(`Fetching listing from ${(() => { try { return new URL(url).hostname; } catch { return 'site'; } })()}…`);
    try {
      const res = await fetch('/api/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok || !data?.comp) {
        const hint = data?.hint || 'Try downloading the listing as a PDF and uploading that instead — some listing sites block automated fetches or render content with JavaScript.';
        const errMsg: Message = {
          role: 'assistant',
          content: `Couldn't read that link.\n\nReason: ${data?.error || 'unknown'}\n\n${hint}`,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errMsg]);
        toast.error('Listing fetch failed');
        return;
      }

      // Comp arrives partially-filled (listings rarely have sale_date,
      // grantor, grantee, recording number). Run dedupe + auto-save
      // through the same pipeline as PDF extraction so the verification
      // card behavior stays consistent.
      const comp = data.comp;
      const comps = [comp];

      await runDuplicateCheck(comps, supabase);
      await autoSaveExtracted(comps);

      const summary = comp?.needs_completion
        ? `Pulled a listing from ${comp.source_url ? new URL(comp.source_url).hostname : 'the link'}. Saved to your vault under Needs Review. Some fields the listing didn't include — finish them on the verification card.`
        : `Pulled a listing from ${comp.source_url ? new URL(comp.source_url).hostname : 'the link'}. Saved to your vault under Needs Review.`;
      const assistantMessage: Message = {
        role: 'assistant',
        content: summary,
        comps,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      setPendingComps((prev) => [...prev, ...comps]);
      toast.success('Listing saved to your vault');
    } catch (e: any) {
      const errMsg: Message = {
        role: 'assistant',
        content: `URL ingestion failed: ${e?.message || 'unknown error'}. Try downloading the page as a PDF and uploading that.`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errMsg]);
      toast.error(e?.message || 'URL ingestion failed');
    } finally {
      setLoading(false);
      setLoadingStatus(null);
    }
  };

  const handleSubmit = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    if (isLikelyUrl(trimmed)) {
      // URL path clears the input itself (mirrors sendMessage); the
      // chat box empties as soon as the user message is pushed.
      setInput('');
      await importFromUrl(trimmed);
    } else {
      await sendMessage(trimmed);
    }
  };

  // saveComp persists a comp to the vault. Caller controls intent via opts:
  //   needsReview: TRUE  → save flagged for follow-up (gray clock in vault)
  //                FALSE → save verified (no badge)
  //   silent: TRUE       → suppress toast + skip the "View on map" interaction.
  //                        Used when the caller is doing batch save + their
  //                        own navigation (e.g. the Needs review button which
  //                        parallel-saves all pending comps then navigates
  //                        same-tab itself).
  //                FALSE → show the normal success toast (with optional
  //                        "View on map" link for verified-with-pin comps).
  // When called without opts, defaults to verified + with-toast.

  // Auto-save every extracted comp to the vault immediately as
  // needs_location_review=true. PR #45 architectural shift: upload =
  // save. The verification cards become a refinement surface (verify,
  // open in review, discard, delete), not a save surface. Broker can
  // close the tab mid-import and find every comp under the vault's
  // "Needs Review" section.
  //
  // Each saved comp gets stamped with `_savedId` so subsequent actions
  // (verify / discard / delete) operate on the DB row instead of
  // creating duplicates. Mutates the input array in place.
  const autoSaveExtracted = async (comps: ExtractedComp[]): Promise<void> => {
    if (!Array.isArray(comps) || comps.length === 0) return;
    const results = await Promise.all(
      comps.map((c) => {
        // Skip comps already saved (e.g., from a prior auto-save in
        // the same session — extractFromChunkedPdf can run multiple
        // times if broker uploads more PDFs back to back).
        if ((c as any)._savedId) return Promise.resolve({ id: (c as any)._savedId });
        return saveComp(c, { needsReview: true, silent: true });
      })
    );
    comps.forEach((c, i) => {
      const id = results[i]?.id;
      if (id) (c as any)._savedId = id;
    });
  };

  const saveComp = async (
    comp: ExtractedComp,
    opts?: { needsReview?: boolean; silent?: boolean }
  ): Promise<{ id: string } | null> => {
    const needsReview = opts?.needsReview ?? false;
    const silent = opts?.silent ?? false;
    const hasPin = comp.latitude != null && comp.longitude != null;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const { data: inserted, error } = await supabase.from('comps').insert({
      created_by: user.id,
      property_name: comp.property_name,
      // Normalize to canonical storage form (titlecase, no "County" suffix,
      // compounds comma-separated). Replaces the raw AI-extracted string
      // which was inconsistent ("Frio" vs "Frio County" vs "frio").
      county: normalizeCountyForStorage(comp.county) || '',
      state: comp.state || 'TX',
      acres: comp.acres || 0,
      // Source citations from the AI extraction — where in the document
      // each numeric value came from. Surfaced on the verification card
      // + review page so brokers can audit at-a-glance. Migration 027
      // added these columns; safe to insert as null on older schemas
      // because the resilient saveComp retry strips unknown fields.
      acres_source: (comp as any).acres_source ?? null,
      sale_price: comp.sale_price || 0,
      sale_price_source: (comp as any).sale_price_source ?? null,
      // NOTE: price_per_acre and ppa_land_only are GENERATED ALWAYS AS
      // (...) STORED columns in Postgres — see migration 001 lines 52
      // and 68. The DB auto-computes them from sale_price + acres (and
      // improvements_value for the land-only variant). We CANNOT INSERT
      // values for them; Postgres rejects with "cannot insert a
      // non-DEFAULT value into column 'price_per_acre'" even when the
      // value is NULL. Only the *_source citation columns are writable.
      price_per_acre_source: (comp as any).price_per_acre_source ?? null,
      ppa_land_only_source: (comp as any).ppa_land_only_source ?? null,
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
      // Tier fields — sanitize against schema CHECK constraints. AI
      // can produce appraisal-language ("Paved", "County Road") that
      // would otherwise reject the INSERT.
      water: sanitizeWater(comp.water),
      road_frontage: sanitizeRoadFrontage(comp.road_frontage),
      // has_improvements backfill: if the AI extracted a non-zero
      // improvements_value but missed the boolean, force has_improvements
      // true. Otherwise we'd save a comp with a $400K improvements value
      // and no "Improved" badge — and worse, the land-only adjustment
      // would be hidden from the vault's Adjusted $/Ac column because
      // some UI surfaces still gate on has_improvements. Cheap belt-and-
      // suspenders that prevents a silent data inconsistency.
      has_improvements: Boolean(
        comp.has_improvements ||
        (Number(comp.improvements_value) > 0)
      ),
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
      // Persist the source aerial extracted from the original PDF so the
      // review page can render it later (as a side panel or as a
      // georeferenced overlay). NULL when no aerial was extracted —
      // multi-comp PDFs, text-only appraisals, or extraction failures.
      // See docs/DESIGN_DECISIONS.md §5 (review page architecture).
      aerial_image: (comp as any).aerialImage || null,
    }).select('id').single();

    if (error || !inserted) {
      // Surface the actual Supabase error so we can diagnose missing
      // columns / RLS issues / constraint failures from the toast directly
      // instead of generic "Failed to save comp". Console.error always
      // fires so the full error object is available in DevTools even
      // when the toast is suppressed (silent=true for bulk saves).
      const detail = error?.message
        || (error as any)?.details
        || (error as any)?.hint
        || 'unknown error';
      console.error('[saveComp] insert failed', {
        error,
        compPropertyName: comp.property_name,
        county: comp.county,
        hasLatLng: comp.latitude != null && comp.longitude != null,
      });
      if (!silent) toast.error(`Save failed: ${detail}`, { duration: 7000 });
      return null;
    } else {
      const label = comp.property_name || `${comp.county || 'Comp'}`;

      if (!silent) {
        if (needsReview) {
          // Toast-only confirmation — caller (the Needs review button) handles
          // navigation itself (parallel-saves other pending comps first, then
          // same-tab navigates so nothing's lost).
          toast.success(
            hasPin
              ? `${label} flagged for review`
              : `${label} added — needs location`,
            { duration: 2500 }
          );
        } else if (hasPin) {
          // "Looks right" path with a pin — keep the existing toast-with-link
          // pattern. Broker can ignore the toast or click "View on map".
          // The link itself uses an anchor target=_blank (rendered below as
          // a Link element since we're inside a toast.success render fn) so
          // Safari's popup blocker doesn't apply — anchor target=_blank is
          // browser-native navigation, not a programmatic popup.
          toast.success(
            (t) => (
              <span>
                {label} added to vault.{' '}
                <a
                  href={`/dashboard/map?focus=${comp.latitude},${comp.longitude},14`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => toast.dismiss(t.id)}
                  className="underline font-semibold text-olive-2 cursor-pointer"
                >
                  View on map →
                </a>
              </span>
            ),
            { duration: 6000 }
          );
        } else {
          toast.success(`${label} added to vault!`);
        }
      }

      setPendingComps(prev => prev.filter(c => c !== comp));
      return inserted;
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
    <div className="flex h-full bg-cream">
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
          <div className="absolute inset-0 z-50 bg-olive-tint backdrop-blur-sm border-4 border-dashed border-olive rounded-lg flex items-center justify-center pointer-events-none">
            <div className="text-center px-6">
              <Upload size={56} className="text-olive-2 mx-auto mb-3" />
              <p className="text-xl font-semibold text-olive-2">Drop PDFs to import</p>
              <p className="text-sm text-ink-2 mt-2">Multiple files supported · PDF or image</p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex-shrink-0 bg-white border-b border-beige px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-olive-tint border border-olive-border flex items-center justify-center">
            <FileText size={15} className="text-olive-2" />
          </div>
          <div>
            <h1 className="font-semibold text-sm">Import Comps</h1>
            <p className="text-xs text-ink-3">Upload PDF, paste text, or describe a property</p>
          </div>
          <div className="ml-auto flex gap-2">
            {/* Start fresh — only appears when there's a persisted session
                from a prior upload. Wipes the sessionStorage cache + clears
                local state so the next upload starts with a clean greeting.
                Without this, brokers stay parked on yesterday's extraction
                cards forever. */}
            {(messages.length > 1 || pendingComps.length > 0) && (
              <button
                onClick={() => {
                  try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
                  setMessages([{
                    role: 'assistant',
                    content: "Hi! I'm ready to help you import comps. Upload a PDF, paste text from an appraisal or closing statement, or share a property description. I'll extract the comparable sales data automatically.",
                    timestamp: new Date().toISOString(),
                  }]);
                  setPendingComps([]);
                  toast.success('Import session cleared', { duration: 1800 });
                }}
                title="Clear the current import session so you can start a new upload"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-cream border border-beige rounded-lg text-xs font-semibold text-ink-2 hover:text-ink hover:border-olive transition-colors"
              >
                <X size={12} />
                Start fresh
              </button>
            )}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-cream border border-beige rounded-lg text-xs font-semibold text-ink-2 hover:text-ink hover:border-olive transition-colors"
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
                  ? 'bg-olive-tint border border-olive-border text-ink'
                  : 'bg-cream border border-beige text-ink'
              }`}>
                {msg.role === 'assistant' && (
                  // Landstack AI badge — bumped to a readable 28px so the
                  // brand is recognizable in the chat stream. Bordered for
                  // definition, olive accent for brand identity.
                  <div className="flex items-center gap-2 mb-2.5">
                    <div className="w-7 h-7 rounded-md bg-olive-tint border border-olive-border flex items-center justify-center shadow-sm">
                      <span className="text-olive-2 text-[11px] font-bold tracking-tight">AI</span>
                    </div>
                    <span className="text-[13px] font-semibold text-olive-2 tracking-tight">Landstack AI</span>
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

                      const duplicates = (comp as any)._duplicates as DuplicateMatch[] | undefined;
                      const hasDuplicates = duplicates && duplicates.length > 0;
                      return (
                      <div key={ci} className="bg-cream border border-beige rounded-xl p-3">
                        {/* Duplicate-match warning — surfaces BEFORE the
                            comp details so the broker knows what they're
                            about to save is already in the vault. Lists
                            the existing match(es) and gives a one-click
                            Skip to drop this comp from the import batch. */}
                        {hasDuplicates && (
                          <div className="mb-3 bg-amber-50 border border-amber-500/60 rounded-lg p-2.5">
                            <div className="flex items-center gap-1.5 text-amber-600 text-xs font-bold mb-1.5">
                              <AlertTriangle size={12} />
                              {duplicates!.length === 1
                                ? 'Possible duplicate of:'
                                : `Possible duplicate of ${duplicates!.length} existing comp${duplicates!.length === 1 ? '' : 's'}:`}
                            </div>
                            <ul className="space-y-1 mb-2">
                              {duplicates!.slice(0, 3).map((m, di) => {
                                const savedDate = m.comp.created_at
                                  ? new Date(m.comp.created_at).toLocaleDateString()
                                  : '?';
                                return (
                                  <li key={di} className="text-[11px] text-amber-700">
                                    <span className="font-bold">
                                      {m.comp.property_name || `${m.comp.county || 'Comp'} ${m.comp.sale_date}`}
                                    </span>
                                    <span className="text-amber-700/70"> · saved {savedDate}</span>
                                    {m.confidence === 'exact' && (
                                      <span className="ml-1.5 text-[9px] uppercase tracking-wide text-amber-700/80 bg-amber-500/15 px-1 py-0.5 rounded">exact</span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                            <div className="flex items-center gap-2 pt-1 flex-wrap">
                              {/* MERGE — fills missing fields on the existing
                                  comp without overwriting anything the broker
                                  has already verified. The high-leverage path
                                  when you re-import an appraisal: existing
                                  row picks up the aerial, parcel_ids,
                                  description, coords, etc., and the duplicate
                                  row is never created. */}
                              <button
                                onClick={async () => {
                                  const existing = duplicates![0].comp;
                                  const patch = buildMergePatch(existing, comp);
                                  if (Object.keys(patch).length === 0) {
                                    toast('Nothing to merge — existing comp already has all these fields', { icon: 'ℹ️', duration: 3500 });
                                    return;
                                  }
                                  const { error } = await supabase
                                    .from('comps')
                                    .update(patch)
                                    .eq('id', existing.id);
                                  if (error) {
                                    toast.error(`Merge failed: ${error.message}`);
                                    return;
                                  }
                                  const fields = Object.keys(patch).length;
                                  toast.success(`Merged ${fields} field${fields === 1 ? '' : 's'} into ${existing.property_name || 'existing comp'}`);
                                  // Drop this comp from the import batch (same
                                  // as Skip) — it's been merged, not saved as
                                  // a new row.
                                  setMessages((prev) => prev.map((mm, mi) => {
                                    if (mi !== i || mm.role !== 'assistant' || !mm.comps) return mm;
                                    return { ...mm, comps: mm.comps.filter((_, idx) => idx !== ci) };
                                  }));
                                  setPendingComps((prev) =>
                                    prev.filter((p) => p !== comp)
                                  );
                                }}
                                className="px-2.5 py-1 bg-olive-tint hover:bg-olive-tint/80 border border-olive-border rounded text-[10px] font-bold text-olive-2 transition-colors"
                                title="Update the existing comp with any new info from this extraction (aerial, parcels, description) — only fills in missing fields, never overwrites"
                              >
                                Merge into existing
                              </button>
                              <button
                                onClick={() => {
                                  // Remove this comp from the message's comps array
                                  // so it doesn't get rendered or accidentally saved.
                                  setMessages((prev) => prev.map((mm, mi) => {
                                    if (mi !== i || mm.role !== 'assistant' || !mm.comps) return mm;
                                    return { ...mm, comps: mm.comps.filter((_, idx) => idx !== ci) };
                                  }));
                                  setPendingComps((prev) =>
                                    prev.filter((p) => p !== comp)
                                  );
                                  toast.success('Skipped duplicate');
                                }}
                                className="px-2 py-1 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 rounded text-[10px] font-bold text-amber-700 transition-colors"
                              >
                                Skip this
                              </button>
                              <button
                                onClick={() => router.push(`/dashboard/review/${duplicates![0].comp.id}`)}
                                className="px-2 py-1 border border-amber-500/30 hover:border-amber-500/60 rounded text-[10px] font-bold text-amber-700/80 hover:text-amber-700 transition-colors"
                              >
                                View existing
                              </button>
                              <span className="ml-auto text-[10px] text-amber-700/60">
                                or save anyway below ↓
                              </span>
                            </div>
                          </div>
                        )}
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1">
                            <p className="text-sm font-bold text-ink flex items-center gap-1.5">
                              <span>{comp.property_name || `${comp.county} County — ${comp.acres} ac`}</span>
                              {/* When the broker has already sent this comp
                                  to review (or saved it as verified), the
                                  card shows a checkmark badge so they can
                                  visually scan the batch and see what's
                                  done at a glance. The buttons below also
                                  switch to "Open in review" — see the
                                  action row a few hundred lines down. */}
                              {(comp as any)._savedId && (
                                <span
                                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-olive-tint border border-olive-border text-olive-2"
                                  title="Already saved to your vault — click Open in review to refine"
                                >
                                  <Check size={10} /> Saved
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-ink-2 mt-0.5">
                              {comp.county}, {comp.state} · {comp.acres} acres
                            </p>
                            {/* Source citations — show where the AI pulled each
                                numeric value from. Forces broker to check the
                                hard-to-spot wrong-table-row errors (Eatwell
                                River Ranch saved 9 ac because it pulled from
                                an improvements list instead of the Property
                                Description table). One line per field that
                                has a citation. */}
                            {((comp as any).acres_source || (comp as any).sale_price_source || (comp as any).price_per_acre_source) && (
                              <div className="mt-1.5 space-y-0.5 text-[10px] text-ink-3 leading-relaxed">
                                {(comp as any).acres_source && (
                                  <div className="flex gap-1">
                                    <span className="text-ink-3 flex-shrink-0">↳ {comp.acres} ac:</span>
                                    <span className="italic">{(comp as any).acres_source}</span>
                                  </div>
                                )}
                                {(comp as any).sale_price_source && (
                                  <div className="flex gap-1">
                                    <span className="text-ink-3 flex-shrink-0">↳ ${comp.sale_price?.toLocaleString()}:</span>
                                    <span className="italic">{(comp as any).sale_price_source}</span>
                                  </div>
                                )}
                                {(comp as any).price_per_acre_source && (comp as any).price_per_acre && (
                                  <div className="flex gap-1">
                                    <span className="text-ink-3 flex-shrink-0">↳ ${Math.round((comp as any).price_per_acre).toLocaleString()}/ac:</span>
                                    <span className="italic">{(comp as any).price_per_acre_source}</span>
                                  </div>
                                )}
                              </div>
                            )}
                            <div className="flex items-center gap-3 mt-1.5">
                              <span className="text-olive font-mono text-xs font-bold">
                                ${comp.sale_price?.toLocaleString()}
                              </span>
                              {comp.ppa_land_only && (
                                <span className="text-olive font-mono text-xs">
                                  ${Math.round(comp.ppa_land_only).toLocaleString()}/ac (land)
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <div className="flex items-center gap-1">
                              <div className={`w-2 h-2 rounded-full ${
                                comp.confidence.overall >= 80 ? 'bg-olive' :
                                comp.confidence.overall >= 50 ? 'bg-amber-600' : 'bg-red-500'
                              }`} />
                              <span className="text-xs text-ink-3">{comp.confidence.overall}%</span>
                            </div>

                            {/* Discard (X) — removes the card from this
                                import view only. The comp stays in the
                                vault under "Needs Review" because it
                                was auto-saved on extraction (PR #45).
                                Cosmetic action — no DB call. */}
                            <button
                              onClick={() => {
                                // Drop from the AI message's comps array
                                // so the card disappears. Pending state
                                // mirrors for any downstream consumers.
                                setMessages((prev) => prev.map((mm) => {
                                  if (!mm.comps) return mm;
                                  return { ...mm, comps: mm.comps.filter((cc) => cc !== comp) };
                                }));
                                setPendingComps((prev) => prev.filter((cc) => cc !== comp));
                                toast.success('Hidden from import — still in vault under Needs Review', { duration: 2500 });
                              }}
                              title="Hide from this import view. Comp stays in your vault under Needs Review."
                              className="p-1 rounded text-ink-3 hover:text-ink hover:bg-cream transition-colors"
                            >
                              <X size={13} />
                            </button>

                            {/* Delete — 2-step confirm. Removes the comp
                                from BOTH the import view AND the vault
                                permanently. For known duplicates or bad
                                AI extractions the broker doesn't want
                                anywhere. Reuses the DeleteConfirmButton
                                pattern from PR #23. Only fires when the
                                comp is actually saved (_savedId set) —
                                in the rare auto-save-failed state, the
                                discard X is enough. */}
                            {(comp as any)._savedId && (
                              <DeleteConfirmButton
                                variant="icon"
                                title="Delete from vault entirely (2-step)"
                                onConfirm={async () => {
                                  const savedId = (comp as any)._savedId;
                                  const { error } = await supabase
                                    .from('comps')
                                    .delete()
                                    .eq('id', savedId);
                                  if (error) {
                                    toast.error(`Delete failed: ${error.message}`);
                                    throw error;
                                  }
                                  toast.success('Deleted from vault');
                                  setMessages((prev) => prev.map((mm) => {
                                    if (!mm.comps) return mm;
                                    return { ...mm, comps: mm.comps.filter((cc) => cc !== comp) };
                                  }));
                                  setPendingComps((prev) => prev.filter((cc) => cc !== comp));
                                }}
                              />
                            )}
                          </div>
                        </div>

                        {/* Side-by-side thumbnails: source vs system match.
                            Aspect-[4/3] gives both panels matching, natural
                            aerial proportions (a square would over-crop
                            wide PDF aerials; the prior h-32 fixed height
                            produced a panoramic letterbox that visually
                            stretched/cropped images). object-contain on the
                            source aerial preserves the broker's view of the
                            whole image with subtle cream letterboxing —
                            never distorts, never crops mid-property. */}
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          {/* LEFT: source */}
                          <div>
                            {aerial ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={aerial}
                                alt="From source"
                                className="w-full aspect-[4/3] object-contain rounded border border-beige bg-cream"
                              />
                            ) : sourceMapUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={sourceMapUrl}
                                alt="Source coords"
                                className="w-full aspect-[4/3] object-cover rounded border border-beige"
                              />
                            ) : (
                              // No aerial AND no source lat/lng — show a
                              // calm text panel with the comp's key facts.
                              // No yellow alarm chip (previously read as
                              // "something is broken" when really it's just
                              // an MLS sheet where no embedded aerial
                              // exists). Quiet, professional, and the
                              // broker can pull the original PDF from the
                              // Source link on the verification card.
                              <div className="w-full aspect-[4/3] bg-cream border border-beige rounded p-3 text-[11px] text-ink-2 flex flex-col gap-1 overflow-hidden">
                                <div className="text-[9px] text-ink-3 uppercase tracking-wider">
                                  Source data
                                </div>
                                {comp.grantee && <div className="text-ink truncate">→ {comp.grantee}</div>}
                                {comp.grantor && <div className="text-ink-2 truncate">from {comp.grantor}</div>}
                                {comp.address && <div className="text-ink-2 truncate">{comp.address}</div>}
                                {comp.description && (
                                  <div className="text-ink-3 line-clamp-3 mt-0.5 text-[10px] leading-tight">
                                    {comp.description.slice(0, 140)}{comp.description.length > 140 ? '…' : ''}
                                  </div>
                                )}
                              </div>
                            )}
                            <div className="text-[10px] text-ink-3 text-center mt-1">From source</div>
                          </div>

                          {/* RIGHT: system match */}
                          <div>
                            {sysPinUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={sysPinUrl}
                                alt="System pin"
                                className="w-full aspect-[4/3] object-cover rounded border border-beige"
                              />
                            ) : (
                              <div className="w-full aspect-[4/3] bg-cream border border-beige rounded p-2 text-[11px] flex flex-col items-center justify-center text-center gap-1">
                                <AlertTriangle className="text-ink-3" size={20} />
                                <div className="text-ink font-medium">Locate in vault</div>
                                <div className="text-ink-3 text-[10px]">Coordinates not yet pinned</div>
                              </div>
                            )}
                            <div className="text-[10px] text-ink-3 text-center mt-1">System pinned</div>
                          </div>
                        </div>

                        {/* Verification action row — POST PR #45 every
                            extracted comp is already in the vault as
                            needs_location_review=true (auto-save on
                            extraction). The buttons here REFINE the
                            saved state rather than performing the save.

                            - "Looks right" → update the existing comp
                              to clear needs_location_review (verified).
                            - "Needs review" → navigate to the review
                              workspace for this comp. No save needed.

                            Discard (X) + Delete (trash) buttons live
                            in the card HEADER above. */}
                        {(comp as any)._savedId ? (
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <button
                              onClick={async () => {
                                const savedId = (comp as any)._savedId;
                                if (!savedId) return;
                                if (sysLat == null || sysLng == null) {
                                  toast.error('No pin to confirm — use Needs review and fix manually');
                                  return;
                                }
                                const { error } = await supabase
                                  .from('comps')
                                  .update({ needs_location_review: false })
                                  .eq('id', savedId);
                                if (error) {
                                  toast.error(`Verify failed: ${error.message}`);
                                  return;
                                }
                                toast.success('Verified');
                                // Mark locally so the card chip updates;
                                // we keep the card visible for context.
                                (comp as any)._verified = true;
                                setMessages((prev) => [...prev]);
                              }}
                              disabled={sysLat == null || sysLng == null}
                              title={sysLat == null ? 'No pin to confirm — use Needs review and fix manually' : 'Mark this comp as verified — clears the Needs Review flag'}
                              className="py-2 bg-olive-tint hover:bg-olive-tint/80 border border-olive-border text-olive-2 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Check size={12} />
                              Looks right
                            </button>
                            <button
                              onClick={() => router.push(`/dashboard/review/${(comp as any)._savedId}?return=import`)}
                              title="Open this comp in the review workspace to fix boundary, adjust improvements, or pin location"
                              className="py-2 bg-cream-2 hover:bg-cream-2 border border-beige text-ink-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1"
                            >
                              <Clock size={12} />
                              Needs review
                            </button>
                          </div>
                        ) : (
                          // Defensive fallback — should only fire if the
                          // auto-save itself failed (network error, RLS,
                          // etc.). Lets the broker recover by clicking
                          // Save manually. With auto-save working, this
                          // branch is unreachable in the happy path.
                          <div className="mt-3">
                            <button
                              onClick={async () => {
                                const result = await saveComp(comp, { needsReview: true, silent: false });
                                if (result?.id) {
                                  (comp as any)._savedId = result.id;
                                  setMessages((prev) => [...prev]);
                                }
                              }}
                              className="w-full py-2 bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-800 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1"
                              title="Auto-save didn't complete — click to save manually"
                            >
                              <Clock size={12} />
                              Save to vault
                            </button>
                          </div>
                        )}
                      </div>
                      );
                    })}

                    {msg.comps.length > 1 && (
                      <button
                        onClick={saveAllComps}
                        className="w-full py-2 bg-cream-2 hover:bg-cream-2 border border-beige text-ink-2 rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1"
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
            // Thinking state — the AI badge pulses with a soft olive halo
            // so the broker's eye knows the assistant is alive and working.
            // 32px so it reads instantly across the room; the aiThinking
            // keyframe in globals.css drives the halo + opacity dip every
            // 1.5s. Tier-1 brand voice + Tier-2 status sit alongside it.
            <div className="flex justify-start">
              <div className="bg-cream border border-beige rounded-2xl px-4 py-3.5 max-w-[80%] shadow-sm">
                <div className="flex items-start gap-3">
                  <div
                    className="w-8 h-8 rounded-md bg-olive-tint border border-olive-border flex items-center justify-center flex-shrink-0 mt-0.5"
                    style={{ animation: 'aiThinking 1.5s ease-in-out infinite' }}
                  >
                    <span className="text-olive-2 text-[12px] font-bold tracking-tight">AI</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-semibold text-olive-2 tracking-tight mb-0.5">Landstack AI</p>
                    <TieredLoadingMessage status={loadingStatus} />
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="flex-shrink-0 bg-white border-t border-beige p-3">
          <div className="flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-2.5 bg-cream border border-beige rounded-xl text-ink-2 hover:text-olive-2 hover:border-olive transition-colors flex-shrink-0"
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
                className="w-full bg-cream border border-beige rounded-xl px-3 py-2.5 text-sm text-ink placeholder-ink-3 outline-none focus:border-olive transition-colors resize-none"
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
              className="p-2.5 bg-olive hover:bg-olive-2 text-white rounded-xl transition-colors flex-shrink-0 disabled:opacity-50"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="text-[10px] text-ink-3 mt-1.5 text-center">
            Paste from email, upload PDF, or take a photo · Press Enter to send
          </p>
        </div>
      </div>
    </div>
  );
}

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
// @ts-expect-error — turf v6.5 types not exposed via package "exports"
import * as turf from '@turf/turf';
import {
  getCountyParcels,
  getCountySource,
  findParcelAt,
  findContiguousSameOwner,
  mergeFeatures,
  selectBoundaryByAcreage,
} from '@/lib/utils/countyParcels';

const TXGIO_QUERY =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query';

// Backfill the contiguous same-owner boundary on an already-saved comp.
// Useful for comps imported before the auto-merge enrichment shipped.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: comp, error } = await supabase
    .from('comps')
    .select('id, latitude, longitude, county, acres, parcel_id, created_by')
    .eq('id', params.id)
    .single();
  if (error || !comp) {
    return NextResponse.json(
      { error: 'comp not found', detail: error?.message },
      { status: 404 }
    );
  }
  if (comp.created_by !== user.id) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (comp.latitude == null || comp.longitude == null) {
    return NextResponse.json({ error: 'comp has no coordinates' }, { status: 400 });
  }

  const enriched = await enrich(comp);
  if (!enriched) {
    return NextResponse.json(
      {
        error:
          'No parcel found at this location. Use Edit Boundary to draw it manually.',
      },
      { status: 404 }
    );
  }

  const { error: updateErr } = await supabase
    .from('comps')
    .update({
      boundary_geojson: enriched.geometry,
      acres: enriched.acres ?? comp.acres,
      parcel_id: enriched.parcel_id ?? comp.parcel_id,
    })
    .eq('id', params.id);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    holding_parcel_count: enriched.holding_parcel_count,
    acres: enriched.acres,
    owner_name: enriched.owner_name,
    partial_sale: !!enriched.partial_sale,
  });
}

async function enrich(comp: any) {
  const lat = comp.latitude;
  const lng = comp.longitude;
  const countyKey = String(comp.county || '').toLowerCase();

  // CAD-direct path (currently Blanco only)
  const cadSource = getCountySource(countyKey);
  if (cadSource) {
    try {
      const fc = await getCountyParcels(countyKey);
      const seed = findParcelAt(lat, lng, fc.features);
      if (!seed) return null;
      const raw = findContiguousSameOwner(seed, fc.features, cadSource.ownerField);
      const seenIds = new Set<string>();
      const deduped = raw.filter((f) => {
        const id = String(f.properties?.[cadSource.parcelIdField] ?? '');
        if (!id) return true;
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });
      const { features: holding, totalAcres, mismatch, rejected } = selectBoundaryByAcreage(
        seed,
        deduped,
        comp.acres,
        cadSource.acresField
      );
      // Acreage rejection removed — TX appraisal vs CAD acreage routinely
      // diverges 20-40%. Attach the matched holding even when acreage gap is
      // large; the broker can fix the boundary manually if needed.
      // if (rejected) return null;
      void rejected;
      const merged = mergeFeatures(holding);
      if (!merged) return null;
      const parcelIds = holding
        .map((f) => f.properties?.[cadSource.parcelIdField])
        .filter((v) => v != null && v !== '')
        .map(String)
        .join(',');
      return {
        geometry: merged.geometry || merged,
        // Appraisal acreage always wins; polygon area is just a sanity check.
        acres: comp.acres ?? totalAcres,
        owner_name: String(seed.properties?.[cadSource.ownerField] || '').trim() || null,
        parcel_id: parcelIds || null,
        holding_parcel_count: holding.length,
        partial_sale: mismatch,
      };
    } catch {
      return null;
    }
  }

  // TxGIO statewide fallback — cascading search radius.
  //
  // Appraiser-printed "Geographic Location" coordinates often mark the
  // address access point (driveway / road frontage), not the parcel
  // interior. A tight 10m envelope at those coords lands on the road and
  // misses the parcel entirely. Widen the search until we find at least
  // one parcel, then pick the one whose centroid is closest to the pin.
  try {
    const BUFFERS = [0.0001, 0.001, 0.005, 0.015]; // ~10m, 100m, 500m, 1.5km
    let seed: any = null;
    let usedBuffer: number = 0;
    for (const d of BUFFERS) {
      try {
        const seedRes = await fetch(
          `${TXGIO_QUERY}?` +
            new URLSearchParams({
              geometry: `${lng - d},${lat - d},${lng + d},${lat + d}`,
              geometryType: 'esriGeometryEnvelope',
              inSR: '4326',
              spatialRel: 'esriSpatialRelIntersects',
              outFields: 'prop_id,owner_name,gis_area,county',
              returnGeometry: 'true',
              outSR: '4326',
              resultRecordCount: '15',
              f: 'geojson',
            }),
          { signal: AbortSignal.timeout(20000) }
        );
        if (!seedRes.ok) continue;
        const seedData = await seedRes.json();
        const features: any[] = Array.isArray(seedData?.features) ? seedData.features : [];
        if (features.length === 0) continue;
        // Pick the parcel whose centroid is closest to the input coords.
        // Matters when 1km envelope returns 15 nearby parcels — we want
        // the one the pin is closest to.
        let bestDist = Infinity;
        for (const f of features) {
          if (!f?.properties?.owner_name) continue;
          try {
            const c = turf.centroid(f);
            const coords = c?.geometry?.coordinates;
            if (!Array.isArray(coords) || coords.length < 2) continue;
            const dist = Math.hypot(coords[0] - lng, coords[1] - lat);
            if (dist < bestDist) {
              bestDist = dist;
              seed = f;
              usedBuffer = d;
            }
          } catch {}
        }
        if (seed) break;
      } catch (e: any) {
        console.warn(`[enrich-boundary] buffer ${d}° threw: ${e?.message}`);
      }
    }
    if (!seed?.properties?.owner_name) {
      console.warn(`[enrich-boundary] no parcel found at any cascading buffer`);
      return null;
    }
    console.log(`[enrich-boundary] found seed at buffer ${usedBuffer}°: ${seed.properties.owner_name}`);

    const owner = String(seed.properties.owner_name).trim();
    const seedCounty = String(seed.properties.county || comp.county || '').trim();

    const allRes = await fetch(
      `${TXGIO_QUERY}?` +
        new URLSearchParams({
          where: `owner_name='${owner.replace(/'/g, "''")}' AND county='${seedCounty.replace(/'/g, "''")}'`,
          outFields: 'prop_id,owner_name,gis_area,county',
          returnGeometry: 'true',
          outSR: '4326',
          resultRecordCount: '500',
          f: 'geojson',
        }),
      { signal: AbortSignal.timeout(15000) }
    );
    if (!allRes.ok) return null;
    const allData = await allRes.json();
    const candidates = allData.features || [];

    const raw = findContiguousSameOwner(seed, candidates, 'owner_name');
    const seenIds = new Set<string>();
    const deduped = raw.filter((f) => {
      const id = String(f.properties?.prop_id ?? '');
      if (!id) return true;
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });
    const { features: holding, totalAcres, mismatch, rejected } = selectBoundaryByAcreage(
      seed,
      deduped,
      comp.acres,
      'gis_area'
    );
    // Don't reject on acreage mismatch — selectBoundaryByAcreage now returns
    // the seed as a fallback. Same handling as the CAD path above.
    void rejected;
    const merged = mergeFeatures(holding);
    if (!merged) return null;
    const parcelIds = holding
      .map((f) => f.properties?.prop_id)
      .filter((v) => v != null && v !== '')
      .map(String)
      .join(',');
    return {
      geometry: merged.geometry || merged,
      // Appraisal acreage always wins; polygon area is just a sanity check.
      acres: comp.acres ?? totalAcres,
      owner_name: owner || null,
      parcel_id: parcelIds || null,
      holding_parcel_count: holding.length,
      partial_sale: mismatch,
    };
  } catch {
    return null;
  }
}

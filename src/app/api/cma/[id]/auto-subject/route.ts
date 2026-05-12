import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  getCountyParcels,
  getCountySource,
  findContiguousSameOwner,
  mergeFeatures,
} from '@/lib/utils/countyParcels';

// @ts-expect-error — turf v6.5 .d.ts not exposed
import * as turf from '@turf/turf';

const TXGIO_QUERY =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query';

// Auto-derive a CMA's subject boundary from CAD data, given subject_name (used
// as owner search) and subject_county. Searches Blanco CAD for Blanco subjects,
// TxGIO statewide otherwise. Walks contiguous same-owner parcels, unions their
// geometries, computes a centroid, and updates the CMA's subject_* columns.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: cma, error } = await supabase
    .from('cmas')
    .select('id, created_by, subject_name, subject_county, subject_state, subject_acres')
    .eq('id', params.id)
    .single();
  if (error || !cma) return NextResponse.json({ error: 'cma not found', detail: error?.message }, { status: 404 });
  if (cma.created_by !== user.id) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!cma.subject_name || !cma.subject_county) {
    return NextResponse.json({ error: 'subject name + county required' }, { status: 400 });
  }

  const result = await derive(cma);
  if (!result) {
    return NextResponse.json(
      { error: 'No matching parcels found in CAD for this owner+county' },
      { status: 404 }
    );
  }

  const { error: updateErr } = await supabase
    .from('cmas')
    .update({
      subject_latitude: result.lat,
      subject_longitude: result.lng,
      subject_boundary_geojson: result.geometry,
    })
    .eq('id', cma.id);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  return NextResponse.json({
    success: true,
    parcel_count: result.parcelCount,
    acres: result.acres,
    latitude: result.lat,
    longitude: result.lng,
  });
}

async function derive(cma: any) {
  const ownerQuery = String(cma.subject_name).trim();
  const county = String(cma.subject_county).trim();

  // Try the dedicated CAD source first (e.g., Blanco)
  const cadSource = getCountySource(county.toLowerCase());
  if (cadSource) {
    try {
      const fc = await getCountyParcels(county.toLowerCase());
      const norm = (s: any) => String(s ?? '').trim().toUpperCase();
      const target = norm(ownerQuery);
      const matches = (fc.features || []).filter(
        (f: any) => norm(f.properties?.[cadSource.ownerField]).includes(target)
        || target.includes(norm(f.properties?.[cadSource.ownerField]))
      );
      if (matches.length === 0) return null;
      // Pick the parcel cluster with the largest area as the seed
      matches.sort((a: any, b: any) => (parseFloat(b.properties?.[cadSource.acresField]) || 0) - (parseFloat(a.properties?.[cadSource.acresField]) || 0));
      const seed = matches[0];
      const raw = findContiguousSameOwner(seed, fc.features, cadSource.ownerField);
      const seenIds = new Set<string>();
      const holding = raw.filter((f: any) => {
        const id = String(f.properties?.[cadSource.parcelIdField] ?? '');
        if (!id) return true;
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });
      const merged = mergeFeatures(holding);
      if (!merged) return null;
      const acres = holding.reduce((s, f) => s + (parseFloat((f as any).properties?.[cadSource.acresField]) || 0), 0);
      const c = (() => { try { return turf.centroid(merged); } catch { return null; } })();
      const lng = c?.geometry?.coordinates?.[0] ?? null;
      const lat = c?.geometry?.coordinates?.[1] ?? null;
      return { geometry: merged.geometry || merged, parcelCount: holding.length, acres, lat, lng };
    } catch {
      // fall through to TxGIO
    }
  }

  // TxGIO statewide fallback
  try {
    const safeOwner = ownerQuery.toUpperCase().replace(/'/g, "''");
    const safeCounty = county.toUpperCase().replace(/'/g, "''");
    const params = new URLSearchParams({
      where: `owner_name LIKE '%${safeOwner}%' AND county='${safeCounty}'`,
      outFields: 'prop_id,owner_name,gis_area,county',
      returnGeometry: 'true',
      outSR: '4326',
      resultRecordCount: '500',
      f: 'geojson',
    });
    const res = await fetch(`${TXGIO_QUERY}?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json();
    const features: any[] = data.features || [];
    if (features.length === 0) return null;
    // Largest parcel = seed
    features.sort((a, b) => (parseFloat(b.properties?.gis_area) || 0) - (parseFloat(a.properties?.gis_area) || 0));
    const seed = features[0];
    const raw = findContiguousSameOwner(seed, features, 'owner_name');
    const seenIds = new Set<string>();
    const holding = raw.filter((f: any) => {
      const id = String(f.properties?.prop_id ?? '');
      if (!id) return true;
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });
    const merged = mergeFeatures(holding);
    if (!merged) return null;
    const acres = holding.reduce((s, f) => s + (parseFloat((f as any).properties?.gis_area) || 0), 0);
    const c = (() => { try { return turf.centroid(merged); } catch { return null; } })();
    const lng = c?.geometry?.coordinates?.[0] ?? null;
    const lat = c?.geometry?.coordinates?.[1] ?? null;
    return { geometry: merged.geometry || merged, parcelCount: holding.length, acres, lat, lng };
  } catch {
    return null;
  }
}

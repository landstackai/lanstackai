import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Update a comp's boundary polygon (manual edit). Body: { geometry: GeoJSON }
//
// Also updates latitude/longitude to the centroid of the new boundary so the
// map pin stays in sync with the boundary. If geometry is null (boundary
// cleared) we leave lat/lng alone — caller may want to keep the original pin.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const geometry = body?.geometry;
  if (geometry !== null && !isValidGeometry(geometry)) {
    return NextResponse.json({ error: 'invalid geometry' }, { status: 400 });
  }

  const { data: comp, error } = await supabase
    .from('comps')
    .select('id, created_by')
    .eq('id', params.id)
    .single();
  if (error || !comp) {
    return NextResponse.json({ error: 'comp not found', detail: error?.message }, { status: 404 });
  }
  if (comp.created_by !== user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Build update payload — always set boundary, and set lat/lng to centroid
  // when boundary is being set (not when being cleared).
  const update: Record<string, any> = { boundary_geojson: geometry };
  if (geometry) {
    const centroid = computeCentroid(geometry);
    if (centroid) {
      update.latitude = centroid.lat;
      update.longitude = centroid.lng;
    }
  }

  const { error: updateErr } = await supabase
    .from('comps')
    .update(update)
    .eq('id', params.id);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    pin_updated: Boolean(update.latitude && update.longitude),
    latitude: update.latitude ?? null,
    longitude: update.longitude ?? null,
  });
}

function isValidGeometry(g: any): boolean {
  if (!g || typeof g !== 'object') return false;
  return g.type === 'Polygon' || g.type === 'MultiPolygon';
}

// Compute the centroid (average of coordinates) of a Polygon or MultiPolygon.
// Returns {lat, lng} or null if the geometry can't be parsed.
//
// Note: this is the simple averaged centroid, not the area-weighted centroid.
// For a comp pin on a map this is plenty accurate — placing the marker
// somewhere inside the property is the goal, not the mathematical center.
function computeCentroid(geometry: any): { lat: number; lng: number } | null {
  if (!geometry) return null;
  const allCoords: Array<[number, number]> = [];

  const collect = (ring: any[]) => {
    for (const pt of ring) {
      if (Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
        allCoords.push([pt[0], pt[1]]);
      }
    }
  };

  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
    // outer ring only — holes don't shift the centroid much for pin placement
    if (Array.isArray(geometry.coordinates[0])) collect(geometry.coordinates[0]);
  } else if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    for (const poly of geometry.coordinates) {
      if (Array.isArray(poly) && Array.isArray(poly[0])) collect(poly[0]);
    }
  } else {
    return null;
  }

  if (allCoords.length === 0) return null;

  let sumLng = 0;
  let sumLat = 0;
  for (const [lng, lat] of allCoords) {
    sumLng += lng;
    sumLat += lat;
  }
  return {
    lng: sumLng / allCoords.length,
    lat: sumLat / allCoords.length,
  };
}

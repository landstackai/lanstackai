import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Update a comp's boundary polygon (manual edit). Body: { geometry: GeoJSON }
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

  const { error: updateErr } = await supabase
    .from('comps')
    .update({ boundary_geojson: geometry })
    .eq('id', params.id);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

function isValidGeometry(g: any): boolean {
  if (!g || typeof g !== 'object') return false;
  return g.type === 'Polygon' || g.type === 'MultiPolygon';
}

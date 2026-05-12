import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/comps/clear-bad-coordinates
 *
 * Sets latitude/longitude to NULL for the caller's comps where the existing
 * coords are likely county-centroid fallbacks rather than actual property
 * locations. Detects this by re-running the geocoder for the comp's
 * "County, State" alone and flagging any comp whose stored coords are within
 * ~0.5 miles of the county centroid.
 *
 * Use case: brokers who imported comps before we removed the county-centroid
 * fallback and now have a bunch of pins clustered in the middle of various
 * counties. After this runs, those comps move into the "Needs Location"
 * filter so the broker can fix them with the click-on-map picker.
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!mapboxToken) {
      return NextResponse.json({ error: 'Mapbox token missing' }, { status: 500 });
    }

    // Authenticated client — RLS scopes the SELECT/UPDATE to the caller's own comps.
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: authHeader ? { Authorization: authHeader } : {} },
    });

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Pull all comps that have coords. RLS will limit to the caller's own.
    const { data: comps, error } = await supabase
      .from('comps')
      .select('id, county, state, latitude, longitude')
      .not('latitude', 'is', null)
      .not('longitude', 'is', null);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // For each unique county, geocode "County County, State" once to get the
    // centroid. Then check each comp against that centroid.
    const countyCache = new Map<string, { lat: number; lng: number }>();
    const cleared: string[] = [];

    for (const comp of comps || []) {
      if (!comp.county) continue;
      const key = `${comp.county}|${comp.state || 'TX'}`;
      let centroid = countyCache.get(key);

      if (!centroid) {
        try {
          const q = `${comp.county} County, ${comp.state || 'TX'}`;
          const r = await fetch(
            `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}` +
              `&access_token=${mapboxToken}&country=us&limit=1`
          );
          const j = await r.json();
          const c = j?.features?.[0]?.geometry?.coordinates;
          if (Array.isArray(c) && c.length >= 2) {
            centroid = { lng: c[0], lat: c[1] };
            countyCache.set(key, centroid);
          }
        } catch {
          continue;
        }
      }
      if (!centroid) continue;

      // Distance check: if the comp's coords are within ~0.5 mi of the
      // county centroid (which is wildly unlikely for an actual rural
      // property), it's almost certainly a centroid fallback. Clear it.
      const distMiles = haversineMiles(
        comp.latitude!,
        comp.longitude!,
        centroid.lat,
        centroid.lng
      );
      if (distMiles < 0.5) {
        cleared.push(comp.id);
      }
    }

    if (cleared.length > 0) {
      const { error: updErr } = await supabase
        .from('comps')
        .update({ latitude: null, longitude: null })
        .in('id', cleared);
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 });
      }
    }

    return NextResponse.json({
      checked: comps?.length ?? 0,
      cleared: cleared.length,
      cleared_ids: cleared,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 });
  }
}

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8; // miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

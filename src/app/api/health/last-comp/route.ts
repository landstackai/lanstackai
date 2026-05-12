import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * GET /api/health/last-comp?name=Shelton
 *
 * No-auth diagnostic that fetches the most recent comp whose property_name
 * matches the given filter, returning the full saved record so we can see
 * what auto-locate ACTUALLY produced during the live import (vs the test
 * endpoint which only validates the algorithm).
 *
 * Uses the service-role key to bypass RLS so we can see everyone's recent
 * comps. This is a temporary debug tool and should be removed/locked down
 * once we've finished diagnosing.
 */

export const maxDuration = 15;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;

export async function GET(req: NextRequest) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return NextResponse.json({ error: 'supabase env not set' }, { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const nameFilter = (searchParams.get('name') || '').trim();

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  let query = supabase
    .from('comps')
    .select(
      'id, created_at, property_name, county, state, acres, ' +
      'latitude, longitude, parcel_id, ' +
      'grantor, grantee, owner_name, ' +
      'address, sale_price, sale_date, ' +
      'location_confidence, boundary_warning, ' +
      'description'
    )
    .order('created_at', { ascending: false })
    .limit(5);

  if (nameFilter.length >= 2) {
    query = query.ilike('property_name', `%${nameFilter}%`);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    count: data?.length || 0,
    filter: nameFilter || '(none)',
    comps: (data || []).map((c) => ({
      ...c,
      // Truncate description for readability
      description: c.description ? c.description.slice(0, 200) + (c.description.length > 200 ? '…' : '') : null,
      has_coords: Boolean(c.latitude && c.longitude),
    })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

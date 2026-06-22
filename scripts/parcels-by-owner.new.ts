// PROPOSED REPLACEMENT for src/app/api/parcels-by-owner/route.ts
// ─────────────────────────────────────────────────────────────────────────
// Once the parcels foundation lands (migration 040 + 041 applied,
// parcels_tx populated), copy this file over the existing route.ts.
// Until then, this lives in scripts/ as the staged diff so you can
// review before the swap and not have a half-shipped intermediate
// state in production.
//
// WHAT CHANGED VS. THE TXGIO VERSION:
//
//   In:   /api/parcels-by-owner?q=Wesla+Ranches&county=Frio
//   Out:  GeoJSON FeatureCollection — same shape, same field names
//
//   Old path: hit feature.geographic.texas.gov ArcGIS service, parse,
//             return. Subject to TxGIO uptime + latency.
//
//   New path: call supabase.rpc('search_parcels_by_owner', {...}).
//             Postgres does the tokenization, ILIKE-with-trigram match,
//             ST_AsGeoJSON serialization, and returns the same
//             FeatureCollection in <100ms.
//
// AUTOLOCATE BEHAVIOR:
//   Should be identical for cases where TxGIO returned data — the
//   query semantics + response shape match. Validated pre-push via
//   scripts/batch-validate-frio-claude.mjs against the same 13
//   fixtures we've been using all week.
//
// FAILURE MODES:
//   - Supabase unreachable: 502 with hint to retry. Previously this
//     was TxGIO unreachable, same UX.
//   - No matching parcels: empty FeatureCollection ({features: []}).
//     Caller handles as before.
//   - Empty/invalid query: HTTP 400 (was the same).
// ─────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Supabase responds in <100ms typically, but allow generous headroom for
// cold connections + large multi-token query parsing. Vercel cap is 60s
// on Pro; we'll never get close. Previous TxGIO route's 35s ceiling is
// gone — that was hedging against an upstream we no longer depend on.
export const maxDuration = 15;

// Service-role client. Owner search reads CC0 public data — every
// authenticated broker has read access via RLS (see migration 040),
// but the service role bypasses RLS for the search RPC anyway since
// the function is SECURITY DEFINER.
const supabase = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim();
  const countyParam = (searchParams.get('county') || '').trim();

  if (q.length < 3) {
    return NextResponse.json(
      { error: 'q (query) must be at least 3 characters' },
      { status: 400 },
    );
  }

  try {
    // The Postgres function handles tokenization, stop-word filtering,
    // ILIKE chaining, the county filter, and the GeoJSON serialization.
    // Caller doesn't need to know any of that — same input, same output
    // shape as the old TxGIO call.
    const { data, error } = await supabase.rpc('search_parcels_by_owner', {
      q,
      county_filter: countyParam || null,
    });

    if (error) {
      console.error('[parcels-by-owner] RPC error:', error);
      return NextResponse.json(
        {
          error: 'Parcel search failed',
          detail: error.message,
          hint: 'Self-hosted parcel database may be unreachable. If this persists, check Supabase status.',
          query: q,
        },
        { status: 502 },
      );
    }

    // data is already a GeoJSON FeatureCollection — no parsing needed.
    const fc = (data ?? {
      type: 'FeatureCollection',
      features: [],
    }) as { features?: any[] };
    const count = Array.isArray(fc.features) ? fc.features.length : 0;

    // Cache success aggressively. Parcel data refreshes annually (when
    // we re-run the StratMap import). Empty results cache only briefly
    // so iterative searches see results as the broker refines.
    const cacheControl =
      count > 0
        ? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400'
        : 'public, max-age=60, s-maxage=300';

    return NextResponse.json(fc, {
      headers: { 'Cache-Control': cacheControl },
    });
  } catch (e: any) {
    console.error('[parcels-by-owner] uncaught:', e);
    return NextResponse.json(
      {
        error: 'Parcel search failed',
        detail: e?.message ?? String(e),
        query: q,
      },
      { status: 502 },
    );
  }
}

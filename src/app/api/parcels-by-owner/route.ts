import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/parcels-by-owner?q=Grundhoefer+Farms
 *
 * Search TxGIO statewide TX parcels for ones whose owner_name matches the
 * query. Wildcard / partial match (case-insensitive), capped at 200 results
 * to keep the map readable.
 *
 * Returns GeoJSON FeatureCollection with each match's geometry and a
 * properties block { prop_id, owner_name, gis_area, county }.
 *
 * Slow: TxGIO sometimes takes 5-20s for owner-name LIKE queries. Cache the
 * response for 1 hour client-side, 24h on Vercel edge — owners and parcels
 * change at most monthly.
 */

// Pro plan: allow up to 60s. TxGIO can take 30-50s on bad afternoons;
// successful response then caches for 24h on Vercel edge.
// 25s ceiling = 20s upstream fetch + a few seconds of headroom for
// param parsing and response shaping. Previous 60s value let slow TxGIO
// calls compound into multi-minute hangs on the client side when the
// upstream was unreachable.
export const maxDuration = 25;

const TXGIO_QUERY =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query';

// Stop words — common filler words that should never become search filters.
// Adding them as LIKE clauses would match almost everything (especially
// "the") and dilute the result set with false positives.
const STOP_WORDS = new Set(['THE', 'OF', 'AND', '&', 'C/O']);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim();
  const countyParam = (searchParams.get('county') || '').trim();
  if (q.length < 3) {
    return NextResponse.json(
      { error: 'q (query) must be at least 3 characters' },
      { status: 400 }
    );
  }

  // Tokenize the query so word ORDER doesn't matter. Texas appraisal districts
  // store individual owners as "LASTNAME FIRSTNAME MIDDLE" — so searching
  // "gary fritz" needs to find "FRITZ GARY W & APRIL N". With multi-token AND
  // matching, every word in the query must appear somewhere in owner_name,
  // but in any order.
  //
  // Tokens kept when ≥3 chars OR contain a digit — preserves entity prefixes
  // like "9L" in "9L Farms" (the length-only filter dropped these, leaving
  // a single "FARMS" that over-matched every Farms-named owner in the county).
  // Then SQL-sanitized (strip single quotes / backslashes). Punctuation strip
  // expanded to include apostrophes (straight + curly), slashes, ampersands —
  // TxGIO stores names without punctuation, so "kids'" must split to "kids".
  const tokens = q
    .replace(/[.,'’\-\/&]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/['\\]/g, '').toUpperCase().trim())
    .filter((t) => (t.length >= 3 || /\d/.test(t)) && !STOP_WORDS.has(t));

  if (tokens.length === 0) {
    return NextResponse.json(
      { error: 'No usable search terms (need at least one word ≥3 chars)' },
      { status: 400 }
    );
  }

  // Optional county filter — supports "Frio" or "Frio,Medina" for cross-
  // county properties. Narrows the search dramatically and prevents common
  // surnames from returning hundreds of unrelated matches statewide.
  const counties = countyParam
    .split(/[,&]|\s+and\s+/i)
    .map((c) => c.replace(/['\\]/g, '').replace(/\bcount(y|ies)\b/gi, '').trim().toUpperCase())
    .filter((c) => c.length > 0);
  const countyClause = counties.length > 0
    ? ' AND (' + counties.map((c) =>
        `UPPER(county) = '${c}' OR UPPER(county) = '${c} COUNTY'`
      ).join(' OR ') + ')'
    : '';

  // Build AND-joined LIKE clauses — one per token. Order-independent match.
  const ownerClause = tokens
    .map((t) => `UPPER(owner_name) LIKE '%${t}%'`)
    .join(' AND ');
  const where = `(${ownerClause})${countyClause}`;

  const params = new URLSearchParams({
    where,
    outFields: 'prop_id,owner_name,gis_area,county',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '6',
    resultRecordCount: '200',
    f: 'geojson',
  });

  async function fetchOnce(timeoutMs: number) {
    const upstream = await fetch(`${TXGIO_QUERY}?${params}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!upstream.ok) throw new Error(`Upstream ${upstream.status}`);
    return upstream.json();
  }

  let data: any = null;
  let lastErr: any = null;
  // Single fast attempt — 20s ceiling. When TxGIO is healthy it responds
  // in 2-15s. When TxGIO is having a bad day (production 2026-06-18:
  // confirmed direct 504s from feature.geographic.texas.gov within 60s)
  // there is no point burning the user's wait time on retries — they'll
  // just stack another 20-50 seconds of nothing onto an upstream that's
  // already not responding. Fail fast, return clean 502, let the client
  // surface a "TxGIO upstream slow/down — pin manually" prompt while
  // the broker keeps working on other comps in parallel. The previous
  // 40s+50s retry pattern compounded to 5+ minutes of dead time per
  // upload when 3 comps each tried 3 fallback queries.
  try {
    data = await fetchOnce(20_000);
  } catch (e: any) {
    lastErr = e;
  }

  if (!data) {
    return NextResponse.json(
      {
        error: 'TxGIO upstream slow or down',
        detail: lastErr?.message || 'timeout after 20s',
        hint: 'Texas state parcel service may be intermittently slow. Pin manually on the map and the comp will still save with all extracted fields.',
        query: q,
      },
      { status: 502 }
    );
  }

  const count = Array.isArray(data?.features) ? data.features.length : 0;
  // Cache success aggressively (parcels change monthly at most), but cache
  // empty/no-match results only briefly. A "no match" is often a transient
  // state — TxGIO updates monthly, query patterns evolve, and a stuck empty
  // cache is the most frustrating outcome for users searching iteratively.
  const cacheControl = count > 0
    ? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400'
    : 'public, max-age=60, s-maxage=300';

  return new NextResponse(JSON.stringify({
    ...data,
    query: q,
    tokens_used: tokens,
    counties_used: counties,
    match_count: count,
    truncated: count >= 200,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/geo+json',
      'Cache-Control': cacheControl,
    },
  });
}

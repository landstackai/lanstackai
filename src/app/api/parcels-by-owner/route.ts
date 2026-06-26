import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';

/**
 * GET /api/parcels-by-owner-v2?q=Grundhoefer+Farms
 *
 * Self-hosted replacement for /api/parcels-by-owner (TxGIO-backed).
 * Queries the Landstack Parcel Data Supabase project's parcels_tx table
 * via the search_parcels_by_owner Postgres function — same response shape
 * as the TxGIO route, but sub-second latency and no vendor dependency.
 *
 * Cutover plan: deploy this alongside the TxGIO route, validate against
 * known owner queries, then rename to make this the default and keep
 * the old route as a fallback for one week.
 *
 * IMPORTANT — connection URL:
 *   Vercel serverless functions cannot route IPv6, and Supabase's direct
 *   DB endpoint (db.<project>.supabase.co) is IPv6-only on Pro tier
 *   unless the IPv4 add-on is enabled.
 *   We use the Supabase pooler (aws-1-us-east-1.pooler.supabase.com),
 *   which is IPv4 by default. The env var PARCELS_POOLER_URL points at
 *   port 5432 (session mode, used by the bulk import script). For this
 *   endpoint we swap to port 6543 (transaction mode) — better for
 *   serverless because connections are per-statement, not per-client.
 */

// Pro plan ceiling. Realistically the SQL function returns in <2s for
// every owner query we've tested, but keep headroom for cold pooler
// connections + bursty serverless invocations.
export const maxDuration = 40;

// Match the TxGIO route's stop-word list exactly so v1↔v2 behavior parity
// is preserved end-to-end (the SQL function also filters these).
const STOP_WORDS = new Set(['THE', 'OF', 'AND', '&', 'C/O']);

// Derive the transaction-pooler URL from PARCELS_POOLER_URL (session, 5432).
// Both modes share the same hostname; only the port differs. Doing this
// at module load means we don't need a second env var to manage in Vercel.
function getTransactionPoolerUrl(): string {
  const sessionUrl = process.env.PARCELS_POOLER_URL;
  if (!sessionUrl) {
    // Module-load guard. Surfaces missing env var clearly in Vercel logs.
    console.error(
      '[parcels-by-owner-v2] PARCELS_POOLER_URL not set. ' +
        'Set it in Vercel project env vars (Settings → Environment Variables). ' +
        'Format: postgresql://postgres.<project_ref>:<password>@aws-1-us-east-1.pooler.supabase.com:5432/postgres'
    );
    return '';
  }
  return sessionUrl.replace(':5432/', ':6543/');
}

// Single shared pool across function invocations within the same Vercel
// instance. `max: 5` caps concurrency per instance — keeps us well below
// Supabase Pro's connection limits even if multiple users hit at once.
const pool = process.env.PARCELS_POOLER_URL
  ? new Pool({
      connectionString: getTransactionPoolerUrl(),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
    })
  : null;

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

  // Tokenize for response metadata only. The SQL function also tokenizes
  // internally — keeping the same logic here means clients see the actual
  // tokens that were searched (useful for debugging false negatives).
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

  // Counties metadata. The SQL function accepts a single county_filter;
  // for multi-county input (e.g. "Frio,Medina") we pass the first one.
  // Cross-county owners are rare enough that the rare false negative is
  // an acceptable trade for the simpler query.
  const counties = countyParam
    .split(/[,&]|\s+and\s+/i)
    .map((c) =>
      c
        .replace(/['\\]/g, '')
        .replace(/\bcount(y|ies)\b/gi, '')
        .trim()
        .toUpperCase()
    )
    .filter((c) => c.length > 0);
  const countyForQuery = counties[0] ?? null;

  if (!pool) {
    return NextResponse.json(
      {
        error: 'Parcels DB not configured',
        detail: 'PARCELS_POOLER_URL env var is not set',
        hint: 'Set it in Vercel project env vars before this endpoint will work.',
        query: q,
      },
      { status: 503 }
    );
  }

  let data: any = null;
  let lastErr: any = null;
  try {
    const result = await pool.query(
      'SELECT search_parcels_by_owner($1, $2) AS result',
      [q, countyForQuery]
    );
    data = result.rows[0]?.result;
  } catch (e: any) {
    lastErr = e;
  }

  if (!data) {
    return NextResponse.json(
      {
        error: 'Parcels DB query failed',
        detail: lastErr?.message || 'unknown error',
        hint: 'Self-hosted parcels DB may be unreachable or the search function returned no result. Pin manually on the map and the comp will still save with all extracted fields.',
        query: q,
      },
      { status: 502 }
    );
  }

  const count = Array.isArray(data?.features) ? data.features.length : 0;

  // Cache successful hits aggressively (parcel data only changes when
  // StratMap publishes a new statewide release, roughly annually). Cache
  // empty results only briefly — a no-match is more often a query that
  // needs iteration than a permanent fact.
  const cacheControl =
    count > 0
      ? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400'
      : 'public, max-age=60, s-maxage=300';

  return new NextResponse(
    JSON.stringify({
      ...data,
      query: q,
      tokens_used: tokens,
      counties_used: counties,
      match_count: count,
      truncated: count >= 200,
      source: 'self-hosted', // helps client distinguish v1 (TxGIO) vs v2
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/geo+json',
        'Cache-Control': cacheControl,
      },
    }
  );
}

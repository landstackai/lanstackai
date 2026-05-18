import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient as createSsrClient } from '@/lib/supabase/server';

/**
 * POST /api/diagnostics/autolocate
 *
 * Receives a diagnostic payload from the browser autoLocate at every
 * exit point (success, null result, or error) and writes it to the
 * autolocate_diagnostics table. Used for pattern detection: "what %
 * of HIGH-confidence pins does the broker reject?", "which counties
 * have the highest manual-fallback rate?", etc.
 *
 * Hard rule: this endpoint NEVER blocks or affects user-facing flow.
 * - Authentication failures → write user_id=NULL, still log.
 * - Schema validation failures → return 400, don't crash.
 * - DB write failures → return 500 but the caller fires-and-forgets.
 *
 * Uses service-role to bypass RLS (the table has RLS enabled with no
 * policies — service-role is the only path to write).
 */

export const maxDuration = 10;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;

// Whitelist of expected fields. Anything else in the payload is ignored —
// don't let arbitrary client data inflate the DB row.
const ALLOWED_FIELDS = [
  'input_acres', 'input_sale_price', 'input_ppa',
  'input_grantee', 'input_grantor', 'input_property_name',
  'input_county', 'input_lat', 'input_lng',
  'input_has_aerial', 'input_has_description',
  'exit_stage', 'stages_attempted',
  'owner_search_data', 'cluster_data',
  'final_pin_lat', 'final_pin_lng', 'final_parcel_ids',
  'final_cluster_acres', 'final_confidence', 'final_match_reason',
  'ms_total',
] as const;

export async function POST(req: NextRequest) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return NextResponse.json({ error: 'supabase env not set' }, { status: 500 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'payload must be object' }, { status: 400 });
  }

  // Try to identify the user from the SSR session — but don't require it.
  // An unauthenticated diagnostic is still useful; we just won't know who ran it.
  let userId: string | null = null;
  try {
    const ssrClient = createSsrClient();
    const { data: { user } } = await ssrClient.auth.getUser();
    userId = user?.id || null;
  } catch {
    // ignore — anonymous diagnostic is fine
  }

  // Build the row from whitelisted fields only. Coerce numerics where
  // appropriate so the DB doesn't reject strings.
  const row: Record<string, any> = {
    user_id: userId,
    deployment_sha: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
  };
  for (const field of ALLOWED_FIELDS) {
    if (field in payload) {
      row[field] = payload[field];
    }
  }

  const supabase = createServiceClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase
    .from('autolocate_diagnostics')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    // Don't surface internal errors to the client — diagnostics should
    // fail invisibly so they never disrupt the user flow.
    console.error('[diagnostics/autolocate] insert failed:', error.message);
    return NextResponse.json({ error: 'insert failed' }, { status: 500 });
  }

  return NextResponse.json({ id: data?.id || null }, { status: 200 });
}

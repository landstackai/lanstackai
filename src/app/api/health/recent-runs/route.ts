import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * GET /api/health/recent-runs
 *
 * No-auth diagnostic that returns the most recent autoLocate runs from
 * the autolocate_diagnostics table. Used to debug "did this comp's
 * autoLocate succeed?" and to scan for patterns (which counties fail
 * most, which exit stages dominate, etc.).
 *
 * Query params (all optional):
 *   limit       — default 50, max 200
 *   exit_stage  — filter to a specific exit stage
 *   confidence  — filter to a specific final_confidence
 *   county      — filter to a county (ILIKE match)
 *   name        — filter to property_name (ILIKE match)
 *
 * Also returns a small `aggregates` block with counts grouped by exit
 * stage and confidence over the returned rows — useful for spotting
 * shifts after a deploy without writing SQL.
 *
 * Uses the service-role key to bypass RLS. This is a debug tool;
 * lock down or remove once we have a real admin dashboard.
 */

export const maxDuration = 15;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;

export async function GET(req: NextRequest) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return NextResponse.json({ error: 'supabase env not set' }, { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const limitParam = Math.min(
    Math.max(parseInt(searchParams.get('limit') || '50', 10) || 50, 1),
    200
  );
  const exitStageFilter = (searchParams.get('exit_stage') || '').trim();
  const confidenceFilter = (searchParams.get('confidence') || '').trim();
  const countyFilter = (searchParams.get('county') || '').trim();
  const nameFilter = (searchParams.get('name') || '').trim();

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  let query = supabase
    .from('autolocate_diagnostics')
    .select(
      'id, created_at, deployment_sha, ' +
      'input_acres, input_sale_price, input_ppa, ' +
      'input_grantee, input_grantor, input_property_name, ' +
      'input_county, input_lat, input_lng, ' +
      'input_has_aerial, input_has_description, ' +
      'exit_stage, owner_search_data, cluster_data, ' +
      'final_pin_lat, final_pin_lng, final_parcel_ids, ' +
      'final_cluster_acres, final_confidence, final_match_reason, ' +
      'broker_decision, ms_total'
    )
    .order('created_at', { ascending: false })
    .limit(limitParam);

  if (exitStageFilter) query = query.eq('exit_stage', exitStageFilter);
  if (confidenceFilter) query = query.eq('final_confidence', confidenceFilter);
  if (countyFilter) query = query.ilike('input_county', `%${countyFilter}%`);
  if (nameFilter) query = query.ilike('input_property_name', `%${nameFilter}%`);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = data || [];

  // Compute small aggregates over the returned rows. Real analysis
  // belongs in SQL, but inline counts let you scan for "did the
  // distribution shift?" without leaving the browser.
  const byExitStage: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  const byCounty: Record<string, number> = {};
  for (const r of rows) {
    const r2 = r as any;
    if (r2.exit_stage) byExitStage[r2.exit_stage] = (byExitStage[r2.exit_stage] || 0) + 1;
    const c = r2.final_confidence || '(null)';
    byConfidence[c] = (byConfidence[c] || 0) + 1;
    if (r2.input_county) byCounty[r2.input_county] = (byCounty[r2.input_county] || 0) + 1;
  }

  return NextResponse.json({
    count: rows.length,
    limit: limitParam,
    filters: {
      exit_stage: exitStageFilter || null,
      confidence: confidenceFilter || null,
      county: countyFilter || null,
      name: nameFilter || null,
    },
    aggregates: {
      by_exit_stage: byExitStage,
      by_confidence: byConfidence,
      by_county: byCounty,
    },
    rows,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

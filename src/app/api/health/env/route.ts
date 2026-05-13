import { NextResponse } from 'next/server';

/**
 * GET /api/health/env
 *
 * No-auth diagnostic that returns which env vars are set on the current
 * deployment. Used to verify a deploy picked up the right flags before
 * spending time on user-facing tests. Returns booleans only — never
 * leaks values.
 */
export async function GET() {
  return NextResponse.json({
    deployment: {
      vercel_env: process.env.VERCEL_ENV || 'unknown',
      vercel_git_branch: process.env.VERCEL_GIT_COMMIT_REF || 'unknown',
      vercel_git_sha: (process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 7),
    },
    flags: {
      owner_search_first: process.env.OWNER_SEARCH_FIRST === '1',
      seed_owner_match: process.env.SEED_OWNER_MATCH === '1',
      run_server_autolocate: process.env.RUN_SERVER_AUTOLOCATE === '1',
      skip_server_autolocate: process.env.SKIP_SERVER_AUTOLOCATE === '1',
    },
    keys_present: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      regrid: Boolean(process.env.REGRID_API_KEY),
      supabase_url: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      supabase_secret: Boolean(process.env.SUPABASE_SECRET_KEY),
      mapbox: Boolean(process.env.NEXT_PUBLIC_MAPBOX_TOKEN),
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

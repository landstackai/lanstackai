import { NextResponse } from 'next/server';

/**
 * GET /api/health/regrid
 *
 * One-shot diagnostic for Regrid integration. Reports:
 *   - Is REGRID_API_KEY set on the server?
 *   - Which Regrid endpoints respond with what status?
 *   - Latency per attempt
 *   - The first 300 chars of each response body (so we can see error msgs)
 *
 * Use this to confirm:
 *   - Is the env var actually reaching the running function?
 *   - Is the JWT valid (or expired / wrong audience)?
 *   - Are we calling the right endpoint URL?
 */

const REGRID_API_KEY = process.env.REGRID_API_KEY;
const REGRID_BASE = 'https://app.regrid.com/api/v2';

// Known parcel location in Frio County, TX — should return data on any
// healthy Regrid account with TX coverage.
const TEST_LAT = '28.93';
const TEST_LNG = '-99.19';

async function probe(url: string) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const ms = Date.now() - t0;
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    return {
      ok: res.ok,
      status: res.status,
      latency_ms: ms,
      parcel_count: Array.isArray(parsed?.parcels) ? parsed.parcels.length
                  : Array.isArray(parsed?.results) ? parsed.results.length
                  : Array.isArray(parsed?.features) ? parsed.features.length
                  : Array.isArray(parsed) ? parsed.length : 0,
      body_preview: text.slice(0, 300),
      first_parcel_keys: parsed?.parcels?.[0] ? Object.keys(parsed.parcels[0]).slice(0, 10)
                       : parsed?.results?.[0] ? Object.keys(parsed.results[0]).slice(0, 10)
                       : parsed?.features?.[0] ? Object.keys(parsed.features[0]).slice(0, 10)
                       : null,
    };
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      latency_ms: Date.now() - t0,
      error: e?.message || 'fetch failed',
      body_preview: null,
    };
  }
}

export async function GET() {
  const env_set = Boolean(REGRID_API_KEY);
  const token_preview = REGRID_API_KEY
    ? `${REGRID_API_KEY.slice(0, 10)}...${REGRID_API_KEY.slice(-6)} (${REGRID_API_KEY.length} chars)`
    : 'NOT SET';

  // Decode the JWT payload (no signature check) so we can see expiry, scopes
  let token_payload: any = null;
  if (REGRID_API_KEY && REGRID_API_KEY.split('.').length === 3) {
    try {
      const payloadB64 = REGRID_API_KEY.split('.')[1];
      const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
      token_payload = JSON.parse(
        Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
      );
      // Don't leak anything sensitive — just expiry, issuer, scope
      token_payload = {
        iss: token_payload.iss,
        exp: token_payload.exp ? new Date(token_payload.exp * 1000).toISOString() : null,
        exp_unix: token_payload.exp,
        now_unix: Math.floor(Date.now() / 1000),
        is_expired: token_payload.exp ? token_payload.exp * 1000 < Date.now() : false,
        capabilities: token_payload.cap,
      };
    } catch (e: any) {
      token_payload = { error: 'jwt-decode-failed' };
    }
  }

  if (!env_set) {
    return NextResponse.json({
      verdict: 'env_var_missing',
      recommendation: 'REGRID_API_KEY is not set on the deployed Vercel function. Add it in Vercel → Settings → Environment Variables, then redeploy.',
      env_set,
      token_preview,
    });
  }

  // Try the three Regrid URL shapes the app uses
  const tests = [
    {
      label: 'v2_parcels',
      url: `${REGRID_BASE}/parcels.json?lat=${TEST_LAT}&lon=${TEST_LNG}&token=${REGRID_API_KEY}`,
    },
    {
      label: 'v2_query',
      url: `${REGRID_BASE}/query?lat=${TEST_LAT}&lon=${TEST_LNG}&token=${REGRID_API_KEY}&fields=fields.basic,fields.owner`,
    },
    {
      label: 'v1_search',
      url: `https://app.regrid.com/api/v1/search.json?query=${TEST_LAT},${TEST_LNG}&token=${REGRID_API_KEY}`,
    },
  ];

  // env_set guard above guarantees REGRID_API_KEY is a string here, but TS
  // can't narrow across the early-return — non-null assert for clean typing.
  const TOKEN: string = REGRID_API_KEY!;
  const results: any[] = [];
  for (const t of tests) {
    const r = await probe(t.url);
    results.push({
      endpoint: t.label,
      url_redacted: t.url.replace(TOKEN, 'TOKEN'),
      ...r,
    });
  }

  // Verdict
  const anyOk = results.find((r) => r.ok && r.parcel_count > 0);
  let verdict = 'all_failed';
  let recommendation = '';
  if (anyOk) {
    verdict = 'healthy';
    recommendation = `Regrid is working via the "${anyOk.endpoint}" endpoint. Latency ${anyOk.latency_ms}ms. App should switch to Regrid now.`;
  } else if (token_payload?.is_expired) {
    verdict = 'token_expired';
    recommendation = `Token expired at ${token_payload.exp}. Get a new trial token from app.regrid.com.`;
  } else if (results.every((r) => r.status === 401 || r.status === 403)) {
    verdict = 'token_invalid';
    recommendation = 'All endpoints returned 401/403. Token may be invalid, expired, or missing required capabilities.';
  } else if (results.every((r) => r.status === 404)) {
    verdict = 'wrong_endpoints';
    recommendation = 'All three URL shapes returned 404. Regrid may have changed their API since this code was written.';
  } else {
    verdict = 'mixed_failures';
    recommendation = 'See per-endpoint results below for details.';
  }

  return NextResponse.json({
    verdict,
    recommendation,
    env_set,
    token_preview,
    token_payload,
    test_location: `${TEST_LAT},${TEST_LNG} (Frio County, TX)`,
    results,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

#!/usr/bin/env node
//
// Local E2E test harness for /api/import-pdf-orchestrator.
//
// PURPOSE
// ───────
// Validates that PDF extraction works end-to-end on the LIVE
// orchestrator route — same code path the broker hits — without
// touching production. Catches regressions in seconds instead of
// "push to prod → broker tests → finds bug" feedback loops that
// cost an hour per cycle.
//
// USAGE
// ─────
//   # Terminal 1
//   npm run dev
//
//   # Terminal 2 (once Next.js prints "Ready"):
//   node scripts/test-orchestrator-e2e.mjs
//
// EXPECTED RESULT (after current fixes are stable):
//   ✓ Thorndale: 6 comps in < 60s, J-Bar Burleson, KWO with boundary
//   ✓ Fritz Farm: improvements_value=$765k with source citation
//
// When any test fails, the script exits non-zero and prints exactly
// which assertion broke. That signal tells me whether to push or
// keep iterating locally.

import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BASE = process.env.HARNESS_BASE_URL || 'http://localhost:3000';

// ─── Test fixtures (paths to PDFs we already have locally) ───────────────
const FIXTURES = {
  thorndale: {
    path: '/Users/louieswope/Downloads/Retrospective Appraisal Report_A-25-0165, 5098 FM 486, Thorndale.pdf',
    expect: {
      min_comps: 6,
      max_elapsed_ms: 90_000,
      // Counties of Thorndale's 6 land sales in order.
      // (Property names aren't reliably extracted from Stouffer-style
      // identification tables — they live in Remarks prose. That's a
      // separate prompt quality fix. Counties are robust.)
      counties_in_order: ['burleson', 'williamson', 'milam', 'williamson', 'milam', 'milam'],
      // Per-comp acreage sanity check (within ±5%).
      acres_in_order: [244.86, 73.62, 105.55, 87.99, 87.51, 339.79],
    },
  },
  fritzFarm: {
    path: '/Users/louieswope/Downloads/fwdfriofarms/June2022.536.01Acres.$8489Acre.Farm.pdf',
    expect: {
      min_comps: 1,
      max_elapsed_ms: 60_000,
      fritz_improvements_value: 765000,
      fritz_improvements_source_contains: ['irrigation', 'barn'],
    },
  },
};

// ─── Util ────────────────────────────────────────────────────────────────
function pass(msg) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg) {
  console.log(`  ✗ ${msg}`);
  process.exitCode = 1;
}
function header(label) {
  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  ${label}`);
  console.log(`══════════════════════════════════════════════════════════════════`);
}

async function fixtureExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function postPdf(filePath, name) {
  const buf = await readFile(filePath);
  const blob = new Blob([buf], { type: 'application/pdf' });
  const fd = new FormData();
  fd.append('file', blob, name);

  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/import-pdf-orchestrator`, {
    method: 'POST',
    body: fd,
  });
  const elapsed_ms = Date.now() - t0;
  // Read text first so we can see what the server actually returned
  // when it isn't valid JSON (500 HTML pages, empty bodies, etc.) —
  // otherwise `await res.json()` throws an unhelpful "Unexpected end
  // of JSON input" and hides the real failure mode.
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { __parseError: true, __bodyPreview: text.slice(0, 500) };
  }
  return { res, data, elapsed_ms };
}

// ─── Server ready check ─────────────────────────────────────────────────
async function waitForServer() {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok || r.status === 404) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ─── Tests ───────────────────────────────────────────────────────────────
async function testThorndale() {
  header('Test 1: Thorndale 71-page Stouffer appraisal');
  const f = FIXTURES.thorndale;
  if (!(await fixtureExists(f.path))) {
    console.log(`  ⊘ skipped — fixture missing at ${f.path}`);
    return;
  }
  const { res, data, elapsed_ms } = await postPdf(f.path, 'thorndale.pdf');
  console.log(`  · HTTP ${res.status} in ${(elapsed_ms / 1000).toFixed(1)}s`);

  if (res.status !== 200) {
    fail(`HTTP status ${res.status} (expected 200). Response: ${JSON.stringify(data).slice(0, 300)}`);
    return;
  }
  if (!Array.isArray(data.comps)) {
    fail(`data.comps is not an array. Got: ${typeof data.comps}`);
    return;
  }

  if (data.comps.length >= f.expect.min_comps) pass(`comps count ${data.comps.length} ≥ ${f.expect.min_comps}`);
  else fail(`comps count ${data.comps.length} < ${f.expect.min_comps}`);

  if (elapsed_ms <= f.expect.max_elapsed_ms) pass(`elapsed ${(elapsed_ms / 1000).toFixed(1)}s ≤ ${f.expect.max_elapsed_ms / 1000}s`);
  else fail(`elapsed ${(elapsed_ms / 1000).toFixed(1)}s > ${f.expect.max_elapsed_ms / 1000}s`);

  // Per-comp checks: county order + acreage match
  const normalize = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/\bcounty\b/g, '')
      .trim();
  const actualCounties = data.comps.map((c) => normalize(c.county));
  let countyOrderOk = true;
  for (let i = 0; i < f.expect.counties_in_order.length && i < actualCounties.length; i++) {
    if (!actualCounties[i].includes(f.expect.counties_in_order[i])) {
      countyOrderOk = false;
      break;
    }
  }
  if (countyOrderOk) {
    pass(`counties in expected order: [${actualCounties.join(', ')}]`);
  } else {
    fail(`counties out of order. Expected: [${f.expect.counties_in_order.join(', ')}], got: [${actualCounties.join(', ')}]`);
  }

  const actualAcres = data.comps.map((c) => Number(c.acres));
  let acresOk = true;
  for (let i = 0; i < f.expect.acres_in_order.length && i < actualAcres.length; i++) {
    const expected = f.expect.acres_in_order[i];
    const got = actualAcres[i];
    if (!Number.isFinite(got) || Math.abs(got - expected) / expected > 0.05) {
      acresOk = false;
      break;
    }
  }
  if (acresOk) {
    pass(`acreages within 5% of expected: [${actualAcres.map((a) => a?.toFixed?.(2) ?? '?').join(', ')}]`);
  } else {
    fail(`acreages off. Expected: [${f.expect.acres_in_order.join(', ')}], got: [${actualAcres.map((a) => a?.toFixed?.(2) ?? '?').join(', ')}]`);
  }

  // evidence_pages: every comp must list ≥1 page number. This is what
  // the ConvertAPI loop needs to render the aerial thumbnail + slice
  // the source-pages PDF. If GPT returns [] or null for any comp, the
  // ConvertAPI loop will skip it and the broker won't get an aerial
  // overlay for that comp.
  const epReport = data.comps.map((c, i) => {
    const ep = c.evidence_pages;
    return `#${i + 1}: ${Array.isArray(ep) ? `[${ep.join(',')}]` : String(ep)}`;
  });
  const allHavePages = data.comps.every((c) => Array.isArray(c.evidence_pages) && c.evidence_pages.length > 0 && c.evidence_pages.every((n) => Number.isInteger(n) && n > 0));
  if (allHavePages) {
    pass(`evidence_pages populated on all comps: ${epReport.join(' ')}`);
  } else {
    fail(`evidence_pages missing/empty on some comp. Got: ${epReport.join(' ')}`);
  }

  // aerial_thumbnail_data_url: ConvertAPI renders evidence_pages[0]
  // as a JPG and inlines it as a base64 data URL on each comp. This
  // is the map-corner overlay brokers use to compare the appraiser's
  // aerial against the parcel they're refining. Catch regressions
  // here (silently missing thumbnails would just leave a blank
  // corner in the UI — exactly the failure mode we want to prevent).
  const allHaveThumbs = data.comps.every((c) => typeof c.aerial_thumbnail_data_url === 'string' && c.aerial_thumbnail_data_url.startsWith('data:image/jpeg;base64,') && c.aerial_thumbnail_data_url.length > 5000);
  if (allHaveThumbs) {
    const totalKB = data.comps.reduce((s, c) => s + (c.aerial_thumbnail_data_url?.length ?? 0), 0) / 1024;
    pass(`aerial thumbnails attached to all ${data.comps.length} comps (${totalKB.toFixed(0)}KB total inline payload)`);
  } else {
    const missing = data.comps.map((c, i) => `#${i + 1}=${c.aerial_thumbnail_data_url ? c.aerial_thumbnail_data_url.slice(0, 30) + '…' : 'null'}`).join(', ');
    fail(`aerial_thumbnail_data_url missing/invalid on some comp: ${missing}`);
  }

  // Diagnostic summary
  if (data.diagnostic) {
    console.log(`  · diagnostic: primary=${data.diagnostic.primary}, reason=${data.diagnostic.routing_reason}`);
    if (data.diagnostic.gpt) console.log(`    GPT: ${data.diagnostic.gpt.ok ? `${data.diagnostic.gpt.comps} comps in ${(data.diagnostic.gpt.elapsed_ms / 1000).toFixed(1)}s` : `FAIL ${data.diagnostic.gpt.error}`}`);
    if (data.diagnostic.claude) console.log(`    Claude: ${data.diagnostic.claude.ok ? `${data.diagnostic.claude.comps} comps in ${(data.diagnostic.claude.elapsed_ms / 1000).toFixed(1)}s` : `FAIL ${data.diagnostic.claude.error}`}`);
  }
}

async function testFritzFarm() {
  header('Test 2: Fritz Farm 2-page comp sheet');
  const f = FIXTURES.fritzFarm;
  if (!(await fixtureExists(f.path))) {
    console.log(`  ⊘ skipped — fixture missing at ${f.path}`);
    return;
  }
  const { res, data, elapsed_ms } = await postPdf(f.path, 'fritz-farm.pdf');
  console.log(`  · HTTP ${res.status} in ${(elapsed_ms / 1000).toFixed(1)}s`);

  if (res.status !== 200) {
    fail(`HTTP status ${res.status}. Response: ${JSON.stringify(data).slice(0, 300)}`);
    return;
  }
  if (!Array.isArray(data.comps)) {
    fail(`data.comps is not an array`);
    return;
  }

  if (data.comps.length >= f.expect.min_comps) pass(`comps count ${data.comps.length} ≥ ${f.expect.min_comps}`);
  else fail(`comps count ${data.comps.length} < ${f.expect.min_comps}`);

  if (elapsed_ms <= f.expect.max_elapsed_ms) pass(`elapsed ${(elapsed_ms / 1000).toFixed(1)}s ≤ ${f.expect.max_elapsed_ms / 1000}s`);
  else fail(`elapsed ${(elapsed_ms / 1000).toFixed(1)}s > ${f.expect.max_elapsed_ms / 1000}s`);

  // The Fritz Farm regression test: improvements_value MUST be $765k
  // (irrigation $575k + hay barn $190k). $190k = only the barn = the
  // bug we shipped fixes for. $0 = "irrigation isn't an improvement"
  // which the patched prompt explicitly rules out.
  const fritz = data.comps.find((c) =>
    String(c.property_name ?? '').toLowerCase().includes('fritz'),
  );
  if (!fritz) {
    fail(`Fritz Farm comp not found in response`);
    return;
  }
  const iv = Number(fritz.improvements_value);
  if (iv === f.expect.fritz_improvements_value) {
    pass(`improvements_value=$${iv.toLocaleString()} (matches $${f.expect.fritz_improvements_value.toLocaleString()})`);
  } else {
    fail(`improvements_value=$${iv.toLocaleString()} (expected $${f.expect.fritz_improvements_value.toLocaleString()})`);
  }

  // Source citation must reference both components
  const src = String(fritz.improvements_value_source ?? '').toLowerCase();
  for (const must of f.expect.fritz_improvements_source_contains) {
    if (src.includes(must.toLowerCase())) pass(`improvements_value_source mentions "${must}"`);
    else fail(`improvements_value_source missing "${must}". Got: "${fritz.improvements_value_source}"`);
  }

  // evidence_pages on the Fritz comp — sheet is 2 pages so we expect
  // at least [1] (typically [1, 2]).
  const ep = fritz.evidence_pages;
  if (Array.isArray(ep) && ep.length > 0 && ep.every((n) => Number.isInteger(n) && n > 0)) {
    pass(`evidence_pages=[${ep.join(',')}]`);
  } else {
    fail(`evidence_pages missing/empty. Got: ${JSON.stringify(ep)}`);
  }

  // Aerial thumbnail attached as inline base64 data URL
  const thumb = fritz.aerial_thumbnail_data_url;
  if (typeof thumb === 'string' && thumb.startsWith('data:image/jpeg;base64,') && thumb.length > 5000) {
    pass(`aerial thumbnail attached (${(thumb.length / 1024).toFixed(0)}KB inline)`);
  } else {
    fail(`aerial_thumbnail_data_url missing/invalid. Got: ${thumb ? thumb.slice(0, 60) + '…' : 'null'}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nTesting orchestrator at: ${BASE}`);
  console.log(`(make sure 'npm run dev' is running in another terminal)\n`);

  const ready = await waitForServer();
  if (!ready) {
    console.error(`✗ Server not responding at ${BASE} after 10s. Is 'npm run dev' running?`);
    process.exit(1);
  }
  console.log(`✓ Server is up`);

  await testThorndale();
  await testFritzFarm();

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  if (process.exitCode) {
    console.log(`  ✗ FAILED — see above`);
    console.log(`══════════════════════════════════════════════════════════════════\n`);
  } else {
    console.log(`  ✓ ALL PASSED`);
    console.log(`══════════════════════════════════════════════════════════════════\n`);
  }
}

main().catch((e) => {
  console.error('\n✗ Test harness crashed:', e.message);
  console.error(e.stack);
  process.exit(1);
});

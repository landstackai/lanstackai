#!/usr/bin/env node
//
// Test extraction on an MLS sold-sheet, then verify the extracted comp
// has what autoLocateInBrowser needs to find the parcel.
//
// autoLocateInBrowser (src/app/dashboard/import/page.tsx) requires:
//   • acres > 0
//   • county (non-empty string)
//   • At least one of (grantee / grantor / property_name) — owner signals
// If owner signals are missing, the locator falls back to
// geocodeAddressFallback, which needs:
//   • address field with a street number (e.g., "6661 State Highway 123")
//
// So a usable MLS extraction must produce EITHER (grantor + county + acres)
// OR (address-with-number + county + acres). Anything less and the comp
// lands in the vault without a map pin.

import { readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

async function loadEnv() {
  const envText = await readFile(resolve(__dirname, '..', '.env.local'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// EXACT excerpt of the production /api/import-chat prompt for the
// MLS-specific guidance. This is what determines whether the extraction
// puts agent names into grantor (wrong) or leaves them null (correct).
const IMPORT_SYSTEM_PROMPT = `You are a Texas land-comp extraction specialist. Read the document images \
and extract the comparable sale as JSON.

TYPE E — MLS Sold sheet / agent-facing listing summary:
  Layout looks like an MLS report (Sold/Closed status, DOM, list price, sold price, agent contact \
blocks, photos). Common headings: "Sold by:", "Listed by:", "Listing Agent:", "Selling Agent:", \
"Buyer's Agent:", "Co-Op Agent:", "Office:", "MLS #".
  → Extract as 1 comp. Set is_comparable=true.

  CRITICAL — these MLS roles are AGENTS, NOT grantor/grantee:
    * "Sold by:"        → the LISTING agent (NOT the seller)
    * "Listed by:"      → the LISTING agent
    * "Listing Agent:"  → the LISTING agent
    * "Selling Agent:"  → the BUYER'S agent (still an agent, not the buyer)
    * "Buyer's Agent:"  → the BUYER'S agent
    * "Co-Op Agent:"    → the cooperating agent
  None of these are parties to the deed. DO NOT put any of these names in grantor or grantee. If \
the MLS sheet doesn't separately show "Seller:" / "Owner:" / "Buyer:" fields, return grantor: null \
and grantee: null — better empty than wrong.

  An MLS sheet's "Address" field IS authoritative and should be extracted as the comp's address \
(we use it to drop a map pin when parcel lookup by owner is unavailable).

Return JSON: {"comps": [<one comp>], "message": "<short summary>"}. Each comp must include: \
property_name, county, state, acres, sale_price, sale_date (YYYY-MM-DD), grantor, grantee, \
address, price_per_acre, recording_number (if shown), is_comparable (true), is_subject_property \
(false), confidence: {overall: 0-100}.

Numeric fields must be NUMBERS, not strings. Sale dates in MLS sheets are usually labeled \
"Closed Date" or "Sold Date" — use that for sale_date.

For county, use just the FIRST county name as a string (e.g. "Wilson"), no "County" suffix.`;

async function renderPdfPages(pdfPath, outDir) {
  await mkdir(outDir, { recursive: true });
  for (const f of await readdir(outDir)) {
    if (f.endsWith('.jpg')) await rm(join(outDir, f));
  }
  await execFileAsync('pdftoppm', [
    '-jpeg', '-jpegopt', 'quality=85',
    '-r', '108',
    pdfPath,
    join(outDir, 'page'),
  ]);
  const files = (await readdir(outDir)).filter((f) => f.endsWith('.jpg')).sort();
  return files.map((f) => join(outDir, f));
}

async function pngToDataUrl(filePath) {
  const buf = await readFile(filePath);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function extract(images) {
  const userContent = [
    { type: 'text', text: `Extract the comparable land sale from this ${images.length}-page MLS sold sheet.` },
    ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: IMPORT_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
}

// Replicate autoLocate's input check (from autoLocateInBrowser in import/page.tsx).
function canAutoLocate(comp) {
  const acres = Number(comp?.acres);
  const county = String(comp?.county || '').trim();
  if (!Number.isFinite(acres) || acres <= 0 || !county) {
    return { ok: false, reason: 'missing acres or county' };
  }
  const ownerSignals = [comp.grantee, comp.grantor, comp.property_name]
    .filter((s) => typeof s === 'string' && s.trim().length > 0);
  if (ownerSignals.length === 0) {
    return { ok: false, reason: 'no owner signals — would fall back to geocodeAddressFallback' };
  }
  return { ok: true, signals: ownerSignals };
}

// Replicate geocodeAddressFallback's input check.
function canGeocodeAddress(comp) {
  const address = typeof comp?.address === 'string' ? comp.address.trim() : '';
  if (!address || !/\d/.test(address) || address.length < 6) {
    return { ok: false, reason: 'no street-number address to geocode' };
  }
  return { ok: true, address };
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) { console.error('usage: node scripts/test-mls-extract.mjs "/path/to/mls.pdf"'); process.exit(1); }
  await loadEnv();

  const renderDir = resolve(__dirname, '..', '.test-render-mls');
  console.log(`\nTesting MLS extraction: ${pdfPath}`);
  const pngs = await renderPdfPages(pdfPath, renderDir);
  console.log(`Rendered ${pngs.length} pages`);
  const images = await Promise.all(pngs.map(pngToDataUrl));

  console.log('Extracting via OpenAI (gpt-4o)...\n');
  const result = await extract(images);
  const comp = (result.comps || [])[0];
  if (!comp) {
    console.log('✗ NO COMP EXTRACTED');
    console.log('Raw message:', result.message);
    process.exit(1);
  }

  console.log('─ Extracted fields ─');
  console.log(`  property_name:     ${comp.property_name}`);
  console.log(`  address:           ${comp.address}`);
  console.log(`  county:            ${comp.county}`);
  console.log(`  state:             ${comp.state}`);
  console.log(`  acres:             ${comp.acres}`);
  console.log(`  sale_price:        ${comp.sale_price}`);
  console.log(`  price_per_acre:    ${comp.price_per_acre}`);
  console.log(`  sale_date:         ${comp.sale_date}`);
  console.log(`  grantor:           ${comp.grantor}`);
  console.log(`  grantee:           ${comp.grantee}`);

  console.log('\n─ Auto-locate readiness ─');
  const parcel = canAutoLocate(comp);
  if (parcel.ok) {
    console.log(`  ✓ Parcel lookup PATH: acres=${comp.acres}, county="${comp.county}", owner signals=[${parcel.signals.map((s) => '"' + s + '"').join(', ')}]`);
  } else {
    console.log(`  → Parcel lookup blocked: ${parcel.reason}`);
    const addr = canGeocodeAddress(comp);
    if (addr.ok) {
      console.log(`  ✓ Geocode fallback PATH: address="${addr.address}"`);
    } else {
      console.log(`  ✗ Geocode fallback also blocked: ${addr.reason}`);
      console.log(`  ↳ Comp would land in vault with NO MAP PIN`);
    }
  }

  console.log('\n─ Agent-vs-party check ─');
  // The MLS sheet has known agent names. Make sure none ended up in grantor/grantee.
  const agentRedFlags = ['stouffer', 'associates', 'realtor', 'listing agent', 'mls'];
  const grantorLower = (comp.grantor || '').toLowerCase();
  const granteeLower = (comp.grantee || '').toLowerCase();
  let flagged = false;
  for (const flag of agentRedFlags) {
    if (grantorLower.includes(flag)) { console.log(`  ✗ grantor contains "${flag}" — likely an agent name leaked into grantor`); flagged = true; }
    if (granteeLower.includes(flag)) { console.log(`  ✗ grantee contains "${flag}" — likely an agent name leaked into grantee`); flagged = true; }
  }
  if (!flagged) console.log('  ✓ No agent names in grantor/grantee');
}

main().catch((e) => { console.error('\nTest crashed:', e.message); process.exit(1); });

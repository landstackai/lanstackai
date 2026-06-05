#!/usr/bin/env node
//
// Auto-locate readiness sweep across every test PDF.
//
// For each PDF in the corpus, extract the comp(s) using the same prompt
// production uses, then check whether the resulting comp data carries
// what autoLocateInBrowser + geocodeAddressFallback need to find a
// parcel.
//
// Auto-locate inputs (mirrored from src/app/dashboard/import/page.tsx):
//
//   PARCEL MATCH path requires:
//     • acres > 0 (Number.isFinite)
//     • county (trimmed non-empty)
//     • At least one owner signal: grantee || grantor || property_name
//
//   ADDRESS FALLBACK path (when parcel match fails) requires:
//     • address contains at least one digit
//     • address length >= 6
//
//   IMPLICIT BYPASS:
//     • If the extracted comp already has latitude + longitude (e.g., the
//       "Geographic Location" field on Texas appraiser sheets), auto-
//       locate is SKIPPED entirely — those coords win. Sanity layer
//       NULLs them only if they're outside the state/CONUS bbox.
//
// A comp is "auto-locatable" if AT LEAST ONE path is satisfied. A comp
// with NEITHER path satisfied lands in the vault without a map pin.

import { readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
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

const PROMPT = `You are a Texas land-comp extraction specialist. Extract comparable sales as JSON.

For single-property docs (1-3 pages): extract ONE comp.
For MLS sold sheets: extract ONE comp. Names like "Sold by:", "Listed by:", "Listing Agent:" are \
AGENTS, NOT grantor/grantee — leave grantor/grantee null if only agents are named.

Return JSON: {"comps": [...], "message": "..."}. Each comp must include: property_name, county \
(first county only, string, no "County" suffix), state, acres (number), sale_price (number), \
price_per_acre (number — if not stated, compute sale_price/acres), sale_date (YYYY-MM-DD), \
grantor, grantee, address (street + city when present, used for map pin fallback), \
latitude, longitude (ONLY if the doc EXPLICITLY prints "Geographic Location" lat;lng — never \
geocode from text), legal_description, recording_number, is_comparable (true), \
is_subject_property (false), confidence: {overall: 0-100}.

For multi-comp docs (5+ pages with "Land Sale 1" / "Comp 1" / etc. headers), extract ALL comps.`;

async function renderPdf(pdfPath, outDir) {
  await mkdir(outDir, { recursive: true });
  for (const f of await readdir(outDir)) {
    if (f.endsWith('.jpg')) await rm(join(outDir, f));
  }
  await execFileAsync('pdftoppm', [
    '-jpeg', '-jpegopt', 'quality=85', '-r', '108', pdfPath, join(outDir, 'page'),
  ]);
  return (await readdir(outDir))
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((f) => join(outDir, f));
}

async function pngToDataUrl(p) {
  const buf = await readFile(p);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function extract(images) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: [
          { type: 'text', text: `Extract comparable sales from this ${images.length}-page document.` },
          ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
        ]},
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
}

function checkAutoLocate(comp) {
  // Implicit bypass: explicit lat/lng from the doc.
  if (comp.latitude != null && comp.longitude != null) {
    const lat = Number(comp.latitude);
    const lng = Number(comp.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { path: 'explicit-coords', ok: true, details: `(${lat}, ${lng})` };
    }
  }
  // Parcel path
  const acres = Number(comp.acres);
  const county = String(comp.county || '').trim();
  const parcelOk = Number.isFinite(acres) && acres > 0 && county.length > 0;
  if (parcelOk) {
    const ownerSignals = [comp.grantee, comp.grantor, comp.property_name]
      .filter((s) => typeof s === 'string' && s.trim().length > 0);
    if (ownerSignals.length > 0) {
      return { path: 'parcel-match', ok: true, details: `${county} / ${acres}ac / [${ownerSignals.join(' | ')}]` };
    }
  }
  // Geocode fallback
  const address = typeof comp.address === 'string' ? comp.address.trim() : '';
  if (address && /\d/.test(address) && address.length >= 6) {
    return { path: 'address-geocode', ok: true, details: address };
  }
  // None
  const why = [];
  if (!Number.isFinite(acres) || acres <= 0) why.push('no acres');
  if (!county) why.push('no county');
  if (!address) why.push('no address');
  return { path: 'NONE', ok: false, details: why.join(', ') };
}

async function processPdf(pdfPath) {
  const renderDir = resolve(__dirname, '..', '.test-render-autoloc',
    basename(pdfPath).replace(/[^\w.-]/g, '_').replace(/\.pdf$/, ''));
  const pngs = await renderPdf(pdfPath, renderDir);
  const images = await Promise.all(pngs.map(pngToDataUrl));
  const result = await extract(images);
  return result.comps || [];
}

async function main() {
  await loadEnv();

  // Build the corpus from the args (each path is either a PDF or a dir)
  const corpus = [];
  for (const arg of process.argv.slice(2)) {
    const stat = await readFile(arg).then(() => 'file').catch(() => 'dir');
    if (stat === 'file') {
      corpus.push(arg);
    } else {
      const files = (await readdir(arg)).filter((f) => f.endsWith('.pdf')).map((f) => join(arg, f));
      corpus.push(...files);
    }
  }
  if (!corpus.length) {
    console.error('usage: node scripts/test-autolocate-readiness.mjs <pdf-or-dir>...');
    process.exit(1);
  }

  console.log(`\nAuto-locate readiness sweep across ${corpus.length} PDFs\n`);
  let total = 0, locatable = 0;
  const byPath = { 'explicit-coords': 0, 'parcel-match': 0, 'address-geocode': 0, 'NONE': 0 };
  const failures = [];

  for (const pdf of corpus) {
    const name = basename(pdf);
    process.stdout.write(`${name}\n`);
    let comps;
    try { comps = await processPdf(pdf); }
    catch (e) { console.log(`  ✗ extract failed: ${e.message.slice(0, 80)}\n`); continue; }
    if (!comps.length) { console.log(`  ↳ 0 comps extracted\n`); continue; }
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      const r = checkAutoLocate(c);
      const tag = r.ok ? '✓' : '✗';
      const label = comps.length > 1 ? `comp ${i + 1}` : 'comp';
      console.log(`  ${tag} ${label}: ${r.path} — ${r.details}`);
      total++;
      if (r.ok) { locatable++; byPath[r.path]++; }
      else { byPath.NONE++; failures.push({ name, comp: c, reason: r.details }); }
    }
    console.log();
  }

  console.log('─ SUMMARY ─\n');
  console.log(`  Comps extracted:    ${total}`);
  console.log(`  Auto-locatable:     ${locatable}/${total}\n`);
  console.log(`  Path breakdown:`);
  console.log(`    explicit coords: ${byPath['explicit-coords']}`);
  console.log(`    parcel match:    ${byPath['parcel-match']}`);
  console.log(`    address geocode: ${byPath['address-geocode']}`);
  console.log(`    UNLOCATABLE:     ${byPath['NONE']}`);
  if (failures.length) {
    console.log(`\n  Unlocatable comps:`);
    for (const f of failures) console.log(`    • ${f.name}: ${f.reason}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

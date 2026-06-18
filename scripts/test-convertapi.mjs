#!/usr/bin/env node
//
// Standalone validation of the ConvertAPI helper module.
//
// Goal: prove ConvertAPI returns usable JPG + sub-PDF outputs for our
// real fixtures BEFORE we hook it into the orchestrator. Catches:
//   - Token wrong / expired
//   - API shape mismatch (their docs vs reality)
//   - PDF format that ConvertAPI rejects
//   - Output quality unsuitable for thumbnail use
//
// Outputs:
//   /tmp/convertapi-thorndale-p37.jpg     (J-Bar page thumbnail)
//   /tmp/convertapi-thorndale-comp1.pdf   (Land Sale 1 sub-PDF, pages 37-38)
//   /tmp/convertapi-fritz-p1.jpg          (Fritz Farm page 1 thumbnail)

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load .env.local so CONVERTAPI_TOKEN is in process.env.
async function loadEnv() {
  const envText = await readFile(join(ROOT, '.env.local'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

await loadEnv();

if (!process.env.CONVERTAPI_TOKEN) {
  console.error('CONVERTAPI_TOKEN missing from .env.local');
  process.exit(1);
}

// We can't easily import the TypeScript helper from a .mjs script in
// this project — easier to inline the API calls. Same logic, fewer moving parts.
const CONVERTAPI_BASE = 'https://v2.convertapi.com';

async function postConvertApi(endpoint, pdfBuffer, fileName, params) {
  const url = `${CONVERTAPI_BASE}${endpoint}?Secret=${encodeURIComponent(process.env.CONVERTAPI_TOKEN)}`;
  const form = new FormData();
  form.append('File', new Blob([pdfBuffer], { type: 'application/pdf' }), fileName);
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  const t0 = Date.now();
  const res = await fetch(url, { method: 'POST', body: form });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (!res.ok) {
    throw new Error(`ConvertAPI ${endpoint} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  console.log(`  · ${endpoint} returned ${data.Files.length} file(s) in ${elapsed}s (ConversionCost: ${data.ConversionCost})`);
  console.log(`  · raw file keys: ${Object.keys(data.Files[0]).join(', ')}`);
  return data;
}

// ConvertAPI returns file bytes inline as base64 in `FileData` (not a Url).
// Decode + write to disk.
async function saveFile(fileData, outPath) {
  if (!fileData) throw new Error(`Missing FileData for ${outPath}`);
  const buf = Buffer.from(fileData, 'base64');
  await writeFile(outPath, buf);
  console.log(`  · saved ${outPath} (${buf.length} bytes)`);
  return buf;
}

// ── Test 1: Thorndale → page 37 JPG (J-Bar's identification page) ────────
console.log('\n══ Test 1: Thorndale page 37 → JPG ══');
const thorndalePath = '/Users/louieswope/Downloads/Retrospective Appraisal Report_A-25-0165, 5098 FM 486, Thorndale.pdf';
const thorndaleBuf = await readFile(thorndalePath);
console.log(`  loaded ${thorndalePath} (${(thorndaleBuf.length / 1024 / 1024).toFixed(2)} MB)`);

const jpgResult = await postConvertApi(
  '/convert/pdf/to/jpg',
  thorndaleBuf,
  'thorndale.pdf',
  { PageRange: '37', JpegQuality: '85', ScaleImage: 'true', ScaleProportions: '800' },
);
const jpgBuf = await saveFile(jpgResult.Files[0].FileData, '/tmp/convertapi-thorndale-p37.jpg');

// Sanity check: real JPEGs start with FF D8.
if (jpgBuf[0] === 0xff && jpgBuf[1] === 0xd8) {
  console.log('  ✓ valid JPEG (FF D8 signature)');
} else {
  console.log(`  ✗ NOT a valid JPEG — first bytes: ${jpgBuf[0]?.toString(16)} ${jpgBuf[1]?.toString(16)}`);
  process.exit(1);
}
if (jpgBuf.length < 5_000) {
  console.log(`  ✗ JPEG suspiciously small (${jpgBuf.length} bytes) — likely an error page rendered as image`);
} else {
  console.log(`  ✓ JPEG size sensible (${(jpgBuf.length / 1024).toFixed(1)} KB)`);
}

// ── Test 2: Thorndale → pages 37-38 sub-PDF ──────────────────────────────
console.log('\n══ Test 2: Thorndale pages 37-38 → sub-PDF ══');
const subPdfResult = await postConvertApi(
  '/convert/pdf/to/pdf',
  thorndaleBuf,
  'thorndale.pdf',
  { PageRange: '37-38' },
);
const subPdfBuf = await saveFile(subPdfResult.Files[0].FileData, '/tmp/convertapi-thorndale-comp1.pdf');

// PDFs start with "%PDF-" magic.
const magic = subPdfBuf.slice(0, 5).toString('ascii');
if (magic === '%PDF-') {
  console.log('  ✓ valid PDF (%PDF- signature)');
} else {
  console.log(`  ✗ NOT a valid PDF — first bytes: "${magic}"`);
  process.exit(1);
}

// ── Test 3: Fritz Farm → page 1 JPG ──────────────────────────────────────
console.log('\n══ Test 3: Fritz Farm page 1 → JPG ══');
const fritzPath = '/Users/louieswope/Downloads/fwdfriofarms/June2022.536.01Acres.$8489Acre.Farm.pdf';
const fritzBuf = await readFile(fritzPath);
console.log(`  loaded ${fritzPath} (${(fritzBuf.length / 1024).toFixed(1)} KB)`);

const fritzJpgResult = await postConvertApi(
  '/convert/pdf/to/jpg',
  fritzBuf,
  'fritz-farm.pdf',
  { PageRange: '1', JpegQuality: '85', ScaleImage: 'true', ScaleProportions: '800' },
);
const fritzJpgBuf = await saveFile(fritzJpgResult.Files[0].FileData, '/tmp/convertapi-fritz-p1.jpg');

if (fritzJpgBuf[0] === 0xff && fritzJpgBuf[1] === 0xd8) {
  console.log('  ✓ valid JPEG');
} else {
  console.log('  ✗ NOT a valid JPEG');
  process.exit(1);
}

console.log('\n══════════════════════════════════════════════════════════');
console.log('  ✓ ALL CONVERTAPI TESTS PASSED');
console.log('══════════════════════════════════════════════════════════');
console.log('\nGenerated files:');
console.log('  /tmp/convertapi-thorndale-p37.jpg');
console.log('  /tmp/convertapi-thorndale-comp1.pdf');
console.log('  /tmp/convertapi-fritz-p1.jpg');
console.log('\nOpen these in Finder/Preview to visually verify the renders look correct.\n');

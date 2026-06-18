#!/usr/bin/env node
//
// Batch end-to-end validator for the aerial-thumbnail + source-pages
// pipeline. Proves the full chain works on real PDFs BEFORE we wire
// ConvertAPI into the orchestrator:
//
//   1. POST PDF → orchestrator → comps with evidence_pages
//   2. For each comp:
//      a. POST PDF → ConvertAPI /pdf/to/jpg with PageRange=evidence_pages[0]
//         → 800px JPG (the aerial thumbnail for that comp)
//      b. POST PDF → ConvertAPI /pdf/to/pdf with PageRange=evidence_pages
//         → standalone sub-PDF (the "view source pages" file)
//   3. Validate magic bytes (FF D8 for JPG, %PDF- for PDF) and that
//      every output is non-trivially small (>5KB JPG, >1KB PDF).
//   4. Save all outputs to /tmp/thumbtest/ so the user can visually
//      verify the renders look correct (open in Preview).
//
// Why this matters: I don't want to hook ConvertAPI into the
// orchestrator and only find out in production that 30% of broker PDFs
// produce blank or corrupted thumbnails. This script proves the
// pipeline holds on Christina's Frio Farms set + larger Hill Country
// ranches before we ship the integration.
//
// Usage:
//   HARNESS_BASE_URL=http://localhost:3001 node scripts/batch-validate-thumbnails.mjs

import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BASE = process.env.HARNESS_BASE_URL || 'http://localhost:3000';
const OUTDIR = '/tmp/thumbtest';
const CONVERTAPI_BASE = 'https://v2.convertapi.com';

// Load CONVERTAPI_TOKEN from .env.local
async function loadEnv() {
  const envText = await readFile(join(ROOT, '.env.local'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Only the PDFs that we already know succeeded extraction (from the
// batch-validate-evidence-pages run). Saves ConvertAPI ops on the 4
// known-broken PDFs.
const FIXTURES = [
  '/Users/louieswope/Downloads/Retrospective Appraisal Report_A-25-0165, 5098 FM 486, Thorndale.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/April2023.L&DFarmAndRanch.1179.115Acres.$4750Acre.Farm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/August2023.Bennett.Farm.1413.345Acres.$5300Acre.Farm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/February2023.RanchoMendiola,LLC.2,094.94Acres.$4,296Ac..pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/January2023.318.03Acres.$4536Acre.Farm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/January2025.FritzFarm.341.17Acres.$7,208Ac.IrrigatedFarm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/June2022.492.959Acres.$6000Acre.Farm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/June2022.536.01Acres.$8489Acre.Farm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/May2022.320.08Acres.$8000Acre.Farm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/October2024.Lopez.Farm.219.579Acres.$9,108Ac.Irr..pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/September2023.57Farm.1084.63Acres.$6408Acre.Farm.pdf',
  '/Users/louieswope/Downloads/March2024.Bagan.184.78Acres.$29,495Ac..pdf',
  '/Users/louieswope/Downloads/June2023.DiamondYRanch.574.587Acres.$25,671Ac..pdf',
];

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function postPdfToOrchestrator(filePath) {
  const buf = await readFile(filePath);
  const blob = new Blob([buf], { type: 'application/pdf' });
  const fd = new FormData();
  fd.append('file', blob, basename(filePath));
  const res = await fetch(`${BASE}/api/import-pdf-orchestrator`, { method: 'POST', body: fd });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { __raw: text.slice(0, 200) }; }
  return { res, data, pdfBuffer: buf };
}

async function convertApi(endpoint, pdfBuf, params) {
  const url = `${CONVERTAPI_BASE}${endpoint}?Secret=${encodeURIComponent(process.env.CONVERTAPI_TOKEN)}`;
  const fd = new FormData();
  fd.append('File', new Blob([pdfBuf], { type: 'application/pdf' }), 'source.pdf');
  for (const [k, v] of Object.entries(params)) fd.append(k, v);
  const res = await fetch(url, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`ConvertAPI ${endpoint} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (!data.Files?.length) throw new Error(`ConvertAPI ${endpoint} returned no files`);
  return Buffer.from(data.Files[0].FileData, 'base64');
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function validJpeg(buf) {
  return buf.length > 5_000 && buf[0] === 0xff && buf[1] === 0xd8;
}
function validPdf(buf) {
  return buf.length > 1_000 && buf.slice(0, 5).toString('ascii') === '%PDF-';
}

async function main() {
  await loadEnv();
  if (!process.env.CONVERTAPI_TOKEN) {
    console.error('CONVERTAPI_TOKEN missing from .env.local');
    process.exit(1);
  }
  await mkdir(OUTDIR, { recursive: true });
  console.log(`\nOrchestrator → ConvertAPI pipeline validation\n`);
  console.log(`Output dir: ${OUTDIR}\n`);

  let totalComps = 0;
  let totalJpgPass = 0;
  let totalJpgFail = 0;
  let totalPdfPass = 0;
  let totalPdfFail = 0;
  const failures = [];

  for (const path of FIXTURES) {
    const name = basename(path);
    if (!(await fileExists(path))) {
      console.log(`⊘ ${name} — fixture missing`);
      continue;
    }
    console.log(`\n══ ${name.slice(0, 70)}`);

    let comps, pdfBuffer;
    try {
      const { res, data, pdfBuffer: buf } = await postPdfToOrchestrator(path);
      if (res.status !== 200 || !Array.isArray(data.comps) || data.comps.length === 0) {
        console.log(`  ⊘ orchestrator returned no comps — skipping ConvertAPI calls`);
        continue;
      }
      comps = data.comps;
      pdfBuffer = buf;
    } catch (err) {
      console.log(`  ✗ orchestrator crash: ${err.message}`);
      failures.push({ fixture: name, stage: 'orchestrator', err: err.message });
      continue;
    }

    const fixSlug = slug(name);
    for (let i = 0; i < comps.length; i++) {
      const comp = comps[i];
      totalComps++;
      const ep = comp.evidence_pages;
      if (!Array.isArray(ep) || ep.length === 0) {
        console.log(`  · comp #${i + 1} (${comp.property_name ?? '?'}) — no evidence_pages, skipping`);
        continue;
      }

      const pageForThumb = ep[0];
      const range = ep.join(',');
      const compSlug = `${fixSlug}-c${i + 1}`;

      // 1. JPG thumbnail
      try {
        const jpgBuf = await convertApi('/convert/pdf/to/jpg', pdfBuffer, {
          PageRange: String(pageForThumb),
          JpegQuality: '85',
          ScaleImage: 'true',
          ScaleProportions: '800',
        });
        const jpgPath = join(OUTDIR, `${compSlug}-thumb-p${pageForThumb}.jpg`);
        await writeFile(jpgPath, jpgBuf);
        if (validJpeg(jpgBuf)) {
          totalJpgPass++;
          console.log(`  ✓ #${i + 1} thumb p${pageForThumb} → ${(jpgBuf.length / 1024).toFixed(0)}KB JPG`);
        } else {
          totalJpgFail++;
          console.log(`  ✗ #${i + 1} thumb p${pageForThumb} → bad bytes (size=${jpgBuf.length})`);
          failures.push({ fixture: name, comp: i + 1, stage: 'jpg-bytes' });
        }
      } catch (err) {
        totalJpgFail++;
        console.log(`  ✗ #${i + 1} thumb p${pageForThumb} → CRASH ${err.message}`);
        failures.push({ fixture: name, comp: i + 1, stage: 'jpg', err: err.message });
      }

      // 2. Sub-PDF slice
      try {
        const subPdf = await convertApi('/convert/pdf/to/pdf', pdfBuffer, { PageRange: range });
        const pdfPath = join(OUTDIR, `${compSlug}-pages-${ep.join('_')}.pdf`);
        await writeFile(pdfPath, subPdf);
        if (validPdf(subPdf)) {
          totalPdfPass++;
          console.log(`  ✓ #${i + 1} pages [${range}] → ${(subPdf.length / 1024).toFixed(0)}KB PDF`);
        } else {
          totalPdfFail++;
          console.log(`  ✗ #${i + 1} pages [${range}] → bad bytes (size=${subPdf.length})`);
          failures.push({ fixture: name, comp: i + 1, stage: 'pdf-bytes' });
        }
      } catch (err) {
        totalPdfFail++;
        console.log(`  ✗ #${i + 1} pages [${range}] → CRASH ${err.message}`);
        failures.push({ fixture: name, comp: i + 1, stage: 'pdf', err: err.message });
      }
    }
  }

  console.log(`\n${'═'.repeat(66)}`);
  console.log(`  Comps processed: ${totalComps}`);
  console.log(`  JPG thumbnails: ${totalJpgPass} pass · ${totalJpgFail} fail`);
  console.log(`  PDF slices:     ${totalPdfPass} pass · ${totalPdfFail} fail`);
  console.log(`${'═'.repeat(66)}`);

  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(`  · ${f.fixture} comp#${f.comp ?? '-'} [${f.stage}] ${f.err ?? ''}`);
    }
    process.exit(1);
  }
  console.log(`\nOpen ${OUTDIR}/ in Finder to spot-check renders:\n  open ${OUTDIR}\n`);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});

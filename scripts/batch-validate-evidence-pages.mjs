#!/usr/bin/env node
//
// Batch validator — confirms the evidence_pages schema change
// (compExtractionSchema.ts + IMPORT_SYSTEM_PROMPT addition) produces
// non-empty page arrays across a wide variety of real broker PDFs,
// not just the two Thorndale + Fritz Farm fixtures hardcoded into
// test-orchestrator-e2e.mjs.
//
// What it checks per PDF (structural, no ground truth needed):
//   - HTTP 200
//   - data.comps is an array with ≥1 entry
//   - every comp has evidence_pages as a non-empty array of positive
//     integers (this is the input ConvertAPI needs)
//
// What it does NOT check:
//   - acreage accuracy, county correctness, $/ac math — those need
//     known-truth fixtures (Thorndale + Fritz Farm already have those
//     in test-orchestrator-e2e.mjs).
//
// Usage:
//   node scripts/batch-validate-evidence-pages.mjs
//   HARNESS_BASE_URL=http://localhost:3001 node scripts/batch-validate-evidence-pages.mjs

import { readFile, access } from 'node:fs/promises';
import { basename } from 'node:path';

const BASE = process.env.HARNESS_BASE_URL || 'http://localhost:3000';

// Diverse fixture sample. Mix of:
//   - TYPE A single-property comp sheets (fwdfriofarms/* — Christina's set)
//   - TYPE A larger ranches in main Downloads (Diamond Y, Bagan, VC5)
//   - TYPE B multi-comp appraisal (Thorndale)
const FIXTURES = [
  // Multi-comp appraisal — the canonical TYPE B
  '/Users/louieswope/Downloads/Retrospective Appraisal Report_A-25-0165, 5098 FM 486, Thorndale.pdf',

  // Christina's Frio Farm comp sheets — TYPE A, 2-page sheets
  '/Users/louieswope/Downloads/fwdfriofarms/April2023.L&DFarmAndRanch.1179.115Acres.$4750Acre.Farm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/August2023.Bennett.Farm.1413.345Acres.$5300Acre.Farm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/February2023.RanchoMendiola,LLC.2,094.94Acres.$4,296Ac..pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/January2023.318.03Acres.$4536Acre.Farm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/January2025.FritzFarm.341.17Acres.$7,208Ac.IrrigatedFarm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/June2022.492.959Acres.$6000Acre.Farm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/June2022.536.01Acres.$8489Acre.Farm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/March2025.WeslaFarm.414.491Acres.$12,546Ac.IrrigatedFarm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/May2022.320.08Acres.$8000Acre.Farm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/November2023.WrightFarm.414.12Acres.$13,009Ac.IrrigatedFarm.pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/October2024.Lopez.Farm.219.579Acres.$9,108Ac.Irr..pdf',
  '/Users/louieswope/Downloads/fwdfriofarms/September2023.57Farm.1084.63Acres.$6408Acre.Farm.pdf',

  // Larger Hill Country / live-water ranches
  '/Users/louieswope/Downloads/April2024.SmileonSpringCreekRanch.124.31Acres.$64,355Ac.LWSpringCreek.pdf',
  '/Users/louieswope/Downloads/March2024.Bagan.184.78Acres.$29,495Ac..pdf',
  '/Users/louieswope/Downloads/February2025.VC5PropertiesLLC.234.22Acres.$22,628Ac.LW.BearCreek.pdf',
  '/Users/louieswope/Downloads/June2023.DiamondYRanch.574.587Acres.$25,671Ac..pdf',
];

async function fixtureExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function postPdf(filePath) {
  const buf = await readFile(filePath);
  const blob = new Blob([buf], { type: 'application/pdf' });
  const fd = new FormData();
  fd.append('file', blob, basename(filePath));

  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/import-pdf-orchestrator`, {
    method: 'POST',
    body: fd,
  });
  const elapsed_ms = Date.now() - t0;
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { __parseError: true, __body: text.slice(0, 200) };
  }
  return { res, data, elapsed_ms };
}

function validateEvidencePages(comps) {
  if (!Array.isArray(comps)) return { ok: false, reason: 'comps not an array' };
  if (comps.length === 0) return { ok: false, reason: 'comps empty' };
  const bad = [];
  comps.forEach((c, i) => {
    const ep = c.evidence_pages;
    if (!Array.isArray(ep) || ep.length === 0) {
      bad.push(`#${i + 1}: missing/empty`);
    } else if (!ep.every((n) => Number.isInteger(n) && n > 0)) {
      bad.push(`#${i + 1}: invalid ${JSON.stringify(ep)}`);
    }
  });
  return bad.length === 0
    ? { ok: true, summary: comps.map((c) => `[${c.evidence_pages.join(',')}]`).join(' ') }
    : { ok: false, reason: bad.join('; ') };
}

async function main() {
  console.log(`\nBatch validating evidence_pages at ${BASE}\n`);
  const results = [];

  for (const path of FIXTURES) {
    const name = basename(path).slice(0, 60);
    if (!(await fixtureExists(path))) {
      console.log(`  ⊘ ${name} — missing`);
      results.push({ name, status: 'missing' });
      continue;
    }
    try {
      const { res, data, elapsed_ms } = await postPdf(path);
      const seconds = (elapsed_ms / 1000).toFixed(1);
      if (res.status !== 200) {
        console.log(`  ✗ ${name} — HTTP ${res.status} in ${seconds}s`);
        results.push({ name, status: 'http_error', code: res.status });
        continue;
      }
      const check = validateEvidencePages(data.comps);
      if (check.ok) {
        console.log(`  ✓ ${name} — ${data.comps.length} comp(s) in ${seconds}s — ${check.summary}`);
        results.push({ name, status: 'pass', comps: data.comps.length, elapsed_ms });
      } else {
        console.log(`  ✗ ${name} — ${data.comps?.length ?? '?'} comp(s) in ${seconds}s — ${check.reason}`);
        results.push({ name, status: 'evidence_pages_fail', reason: check.reason });
      }
    } catch (err) {
      console.log(`  ✗ ${name} — CRASH ${err?.message ?? err}`);
      results.push({ name, status: 'crash', error: String(err?.message ?? err) });
    }
  }

  // Summary
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status !== 'pass' && r.status !== 'missing').length;
  const missing = results.filter((r) => r.status === 'missing').length;
  console.log(
    `\n${'═'.repeat(66)}\n` +
      `  ${pass} passed, ${fail} failed, ${missing} missing (of ${results.length})\n` +
      `${'═'.repeat(66)}\n`,
  );

  if (fail > 0) {
    console.log('Failures:');
    for (const r of results) {
      if (r.status !== 'pass' && r.status !== 'missing') {
        console.log(`  · ${r.name}: ${r.reason ?? r.error ?? `HTTP ${r.code}`}`);
      }
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});

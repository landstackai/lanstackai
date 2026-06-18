#!/usr/bin/env node
//
// Batch validate all 12 Frio Farms PDFs through the Claude PDF path.
// Once-and-for-all proof that Claude native-PDF extraction handles
// the full Christina set — the same PDFs that the GPT-text path
// silently dropped to 0 comps.
//
// Usage:
//   HARNESS_BASE_URL=http://localhost:3000 node scripts/batch-validate-frio-claude.mjs

import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const BASE = process.env.HARNESS_BASE_URL || 'http://localhost:3000';
const FRIO_DIR = '/Users/louieswope/Downloads/fwdfriofarms';

// Parse expected acres + $/ac out of the filename so we can sanity-check
// Claude's extraction against the broker's own naming.
// Filename pattern examples:
//   January2025.FritzFarm.341.17Acres.$7,208Ac.IrrigatedFarm.pdf
//   February2023.RanchoMendiola,LLC.2,094.94Acres.$4,296Ac..pdf
//   August2023.Bennett.Farm.1413.345Acres.$5300Acre.Farm.pdf
function parseFilename(name) {
  const acresMatch = name.match(/([\d,]+\.\d+)\s*Acres?/i);
  const ppaMatch = name.match(/\$\s*([\d,]+)\s*(?:Acre?|Ac)/i);
  const acres = acresMatch ? parseFloat(acresMatch[1].replace(/,/g, '')) : null;
  const ppa = ppaMatch ? parseInt(ppaMatch[1].replace(/,/g, ''), 10) : null;
  const expectedPrice = acres && ppa ? Math.round(acres * ppa) : null;
  return { acres, ppa, expectedPrice };
}

async function extractWithClaude(filePath) {
  const buf = await readFile(filePath);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), basename(filePath));
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/import-pdf-claude`, { method: 'POST', body: fd });
  const elapsed_ms = Date.now() - t0;
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { __parseError: true, __body: text.slice(0, 200) };
  }
  return { status: res.status, data, elapsed_ms };
}

async function main() {
  const allFiles = await readdir(FRIO_DIR);
  const pdfs = allFiles.filter((n) => n.endsWith('.pdf')).sort();
  console.log(`\nValidating ${pdfs.length} Frio Farms PDFs via Claude at ${BASE}\n`);

  let pass = 0;
  let fail = 0;
  const issues = [];

  for (const name of pdfs) {
    const path = join(FRIO_DIR, name);
    const expected = parseFilename(name);

    try {
      const { status, data, elapsed_ms } = await extractWithClaude(path);
      const seconds = (elapsed_ms / 1000).toFixed(1);

      if (status !== 200) {
        fail++;
        const reason = data.__parseError ? `non-JSON: ${data.__body}` : (data.error ?? data.message ?? `HTTP ${status}`);
        console.log(`✗ [${seconds}s] ${name.slice(0, 60)} — HTTP ${status} — ${String(reason).slice(0, 100)}`);
        issues.push({ name, reason });
        continue;
      }

      const comps = Array.isArray(data.comps) ? data.comps : [];
      if (comps.length === 0) {
        fail++;
        console.log(`✗ [${seconds}s] ${name.slice(0, 60)} — 0 comps`);
        issues.push({ name, reason: '0 comps' });
        continue;
      }

      // For single-property TYPE-A sheets we expect exactly 1 comp.
      const c = comps[0];
      const acresDelta = expected.acres && c.acres ? Math.abs(c.acres - expected.acres) / expected.acres : null;
      const priceDelta = expected.expectedPrice && c.sale_price ? Math.abs(c.sale_price - expected.expectedPrice) / expected.expectedPrice : null;
      const acresOk = acresDelta == null || acresDelta < 0.02; // 2% tolerance
      const priceOk = priceDelta == null || priceDelta < 0.02;

      const flags = [];
      if (!c.property_name) flags.push('NO NAME');
      if (!c.acres) flags.push('NO ACRES');
      if (!c.sale_price) flags.push('NO PRICE');
      if (!c.sale_date) flags.push('NO DATE');
      if (!acresOk) flags.push(`ACRES MISMATCH (got ${c.acres}, filename said ${expected.acres})`);
      if (!priceOk) flags.push(`PRICE MISMATCH (got ${c.sale_price}, expected ~${expected.expectedPrice})`);

      if (flags.length === 0) {
        pass++;
        console.log(`✓ [${seconds}s] ${name.slice(0, 60)}`);
        console.log(`         "${c.property_name}" · ${c.acres}ac · $${c.sale_price?.toLocaleString()} · ${c.sale_date} · ${c.county ?? '?'} · pages [${(c.evidence_pages || []).join(',')}]`);
      } else {
        fail++;
        console.log(`⚠ [${seconds}s] ${name.slice(0, 60)} — ${flags.join('; ')}`);
        console.log(`         "${c.property_name}" · ${c.acres}ac · $${c.sale_price?.toLocaleString?.() ?? c.sale_price} · ${c.sale_date}`);
        issues.push({ name, reason: flags.join('; ') });
      }
    } catch (err) {
      fail++;
      console.log(`✗ ${name.slice(0, 60)} — CRASH ${err?.message ?? err}`);
      issues.push({ name, reason: `crash: ${err?.message ?? err}` });
    }
  }

  console.log(`\n${'═'.repeat(66)}`);
  console.log(`  ${pass} passed, ${fail} failed (of ${pdfs.length})`);
  console.log(`${'═'.repeat(66)}\n`);

  if (issues.length > 0) {
    console.log('Issues:');
    for (const i of issues) console.log(`  · ${i.name}: ${i.reason}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('Harness crashed:', err); process.exit(1); });

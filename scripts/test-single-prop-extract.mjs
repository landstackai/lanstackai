#!/usr/bin/env node
//
// Local single-property extraction test.
//
// Tests the import-chat extraction path (the one short PDFs use,
// bypassing vision boundary detection) against a corpus of
// single-property comp sheets. Renders each PDF to JPEG images at
// production-equivalent scale, calls OpenAI with the same system
// prompt the /api/import-chat route uses, parses the response, and
// compares to expected values from the filename.
//
// Filename convention these PDFs use:
//   Month Year . PropertyName . Acres . PricePerAcre Ac . Type .pdf
// We parse acres + price-per-acre out of the filename to use as
// ground-truth for verification.

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

// Production extraction prompt — keep MIN to avoid copy drift. We
// import the gist here: the model returns a comps array with each
// comp's fields including acres, sale_price, sale_date, grantor,
// grantee, etc. This trimmed prompt focuses on what matters for
// single-property docs.
const IMPORT_SYSTEM_PROMPT = `You are a Texas land-comp extraction specialist. Read the document images \
and extract one comparable sale as JSON.

Single-property docs (1-3 pages, titled "Farm Sale", "Ranch Sale", "Land Sale", or similar) \
contain ONE sold property. Extract it as ONE comp.

Return JSON: {"comps": [<one comp>], "message": "<short summary>"}. \
Each comp must include: property_name, county, state, acres, sale_price, sale_date \
(YYYY-MM-DD), grantor, grantee, address (if any), legal description, price_per_acre, \
recording_number (if shown), is_comparable (true), is_subject_property (false), \
confidence: {overall: 0-100}.

Numeric fields must be NUMBERS, not strings. acres × price_per_acre should ≈ sale_price; \
if only two of those three are stated, derive the third arithmetically.

If a date is shown as "June 10, 2022", convert to "2022-06-10".

For county fields with multiple counties ("Atascosa & Frio"), use just the FIRST county \
as a string. Don't try to put both in one field.`;

function parseFilenameHints(filename) {
  // Examples:
  //   June2022.492.959Acres.$6000Acre.Farm.pdf → acres 492.959, ppa 6000
  //   October2024.Lopez.Farm.219.579Acres.$9,108Ac.Irr..pdf → acres 219.579, ppa 9108
  //   February2023.RanchoMendiola,LLC.2,094.94Acres.$4,296Ac..pdf → acres 2094.94, ppa 4296
  const name = basename(filename, '.pdf');
  // Acres: look for NNN.NNN[Acres|Ac]
  const acresMatch = name.match(/(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:Acres|Ac)/i);
  let acres = null;
  if (acresMatch) acres = Number(acresMatch[1].replace(/,/g, ''));
  // Price per acre: $NNNN[Acre|Ac]
  const ppaMatch = name.match(/\$([\d,]+)\s*(?:Acre|Ac)/i);
  let ppa = null;
  if (ppaMatch) ppa = Number(ppaMatch[1].replace(/,/g, ''));
  // Year
  const yearMatch = name.match(/(20\d{2})/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  return { acres, ppa, year };
}

async function renderPdfPages(pdfPath, outDir) {
  await mkdir(outDir, { recursive: true });
  for (const f of await readdir(outDir)) {
    if (f.endsWith('.jpg')) await rm(join(outDir, f));
  }
  await execFileAsync('pdftoppm', [
    '-jpeg', '-jpegopt', 'quality=85',
    '-r', '108', // scale ~1.5 for high-fidelity extraction
    pdfPath,
    join(outDir, 'page'),
  ]);
  const files = (await readdir(outDir))
    .filter((f) => f.endsWith('.jpg'))
    .sort();
  return files.map((f) => join(outDir, f));
}

async function pngToDataUrl(filePath) {
  const buf = await readFile(filePath);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function extract(images) {
  const userContent = [
    {
      type: 'text',
      text: `Extract the single comparable land sale from this ${images.length}-page document.`,
    },
    ...images.map((url) => ({
      type: 'image_url',
      image_url: { url, detail: 'high' },
    })),
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

  if (!res.ok) {
    return { error: `HTTP ${res.status}: ${await res.text()}` };
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(text);
  } catch (e) {
    return { error: `parse failed: ${e.message}`, raw: text.slice(0, 200) };
  }
}

function summarize(comp, hints) {
  if (!comp) return '✗ NO COMP EXTRACTED';
  const { acres, sale_price, price_per_acre, sale_date, grantor, grantee, county } = comp;
  const errors = [];
  if (hints.acres != null && acres != null) {
    const drift = Math.abs(acres - hints.acres) / hints.acres;
    if (drift > 0.05) errors.push(`acres ${acres} vs expected ~${hints.acres}`);
  } else if (hints.acres != null && acres == null) {
    errors.push('acres missing');
  }
  if (hints.ppa != null && price_per_acre != null) {
    const drift = Math.abs(price_per_acre - hints.ppa) / hints.ppa;
    if (drift > 0.05) errors.push(`ppa $${price_per_acre} vs expected ~$${hints.ppa}`);
  } else if (hints.ppa != null && price_per_acre == null) {
    errors.push('price_per_acre missing');
  }
  if (sale_date == null) errors.push('sale_date missing');
  if (grantor == null) errors.push('grantor missing');
  if (grantee == null) errors.push('grantee missing');
  if (county == null) errors.push('county missing');

  const ok = errors.length === 0;
  const status = ok ? '✓' : `✗ ${errors.join(', ')}`;
  return `${status}\n      acres=${acres}, sale_price=${sale_price}, ppa=${price_per_acre}, date=${sale_date}, grantor=${grantor}, grantee=${grantee}, county=${county}`;
}

async function main() {
  const corpusDir = process.argv[2];
  if (!corpusDir) {
    console.error('usage: node scripts/test-single-prop-extract.mjs <corpus-dir>');
    process.exit(1);
  }
  await loadEnv();

  const files = (await readdir(corpusDir))
    .filter((f) => f.endsWith('.pdf'))
    .sort();
  console.log(`\nTesting ${files.length} single-property PDFs from ${corpusDir}\n`);

  const renderRoot = resolve(__dirname, '..', '.test-render-corpus');
  await mkdir(renderRoot, { recursive: true });

  let pass = 0;
  let warn = 0;
  let fail = 0;
  const results = [];

  for (const file of files) {
    const pdfPath = join(corpusDir, file);
    const hints = parseFilenameHints(file);
    process.stdout.write(`${file}\n  hints: acres=${hints.acres}, ppa=$${hints.ppa}, year=${hints.year}\n`);

    const renderDir = join(renderRoot, file.replace(/\.pdf$/, ''));
    let images;
    try {
      const pngs = await renderPdfPages(pdfPath, renderDir);
      images = await Promise.all(pngs.map(pngToDataUrl));
    } catch (e) {
      console.log(`  ✗ render failed: ${e.message}`);
      fail++;
      continue;
    }

    const result = await extract(images);
    if (result.error) {
      console.log(`  ✗ extract error: ${result.error.slice(0, 100)}`);
      fail++;
      continue;
    }
    const comp = (result.comps || [])[0];
    const status = summarize(comp, hints);
    console.log(`  ${status}\n`);
    results.push({ file, hints, comp, status });

    if (status.startsWith('✓')) pass++;
    else if (comp) warn++;
    else fail++;
  }

  console.log(`\n─ SUMMARY ─\n`);
  console.log(`  ✓ clean pass:      ${pass}/${files.length}`);
  console.log(`  ⚠ extracted w/issues: ${warn}/${files.length}`);
  console.log(`  ✗ extraction failed:  ${fail}/${files.length}`);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});

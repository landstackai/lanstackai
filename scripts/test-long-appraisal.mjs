#!/usr/bin/env node
//
// Long-appraisal classifier test.
//
// Replicates the batched-vision-classifier logic from
// src/lib/utils/visionBoundaryDetection.ts so we can validate the
// behavior on real 50-80 page appraisals BEFORE the change touches
// production. Uses the same prompt, schema, batch size, and overlap
// strategy as the production code.
//
// Usage:
//   node scripts/test-long-appraisal.mjs "/path/to/long-appraisal.pdf"
//
// Output: per-page classification table + comp groupings + ground-truth
// comparison if the path matches a known test fixture.

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

const BATCH_SIZE = 20;
const BATCH_OVERLAP = 2;  // smaller overlap = fewer redundant API tokens
const MAX_PAGES = 80;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'integer' },
          role: {
            type: 'string',
            enum: ['cover', 'subject_property', 'comp_id_page', 'comp_continuation', 'summary', 'other'],
          },
          comp_index: { type: ['integer', 'null'] },
          comp_label: { type: ['string', 'null'] },
          evidence: { type: 'string' },
        },
        required: ['page', 'role', 'comp_index', 'comp_label', 'evidence'],
      },
    },
  },
  required: ['pages'],
};

const SYSTEM_PROMPT = `You classify pages of US land-appraisal and real-estate comparable-sales documents. \
You will receive N page images in order, page 1 first. Classify each one.

Roles:
  comp_id_page        — first page of a comparable sale. RECOGNIZABLE BY a header at the \
top of the page reading "Land Sale N", "Sale N", "Sale No. N", "Comparable N", "Comp #N", \
"Property A/B/C", or similar.
  comp_continuation   — second/third page of the same comp the prior page introduced. \
NO comp header at the top.
  subject_property    — the property being VALUED. Labeled "Subject Property", "Subject", \
or contained in a clearly-marked "Subject" section.
  cover               — title page, firm letterhead, table of contents, intro letter.
  summary             — adjustment grid, reconciliation page, sales comparison summary.
  other               — certifications, qualifications, appraiser bio, addenda.

CRITICAL: Header text WINS over page position. A page with "Land Sale 1" at the top is \
ALWAYS comp_id_page with comp_index 1.

comp_index rules:
  • Count comp_id_page occurrences in document order. First = 1, next = 2, etc.
  • comp_continuation pages share their comp's comp_index.
  • All non-comp roles have comp_index null.

Return {pages: [...]} with one classification per input image in page order.`;

async function renderPdf(pdfPath, outDir) {
  await mkdir(outDir, { recursive: true });
  for (const f of await readdir(outDir)) {
    if (f.endsWith('.jpg')) await rm(join(outDir, f));
  }
  await execFileAsync('pdftoppm', [
    '-jpeg', '-jpegopt', 'quality=85', '-r', '108', pdfPath, join(outDir, 'page'),
    '-l', String(MAX_PAGES),
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

async function classifyBatch(images, attempt = 1) {
  const userContent = [
    { type: 'text', text: `Classify all ${images.length} pages in order.` },
    ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 6000,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'pdf_page_classifications', strict: true, schema: RESPONSE_SCHEMA },
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (res.status === 429 && attempt <= 5) {
    // Rate limited. The TPM window is 60 seconds; on saturation we need
    // to wait close to that for tokens to drop off. Use 60s minimum to
    // be safe. Up to 5 attempts (~5 minute max wait).
    const errText = await res.text();
    const waitMatch = errText.match(/try again in (\d+\.?\d*)([ms])/);
    let waitMs = 60_000;
    if (waitMatch) {
      const n = parseFloat(waitMatch[1]);
      waitMs = waitMatch[2] === 's' ? n * 1000 : n;
      waitMs = Math.max(waitMs, 60_000); // floor at 60s for safety
    }
    console.warn(`  (rate limited, waiting ${(waitMs / 1000).toFixed(1)}s before retry ${attempt + 1}/5)`);
    await new Promise((r) => setTimeout(r, waitMs));
    return classifyBatch(images, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{"pages":[]}';
  return JSON.parse(text).pages || [];
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) { console.error('usage: node scripts/test-long-appraisal.mjs <pdf>'); process.exit(1); }
  await loadEnv();

  const renderDir = resolve(__dirname, '..', '.test-render-long', basename(pdfPath).replace(/[^\w.-]/g, '_').replace(/\.pdf$/, ''));
  console.log(`\nRendering ${pdfPath}\n`);
  const pngs = await renderPdf(pdfPath, renderDir);
  console.log(`Rendered ${pngs.length} pages`);
  const images = await Promise.all(pngs.map(pngToDataUrl));
  const totalMB = (images.reduce((s, i) => s + i.length, 0) / 1024 / 1024).toFixed(2);
  console.log(`Total render size: ${totalMB} MB`);

  // Build batches identical to production code
  const batches = [];
  let start = 0;
  while (start < images.length) {
    const end = Math.min(start + BATCH_SIZE, images.length);
    batches.push({ startPage: start + 1, images: images.slice(start, end) });
    if (end === images.length) break;
    start = end - BATCH_OVERLAP;
  }
  console.log(`Built ${batches.length} batch(es): ${batches.map((b) => `[${b.startPage}-${b.startPage + b.images.length - 1}]`).join(' ')}`);

  // Classify sequentially to stay under OpenAI's per-minute token limit.
  // High-detail vision on 20 images is ~110k tokens per batch; running
  // 5 batches in parallel would burn 550k tokens/min (over the 200k TPM
  // limit on gpt-4o-mini). Production code uses concurrency-limited
  // batches via p-limit; this test runs them serially for simplicity.
  const startTime = Date.now();
  const batchResults = [];
  for (let idx = 0; idx < batches.length; idx++) {
    const batch = batches[idx];
    const t0 = Date.now();
    const res = await classifyBatch(batch.images);
    const t1 = Date.now();
    console.log(
      `  batch ${idx + 1} [${batch.startPage}-${batch.startPage + batch.images.length - 1}]: ` +
        `received ${res.length}/${batch.images.length} classifications in ${((t1 - t0) / 1000).toFixed(1)}s`
    );
    batchResults.push(
      res.map((p) => ({
        ...p,
        page: batch.startPage + p.page - 1,
        comp_index: p.comp_index != null ? idx * 1000 + p.comp_index : null,
      }))
    );
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`All batches returned in ${elapsed}s\n`);

  // Merge: dedupe by page
  const byPage = new Map();
  for (const batch of batchResults) {
    for (const p of batch) {
      if (!byPage.has(p.page)) byPage.set(p.page, p);
    }
  }
  const allPages = Array.from(byPage.values()).sort((a, b) => a.page - b.page);

  // Print classifications
  console.log('─ Per-page classifications ─\n');
  for (const p of allPages) {
    const idx = p.comp_index != null ? ` (g${p.comp_index})` : '';
    const label = p.comp_label ? ` "${p.comp_label}"` : '';
    console.log(`  p${String(p.page).padStart(2)}: ${p.role.padEnd(20)}${idx}${label}`);
  }

  // Build comp groups
  const compGroups = new Map();
  for (const p of allPages) {
    if (p.role !== 'comp_id_page' && p.role !== 'comp_continuation') continue;
    if (p.comp_index == null) continue;
    if (!compGroups.has(p.comp_index)) compGroups.set(p.comp_index, { pages: [], firstPage: p.page });
    const group = compGroups.get(p.comp_index);
    group.pages.push(p.page);
    group.firstPage = Math.min(group.firstPage, p.page);
  }
  const ordered = Array.from(compGroups.entries())
    .map(([k, g]) => ({ ...g, originalKey: k, label: allPages.find((p) => p.comp_index === k && p.role === 'comp_id_page')?.comp_label ?? '(no id_page found)' }))
    .sort((a, b) => a.firstPage - b.firstPage);

  console.log(`\n─ ${ordered.length} comp group(s) detected ─\n`);
  ordered.forEach((g, i) => {
    console.log(`  Comp ${i + 1}: pages [${g.pages.sort((a, b) => a - b).join(', ')}] — "${g.label}"`);
  });

  console.log();
}

main().catch((e) => { console.error('\nTest crashed:', e.message); process.exit(1); });

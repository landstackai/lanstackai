#!/usr/bin/env node
//
// Local vision classifier test.
//
// Renders the PDF's pages to PNGs (via pdftoppm), sends them to OpenAI's
// vision API in a single batched call using the EXACT prompt and schema
// our production classifier uses, then prints what comes back. This lets
// us see — without involving the browser, Vercel, or a broker — whether
// the classifier produces a correct CompMap on a real document.
//
// Ground truth for New Braunfels for Christina.pdf (10 pages, 5 comps):
//   page 1 — Land Sale 1 ID page (header + transaction data)
//   page 2 — Land Sale 1 continuation (property description + remarks)
//   page 3 — Land Sale 2 ID page
//   page 4 — Land Sale 2 continuation
//   page 5 — Land Sale 3 ID page
//   page 6 — Land Sale 3 continuation
//   page 7 — Land Sale 4 ID page
//   page 8 — Land Sale 4 continuation
//   page 9 — Land Sale 5 ID page
//   page 10 — Land Sale 5 continuation
//
// Correct classifier output:
//   pages 1,3,5,7,9 → comp_id_page with comp_index 1..5 in order
//   pages 2,4,6,8,10 → comp_continuation with comp_index 1..5 in order
//
// Anything different is a real bug to fix.

import { readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

// Load OPENAI_API_KEY from .env.local at the project root.
async function loadEnv() {
  const envPath = resolve(__dirname, '..', '.env.local');
  const envText = await readFile(envPath, 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PAGE_CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer' },
    role: {
      type: 'string',
      enum: [
        'cover',
        'subject_property',
        'comp_id_page',
        'comp_continuation',
        'summary',
        'other',
      ],
    },
    comp_index: { type: ['integer', 'null'] },
    comp_label: { type: ['string', 'null'] },
    evidence: { type: 'string' },
  },
  required: ['page', 'role', 'comp_index', 'comp_label', 'evidence'],
};

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pages: { type: 'array', items: PAGE_CLASSIFICATION_SCHEMA },
  },
  required: ['pages'],
};

const SYSTEM_PROMPT = `You classify pages of land-appraisal and real-estate comp documents. \
You will receive N page images in order, page 1 first. Classify each one.

Roles:
  cover               — title page, firm letterhead, table of contents, intro letter
  subject_property    — the property BEING VALUED (the appraisal's subject, not a comparable)
  comp_id_page        — first page of a COMPARABLE sale: contains the comp header \
("Land Sale N", "Comparable N", "Sale N", "Comp N", "Property A", or similar) plus the \
identification table, transaction data, sale price, dates, etc.
  comp_continuation   — second or third page of the SAME comp the prior page introduced: \
property description, remarks, photos, plat. Does NOT have its own comp header.
  summary             — adjustment grid, summary table, reconciliation page at end
  other               — certifications, qualifications, appraiser bio, addenda

comp_index rules:
  • Count comparable sales in the order they appear in the document. The first comp \
you see is comp_index 1, the next is 2, and so on. ALWAYS contiguous: 1, 2, 3, … (no gaps).
  • A subject property is NEVER a comp — set comp_index null for subject_property pages.
  • comp_continuation pages share the comp_index of the comp they continue.
  • cover, subject_property, summary, other pages all have comp_index null.

comp_label rules:
  • Copy the label EXACTLY as it appears on the page: "Land Sale 1", "Sale No. 2", "Comp #3", \
"Property B", etc. Preserve capitalization and punctuation.
  • If the page has no visible label but is clearly a comp page, infer from context \
(e.g. "Comp 2" if it's the second comp you've encountered).
  • Null for non-comp pages.

evidence: one sentence describing what made you classify the page this way. Examples: \
"Header reads 'LAND SALE 1' at top, Transaction Data table below." Keep it factual.

Be conservative. Subjects usually appear at the front, before any "Sale 1" header; comps \
appear after. When in doubt about role, prefer 'other' over guessing.

Return an object with key 'pages' whose value is an array of classifications, one per \
input image, in page order.`;

async function renderPdfPages(pdfPath, outDir) {
  // pdftoppm -png -r 75 input.pdf outprefix → outprefix-1.png, outprefix-2.png, ...
  // 75 DPI ≈ 600×800 page renders. Matches the scale 0.5 the client uses.
  await mkdir(outDir, { recursive: true });
  // Clean any prior runs
  for (const f of await readdir(outDir)) {
    if (f.endsWith('.png')) await rm(join(outDir, f));
  }
  await execFileAsync('pdftoppm', [
    '-png',
    '-r', '75',
    pdfPath,
    join(outDir, 'page'),
  ]);
  const files = (await readdir(outDir))
    .filter((f) => f.endsWith('.png'))
    .sort((a, b) => {
      const an = parseInt(a.match(/(\d+)/)?.[1] || '0', 10);
      const bn = parseInt(b.match(/(\d+)/)?.[1] || '0', 10);
      return an - bn;
    });
  return files.map((f) => join(outDir, f));
}

async function pngToDataUrl(filePath) {
  const buf = await readFile(filePath);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function classify(images) {
  const userContent = [
    {
      type: 'text',
      text:
        `Classify all ${images.length} pages of this document. ` +
        `Return one classification per page, in page order, in the 'pages' array.`,
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
      model: 'gpt-4o-mini',
      max_tokens: 6000,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'pdf_page_classifications',
          strict: true,
          schema: RESPONSE_SCHEMA,
        },
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{"pages":[]}';
  return JSON.parse(text);
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('usage: node scripts/test-vision-classifier.mjs "/path/to/file.pdf"');
    process.exit(1);
  }

  await loadEnv();
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not found in .env.local');
  }

  const outDir = resolve(__dirname, '..', '.test-render');
  console.log(`\nRendering pages → ${outDir}`);
  const pngPaths = await renderPdfPages(pdfPath, outDir);
  console.log(`Rendered ${pngPaths.length} pages.`);

  console.log('Encoding to data URLs...');
  const images = await Promise.all(pngPaths.map(pngToDataUrl));
  const totalBytes = images.reduce((s, i) => s + i.length, 0);
  console.log(`Total payload size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

  console.log('Calling vision classifier (gpt-4o-mini, detail=high)...\n');
  const start = Date.now();
  const result = await classify(images);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`─ Classifier returned in ${elapsed}s ─\n`);
  for (const p of result.pages || []) {
    const idx = p.comp_index != null ? ` (comp ${p.comp_index})` : '';
    const label = p.comp_label ? ` "${p.comp_label}"` : '';
    console.log(`page ${p.page}: ${p.role}${idx}${label}`);
    console.log(`  evidence: ${p.evidence}`);
  }

  // Compare to ground truth
  console.log('\n─ Ground truth check ─');
  const expected = [
    { page: 1, role: 'comp_id_page', comp_index: 1, comp_label: 'Land Sale 1' },
    { page: 2, role: 'comp_continuation', comp_index: 1 },
    { page: 3, role: 'comp_id_page', comp_index: 2, comp_label: 'Land Sale 2' },
    { page: 4, role: 'comp_continuation', comp_index: 2 },
    { page: 5, role: 'comp_id_page', comp_index: 3, comp_label: 'Land Sale 3' },
    { page: 6, role: 'comp_continuation', comp_index: 3 },
    { page: 7, role: 'comp_id_page', comp_index: 4, comp_label: 'Land Sale 4' },
    { page: 8, role: 'comp_continuation', comp_index: 4 },
    { page: 9, role: 'comp_id_page', comp_index: 5, comp_label: 'Land Sale 5' },
    { page: 10, role: 'comp_continuation', comp_index: 5 },
  ];

  let correctRoles = 0;
  let correctIndices = 0;
  for (const exp of expected) {
    const got = (result.pages || []).find((p) => p.page === exp.page);
    if (!got) { console.log(`page ${exp.page}: MISSING from classifier output`); continue; }
    const roleOk = got.role === exp.role;
    const indexOk = got.comp_index === exp.comp_index;
    if (roleOk) correctRoles++;
    if (indexOk) correctIndices++;
    if (!roleOk || !indexOk) {
      console.log(
        `page ${exp.page}: ` +
          `role ${roleOk ? '✓' : '✗ expected ' + exp.role + ', got ' + got.role}, ` +
          `comp_index ${indexOk ? '✓' : '✗ expected ' + exp.comp_index + ', got ' + got.comp_index}`
      );
    }
  }
  console.log(`\nRoles correct:    ${correctRoles}/${expected.length}`);
  console.log(`comp_index correct: ${correctIndices}/${expected.length}`);
}

main().catch((err) => {
  console.error('\nTest crashed:', err.message);
  process.exit(1);
});

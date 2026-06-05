#!/usr/bin/env node
// Test vision classifier at PRODUCTION image scale (~306x396, matching
// pdf.js scale 0.5). If the classifier gets the small images wrong but
// gets the larger 638x825 images right, we know the production scale is
// too small for reliable header reading.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadEnv() {
  const envPath = resolve(__dirname, '..', '.env.local');
  const envText = await readFile(envPath, 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

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

const SYSTEM_PROMPT = `You classify pages of land-appraisal and real-estate comp documents. \
You will receive N page images in order, page 1 first. Classify each one.

Roles:
  cover               — title page, firm letterhead, table of contents, intro letter
  subject_property    — the property BEING VALUED (the appraisal's subject, not a comparable)
  comp_id_page        — first page of a COMPARABLE sale: contains the comp header
  comp_continuation   — second or third page of the SAME comp the prior page introduced
  summary             — adjustment grid, summary table, reconciliation page at end
  other               — certifications, qualifications, appraiser bio, addenda

comp_index rules:
  • Count comparable sales in the order they appear. First comp = 1, next = 2, etc.
  • subject_property is NEVER a comp.
  • comp_continuation pages share their comp's index.
  • cover, subject_property, summary, other pages all have comp_index null.

Return {pages: [...]} with one classification per input image in order.`;

async function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node test-vision-prod-scale.mjs <render-dir>'); process.exit(1); }
  await loadEnv();

  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'))
    .sort();
  console.log(`Loading ${files.length} images from ${dir}`);
  const images = await Promise.all(files.map(async (f) => {
    const buf = await readFile(join(dir, f));
    const mime = f.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }));

  const totalBytes = images.reduce((s, i) => s + i.length, 0);
  console.log(`Payload: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

  const userContent = [
    { type: 'text', text: `Classify all ${images.length} pages in order.` },
    ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
  ];

  console.log('Calling gpt-4o-mini vision...\n');
  const start = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
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

  if (!res.ok) { console.error('OpenAI error:', await res.text()); process.exit(1); }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{"pages":[]}';
  const result = JSON.parse(text);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`Returned in ${elapsed}s\n`);
  for (const p of result.pages || []) {
    console.log(`page ${p.page}: ${p.role}${p.comp_index != null ? ` (comp ${p.comp_index})` : ''}${p.comp_label ? ` "${p.comp_label}"` : ''}`);
  }

  // Ground truth check
  const expected = [
    [1, 'comp_id_page', 1], [2, 'comp_continuation', 1],
    [3, 'comp_id_page', 2], [4, 'comp_continuation', 2],
    [5, 'comp_id_page', 3], [6, 'comp_continuation', 3],
    [7, 'comp_id_page', 4], [8, 'comp_continuation', 4],
    [9, 'comp_id_page', 5], [10, 'comp_continuation', 5],
  ];
  let roles = 0, indices = 0;
  for (const [page, role, idx] of expected) {
    const got = (result.pages || []).find((p) => p.page === page);
    if (!got) continue;
    if (got.role === role) roles++;
    if (got.comp_index === idx) indices++;
  }
  console.log(`\nRoles: ${roles}/${expected.length}, indices: ${indices}/${expected.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

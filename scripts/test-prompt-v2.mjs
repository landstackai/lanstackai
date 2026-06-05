#!/usr/bin/env node
// Test a tightened classifier prompt against the same PDF at the
// fix-target resolution. Specifically removes the "subjects appear at
// the front" prior that was biasing the model toward labeling Land Sale
// 1's ID page as subject_property.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadEnv() {
  const envText = await readFile(resolve(__dirname, '..', '.env.local'), 'utf8');
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

// Tightened prompt. Three key changes from the original:
//   1. Explicit "header text WINS over position" rule for comp_id_page
//   2. Removed the "subjects usually appear at front" prior — it was
//      biasing the model toward calling Land Sale 1 a subject just
//      because it was on page 1
//   3. Subject_property requires affirmative evidence (no "Land Sale N"
//      / "Comparable N" / "Sale N" header)
const SYSTEM_PROMPT = `You classify pages of US land-appraisal and real-estate comparable-sales documents. \
You will receive N page images in order, page 1 first. Classify each one.

Roles:
  comp_id_page        — first page of a comparable sale. RECOGNIZABLE BY a header at the \
top of the page reading "Land Sale N", "Sale N", "Sale No. N", "Comparable N", "Comp #N", \
"Property A/B/C", or similar. The page also typically contains an identification table, \
transaction data (price/date/grantor/grantee), and an aerial photo.
  comp_continuation   — second/third page of the same comp the prior page introduced. \
Continues the property description, remarks, or photo set. NO comp header at the top.
  subject_property    — the property being VALUED. Labeled "Subject Property", "Subject", \
or contained in a clearly-marked "Subject" section. NEVER has a "Land Sale N" / \
"Comparable N" / "Sale N" header — if you see one of those headers, it is a comp_id_page.
  cover               — title page, firm letterhead, table of contents, intro letter.
  summary             — adjustment grid, reconciliation page, sales comparison summary.
  other               — certifications, qualifications, appraiser bio, addenda.

CRITICAL: Header text WINS over page position. A page with "Land Sale 1" at the top is \
ALWAYS comp_id_page with comp_index 1 — even if it appears on page 1 of the document. \
Do NOT classify it as subject_property based on position. The label on the page is the \
ground truth.

comp_index rules:
  • Count comp_id_page occurrences in document order. First comp_id_page you see is \
comp_index 1, next is 2, etc. ALWAYS contiguous: 1, 2, 3, …
  • comp_continuation pages share their comp's comp_index.
  • All non-comp roles (cover, subject_property, summary, other) have comp_index null.

comp_label rules:
  • Copy the header text EXACTLY as it appears: "Land Sale 1", "Sale No. 2", "Comp #3", etc.
  • Null for non-comp pages.

evidence: one sentence stating what specific text or visual element drove your decision.

Return {pages: [{page, role, comp_index, comp_label, evidence}, ...]} with one entry per \
input image in page order.`;

async function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node test-prompt-v2.mjs <render-dir>'); process.exit(1); }
  await loadEnv();

  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'))
    .sort();
  const images = await Promise.all(files.map(async (f) => {
    const buf = await readFile(join(dir, f));
    const mime = f.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }));

  console.log(`Pages: ${images.length}, payload: ${(images.reduce((s, i) => s + i.length, 0) / 1024 / 1024).toFixed(2)} MB`);

  const userContent = [
    { type: 'text', text: `Classify all ${images.length} pages in order.` },
    ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
  ];

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
  const result = JSON.parse(data.choices?.[0]?.message?.content || '{"pages":[]}');
  console.log(`Returned in ${((Date.now() - start) / 1000).toFixed(1)}s\n`);

  for (const p of result.pages || []) {
    console.log(`page ${p.page}: ${p.role}${p.comp_index != null ? ` (comp ${p.comp_index})` : ''}${p.comp_label ? ` "${p.comp_label}"` : ''}`);
  }

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

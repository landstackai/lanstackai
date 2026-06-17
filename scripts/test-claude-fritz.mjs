#!/usr/bin/env node
//
// Single-PDF Claude extraction test — Fritz Farm.
//
// Purpose: skip the full harness and just call Claude on Fritz Farm so we
// know in 10 seconds whether Claude gets improvements_value right.
// (Full harness requires npm run dev + multiple PDFs.)
//
// Outputs:
//   • What Claude extracted
//   • Side-by-side vs ground truth (test-corpus/ground-truth/fritz-farm.json)
//   • Pass/fail per field

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load .env.local
const envText = await readFile(join(ROOT, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('...')) {
  console.error('ANTHROPIC_API_KEY missing or still has "..." placeholder. Fix .env.local.');
  process.exit(1);
}

const SUBMIT_TOOL = {
  name: 'submit_comp',
  description: 'Submit the extracted comp data',
  input_schema: {
    type: 'object',
    properties: {
      property_name: { type: ['string', 'null'] },
      county: { type: ['string', 'null'] },
      state: { type: ['string', 'null'] },
      acres: { type: ['number', 'null'] },
      acres_source: { type: ['string', 'null'] },
      sale_price: { type: ['number', 'null'] },
      sale_price_source: { type: ['string', 'null'] },
      sale_date: { type: ['string', 'null'] },
      price_per_acre: { type: ['number', 'null'] },
      improvements_value: { type: ['number', 'null'] },
      improvements_value_source: { type: ['string', 'null'] },
      improvements_notes: { type: ['string', 'null'] },
      price_land_only: { type: ['number', 'null'] },
      ppa_land_only: { type: ['number', 'null'] },
      has_improvements: { type: 'boolean' },
      grantor: { type: ['string', 'null'] },
      grantee: { type: ['string', 'null'] },
      water: { type: ['string', 'null'] },
      irrigation: { type: ['string', 'null'] },
    },
    required: [
      'property_name', 'county', 'state', 'acres', 'sale_price', 'sale_date',
      'price_per_acre', 'improvements_value', 'improvements_value_source',
      'has_improvements',
    ],
  },
};

// Prompt with the four improvements we identified from the Fritz Farm
// failure mode (irrigation as improvement, sum all contributory values,
// cite source, distinguish prior sale).
const SYSTEM_PROMPT = `You extract structured comp data from US land-appraisal documents.

IMPROVEMENT VALUE rules — read these carefully:

  Improvements include ALL of these, not just structures:
    • Structures: house, dwelling, barn, outbuildings, hangars
    • Agricultural infrastructure: irrigation systems (pivot, drip, flood),
      water wells with pumps, livestock handling facilities, pens
    • Land improvements: cross-fencing, perimeter fencing, internal roads
    • Recreational: hunting blinds, food plots, lodge facilities

  If the document mentions ANY phrase like "contributory value of $X" or
  "estimated value of $X" attached to a feature anywhere in the document
  — including in prose remarks paragraphs apart — sum ALL of those into a
  single improvements_value.

  improvements_value_source MUST itemize: list each feature and its value,
  e.g. "p2 · Remarks · irrigation $575,000 + hay barn $190,000 = $765,000"

  NEVER use a per-acre improvement value (like "$1,073 per acre" for
  irrigation) as the improvements_value. That's the per-acre figure, not
  the total contributory dollar amount.

PRIOR SALES — do not confuse with current transaction.

  Many documents mention prior sales of the same property buried in
  remarks ("purchased by the Grantor from X in October 2020 for
  $1,980,466"). Those values DO NOT replace the documented current
  transaction's sale_price, sale_date, grantor, or grantee.

CITE EVERY NUMERIC FIELD — for every dollar amount or numeric value,
include a source string identifying the exact location in the document.

Call submit_comp once with the full result.`;

const pdfPath = join(ROOT, 'test-corpus', 'fritz-farm.pdf');
const pdfBuffer = await readFile(pdfPath);

console.log('Calling Claude with Fritz Farm PDF (claude-sonnet-4-5)...\n');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const t0 = Date.now();
const msg = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 4000,
  system: SYSTEM_PROMPT,
  tools: [SUBMIT_TOOL],
  tool_choice: { type: 'tool', name: 'submit_comp' },
  messages: [{
    role: 'user',
    content: [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: pdfBuffer.toString('base64'),
        },
      },
      { type: 'text', text: 'Extract the comp data from this document.' },
    ],
  }],
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const toolUse = msg.content.find((b) => b.type === 'tool_use');
if (!toolUse) {
  console.error('Claude did not call submit_comp. Raw content:');
  console.error(JSON.stringify(msg.content, null, 2));
  process.exit(1);
}

const got = toolUse.input;

// Load ground truth
const truth = JSON.parse(
  await readFile(join(ROOT, 'test-corpus/ground-truth/fritz-farm.json'), 'utf8')
);
const expected = truth.expected_comps[0];

console.log(`Claude responded in ${elapsed}s. Token usage: ${msg.usage.input_tokens} in, ${msg.usage.output_tokens} out.\n`);
console.log('─── Extracted vs Expected ───────────────────────────────────────────\n');

function check(label, gotVal, expectedVal, formatter = (v) => v) {
  const pass = gotVal === expectedVal;
  const icon = pass ? '✓' : '✗';
  console.log(`${icon} ${label.padEnd(28)} got=${formatter(gotVal)}  expected=${formatter(expectedVal)}`);
  return pass;
}

const results = [
  check('property_name', got.property_name, expected.property_name),
  check('county', got.county, expected.county),
  check('state', got.state, expected.state),
  check('acres', got.acres, expected.acres),
  check('sale_price', got.sale_price, expected.sale_price, (v) => '$' + v?.toLocaleString()),
  check('sale_date', got.sale_date, expected.sale_date),
  check('price_per_acre', got.price_per_acre, expected.price_per_acre, (v) => '$' + v?.toLocaleString()),
  check('improvements_value', got.improvements_value, expected.improvements_value, (v) => '$' + v?.toLocaleString()),
  check('has_improvements', got.has_improvements, expected.has_improvements),
  check('grantor', got.grantor, expected.grantor),
  check('grantee', got.grantee, expected.grantee),
];

// Special: improvements_value_source must mention BOTH irrigation and barn
const srcLower = (got.improvements_value_source || '').toLowerCase();
const sourceMentionsIrrigation = srcLower.includes('irrigation');
const sourceMentionsBarn = srcLower.includes('barn');
const sourceOk = sourceMentionsIrrigation && sourceMentionsBarn;
console.log(`${sourceOk ? '✓' : '✗'} ${'improvements_value_source'.padEnd(28)} got="${got.improvements_value_source}"`);
console.log(`   ${sourceMentionsIrrigation ? '✓' : '✗'} mentions irrigation     ${sourceMentionsBarn ? '✓' : '✗'} mentions barn`);
results.push(sourceOk);

// Negative checks: prior sale values must NOT appear
const negChecks = truth.must_NOT_appear;
console.log();
console.log('─── Negative checks (these values must NOT appear) ──────────────────\n');
const noWrongPrice = got.sale_price !== negChecks.wrong_sale_price;
const noWrongPpa = got.price_per_acre !== negChecks.wrong_price_per_acre;
const noWrongDate = !got.sale_date?.startsWith(String(negChecks.wrong_sale_date_year));
console.log(`${noWrongPrice ? '✓' : '✗'} did NOT use prior sale price $${negChecks.wrong_sale_price.toLocaleString()}`);
console.log(`${noWrongPpa ? '✓' : '✗'} did NOT use prior sale ppa $${negChecks.wrong_price_per_acre.toLocaleString()}`);
console.log(`${noWrongDate ? '✓' : '✗'} did NOT use prior sale year ${negChecks.wrong_sale_date_year}`);
results.push(noWrongPrice, noWrongPpa, noWrongDate);

const passed = results.filter(Boolean).length;
const total = results.length;
console.log(`\n─── Score: ${passed}/${total} ─────────────────────────────────────────\n`);

if (passed < total) {
  console.log('Full Claude output:');
  console.log(JSON.stringify(got, null, 2));
}

#!/usr/bin/env node
//
// 2-engine extraction comparison harness.
//
// PURPOSE
// -------
// We're choosing the foundation for Landstack's PDF→comp extraction. Two
// candidates are in the running:
//
//   ENGINE A — Claude (Anthropic) native PDF
//     Sonnet/Opus take a base64 PDF directly. No client-side rendering,
//     no page classifier, no boundary detection — the model reads the
//     whole document and returns structured comps via tool-use.
//
//   ENGINE B — OpenAI (current production)
//     Render pages with pdf.js → vision classifier identifies comp
//     boundaries → per-comp extraction call. Multi-stage pipeline,
//     bespoke prompts at each layer.
//
// This script runs BOTH engines against every PDF in ./test-corpus/ and
// dumps results to ./test-corpus-results/<timestamp>/ for manual diff.
//
// Why a manual diff and not an auto-score: ground truth for these PDFs
// lives in the broker's head. We need eyeballs on the JSON to call wins,
// not a brittle regex of "correctness." Once we know which engine wins
// on which document type, THAT becomes the triage classifier.
//
// USAGE
// -----
//   1. Drop PDFs into ./test-corpus/
//   2. node scripts/compare-engines.mjs
//   3. Open ./test-corpus-results/<timestamp>/summary.md
//
// Each PDF produces:
//   <pdf>__claude.json     — Engine A raw output
//   <pdf>__openai.json     — Engine B raw output  (from /api/import-chat)
//   <pdf>__diff.md         — human-readable side-by-side
//
// COST / TIME
// -----------
// Claude Sonnet on a 50-page PDF: ~$0.15 and ~30s per call.
// OpenAI pipeline on same: ~$0.05 and ~60s (vision classifier + extract).
// Budget ~$3 for a 10-PDF corpus run. Trivial.

import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CORPUS_DIR = join(ROOT, 'test-corpus');
const RESULTS_DIR = join(ROOT, 'test-corpus-results');

// ─── env loading ────────────────────────────────────────────────────────
async function loadEnv() {
  const envText = await readFile(join(ROOT, '.env.local'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ─── Claude tool schema ──────────────────────────────────────────────────
// Anthropic's structured output mechanism is tool-use, not response_format.
// We define ONE tool, "submit_comps", with an input schema matching our
// production COMP_SCHEMA. Claude is told to call this tool exactly once
// with the full extraction result.
//
// Trimmed to the field set that matters for the foundation decision —
// expanding to the full schema doesn't change which engine wins, it just
// makes the diff noisier.
const SUBMIT_COMPS_TOOL = {
  name: 'submit_comps',
  description:
    'Submit the structured comps extracted from this appraisal or comp-list PDF. ' +
    'Call this tool exactly once after reading the entire document.',
  input_schema: {
    type: 'object',
    properties: {
      document_type: {
        type: 'string',
        enum: [
          'full_appraisal',
          'comp_list',
          'mls_export',
          'broker_packet',
          'other',
        ],
        description: 'What kind of document is this overall?',
      },
      subject_property: {
        type: ['object', 'null'],
        description: 'The property being VALUED, if present. Null on a pure comp list.',
        properties: {
          property_name: { type: ['string', 'null'] },
          county: { type: ['string', 'null'] },
          state: { type: ['string', 'null'] },
          acres: { type: ['number', 'null'] },
          address: { type: ['string', 'null'] },
        },
        required: ['property_name', 'county', 'state', 'acres', 'address'],
      },
      comps: {
        type: 'array',
        description:
          'One entry per comparable sale. Order them as they appear in the document.',
        items: {
          type: 'object',
          properties: {
            comp_label: {
              type: ['string', 'null'],
              description: 'Header as it appears, e.g. "Land Sale 1", "Comparable B".',
            },
            property_name: { type: ['string', 'null'] },
            county: { type: ['string', 'null'] },
            state: { type: ['string', 'null'] },
            acres: { type: ['number', 'null'] },
            sale_price: { type: ['number', 'null'] },
            sale_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
            price_per_acre: { type: ['number', 'null'] },
            improvements_value: { type: ['number', 'null'] },
            price_land_only: { type: ['number', 'null'] },
            ppa_land_only: { type: ['number', 'null'] },
            address: { type: ['string', 'null'] },
            latitude: { type: ['number', 'null'] },
            longitude: { type: ['number', 'null'] },
            parcel_id: { type: ['string', 'null'] },
            grantor: { type: ['string', 'null'] },
            grantee: { type: ['string', 'null'] },
            water: {
              type: ['string', 'null'],
              enum: ['None', 'Seasonal', 'Strong', null],
            },
            road_frontage: {
              type: ['string', 'null'],
              enum: ['None', 'Low', 'Medium', 'High', null],
            },
            has_improvements: { type: ['boolean', 'null'] },
            description: { type: ['string', 'null'] },
            evidence_pages: {
              type: 'array',
              items: { type: 'integer' },
              description: 'PDF page numbers this comp was drawn from.',
            },
          },
          required: [
            'comp_label',
            'property_name',
            'county',
            'acres',
            'sale_price',
            'sale_date',
            'evidence_pages',
          ],
        },
      },
    },
    required: ['document_type', 'comps'],
  },
};

const CLAUDE_SYSTEM_PROMPT = `\
You are an expert land-appraisal analyst. You receive a PDF that contains \
either a full real-estate appraisal, a broker's comp list, an MLS export, \
or a mixed packet of comparable-sales information.

Your job:
  1. Identify what KIND of document this is (document_type).
  2. If there is a SUBJECT PROPERTY (the property being valued), capture it.
  3. Extract every COMPARABLE SALE the document presents. One entry per comp.
  4. For each comp, populate every field you can confidently read from the \
     document. Use null for any field that isn't present — DO NOT GUESS.
  5. Record evidence_pages = the actual PDF page numbers each comp was drawn \
     from. This is critical for downstream verification.

Hard rules:
  • Numbers are numbers, not strings. "344.96", not "$344.96".
  • Dates are YYYY-MM-DD strings.
  • A page labeled "Land Sale 1" or "Sale 1" or "Comparable A" is a COMP, \
    never a subject property — even if it appears on page 1.
  • Subject property is labeled "Subject Property", "Subject", or sits in a \
    clearly marked Subject section.
  • If acreage and sale price are both present, derive price_per_acre. \
    If improvements_value is given AND sale_price is given, derive \
    price_land_only = sale_price − improvements_value and \
    ppa_land_only = price_land_only / acres.

Call the submit_comps tool exactly once with the full result.`;

// ─── engine A: Claude native PDF ────────────────────────────────────────
async function runClaude(client, pdfBuffer, pdfName) {
  const t0 = Date.now();
  const message = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 16000,
    system: CLAUDE_SYSTEM_PROMPT,
    tools: [SUBMIT_COMPS_TOOL],
    tool_choice: { type: 'tool', name: 'submit_comps' },
    messages: [
      {
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
          {
            type: 'text',
            text: `Extract every comparable sale from "${pdfName}". Call submit_comps with the result.`,
          },
        ],
      },
    ],
  });
  const elapsedMs = Date.now() - t0;

  // The tool call lives in content blocks. Find the submit_comps invocation.
  const toolUse = message.content.find(
    (b) => b.type === 'tool_use' && b.name === 'submit_comps'
  );

  return {
    engine: 'claude',
    model: 'claude-sonnet-4-5',
    elapsed_ms: elapsedMs,
    usage: message.usage,
    result: toolUse?.input ?? null,
    stop_reason: message.stop_reason,
    raw_content: toolUse ? null : message.content, // only keep raw if tool didn't fire
  };
}

// ─── engine B: OpenAI via existing /api/import-chat ─────────────────────
// We POST to the running dev server to exercise the EXACT same pipeline
// production uses: pdf-parse → vision boundary detection → schema-locked
// extraction. No re-implementation, no drift.
async function runOpenAI(pdfBuffer, pdfName, opts) {
  const t0 = Date.now();
  const baseUrl = opts.baseUrl || 'http://localhost:3000';

  // Step 1: parse PDF text via /api/parse-pdf
  const parseForm = new FormData();
  parseForm.append(
    'file',
    new Blob([pdfBuffer], { type: 'application/pdf' }),
    pdfName
  );
  const parseRes = await fetch(`${baseUrl}/api/parse-pdf`, {
    method: 'POST',
    body: parseForm,
  });
  if (!parseRes.ok) {
    throw new Error(`parse-pdf failed: ${parseRes.status}`);
  }
  const parsed = await parseRes.json();

  // Step 2: send the parsed text to /api/import-chat for comp extraction
  const importRes = await fetch(`${baseUrl}/api/import-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content:
            `Extract all comparable sales from this document. Document text follows:\n\n${parsed.text}`,
        },
      ],
      pdfText: parsed.text,
      fileName: pdfName,
    }),
  });
  const elapsedMs = Date.now() - t0;
  if (!importRes.ok) {
    return {
      engine: 'openai',
      model: 'gpt-4o-mini (current pipeline)',
      elapsed_ms: elapsedMs,
      error: `import-chat failed: ${importRes.status} ${await importRes.text().then((t) => t.slice(0, 200))}`,
    };
  }
  const imported = await importRes.json();

  return {
    engine: 'openai',
    model: 'gpt-4o-mini (current pipeline)',
    elapsed_ms: elapsedMs,
    result: {
      message: imported.message,
      comps: imported.comps ?? imported.extractedComps ?? [],
    },
  };
}

// ─── side-by-side diff renderer ─────────────────────────────────────────
function renderDiff(pdfName, claudeRun, openaiRun) {
  const lines = [`# ${pdfName}`, ''];

  const claudeComps = claudeRun.result?.comps ?? [];
  const openaiComps = openaiRun.result?.comps ?? [];

  lines.push(`## Headline`, '');
  lines.push(`| metric | Claude | OpenAI |`);
  lines.push(`| --- | --- | --- |`);
  lines.push(
    `| comps extracted | ${claudeComps.length} | ${openaiComps.length} |`
  );
  lines.push(
    `| elapsed | ${(claudeRun.elapsed_ms / 1000).toFixed(1)}s | ${(openaiRun.elapsed_ms / 1000).toFixed(1)}s |`
  );
  if (claudeRun.usage) {
    lines.push(
      `| input tokens | ${claudeRun.usage.input_tokens} | (n/a — pipeline) |`
    );
    lines.push(
      `| output tokens | ${claudeRun.usage.output_tokens} | (n/a — pipeline) |`
    );
  }
  if (claudeRun.result?.document_type) {
    lines.push(`| document_type (Claude) | ${claudeRun.result.document_type} | — |`);
  }
  lines.push('');

  // Comp-by-comp side-by-side on key fields
  lines.push(`## Per-comp (Claude side)`, '');
  for (const [i, c] of claudeComps.entries()) {
    lines.push(
      `**${i + 1}. ${c.comp_label ?? c.property_name ?? '?'}** — ` +
        `${c.acres ?? '?'} ac · $${c.sale_price ?? '?'} · ${c.sale_date ?? '?'} · ` +
        `ppa $${c.price_per_acre ?? '?'} · pages [${(c.evidence_pages || []).join(',')}]`
    );
  }
  lines.push('');
  lines.push(`## Per-comp (OpenAI side)`, '');
  for (const [i, c] of openaiComps.entries()) {
    lines.push(
      `**${i + 1}. ${c.property_name ?? '?'}** — ` +
        `${c.acres ?? '?'} ac · $${c.sale_price ?? '?'} · ${c.sale_date ?? '?'} · ` +
        `ppa $${c.price_per_acre ?? '?'}`
    );
  }
  lines.push('');

  return lines.join('\n');
}

// ─── main ───────────────────────────────────────────────────────────────
async function main() {
  await loadEnv();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      '\nMissing ANTHROPIC_API_KEY in .env.local. Paste your key after the = on that line and re-run.\n'
    );
    process.exit(1);
  }

  const pdfs = (await readdir(CORPUS_DIR).catch(() => []))
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort();
  if (pdfs.length === 0) {
    console.error(`\nNo PDFs found in ${CORPUS_DIR}. Drop test PDFs there and re-run.\n`);
    process.exit(1);
  }

  const baseUrl = process.env.HARNESS_BASE_URL || 'http://localhost:3000';
  console.log(`\nFound ${pdfs.length} PDF(s) in ${CORPUS_DIR}`);
  console.log(`OpenAI side will hit: ${baseUrl}\n`);
  console.log(`(Make sure 'npm run dev' is running in another terminal.)\n`);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(RESULTS_DIR, ts);
  await mkdir(outDir, { recursive: true });

  const summary = [`# Engine comparison run — ${ts}`, ''];
  for (const pdfName of pdfs) {
    console.log(`▶ ${pdfName}`);
    const buf = await readFile(join(CORPUS_DIR, pdfName));
    const stem = pdfName.replace(/\.pdf$/i, '');

    // Run both engines in parallel — they're independent and shorten the
    // wall-clock for a 10-PDF run from ~15min to ~5min.
    const [claudeRun, openaiRun] = await Promise.allSettled([
      runClaude(client, buf, pdfName),
      runOpenAI(buf, pdfName, { baseUrl }),
    ]);

    const c = claudeRun.status === 'fulfilled'
      ? claudeRun.value
      : { engine: 'claude', error: claudeRun.reason?.message ?? String(claudeRun.reason) };
    const o = openaiRun.status === 'fulfilled'
      ? openaiRun.value
      : { engine: 'openai', error: openaiRun.reason?.message ?? String(openaiRun.reason) };

    await writeFile(join(outDir, `${stem}__claude.json`), JSON.stringify(c, null, 2));
    await writeFile(join(outDir, `${stem}__openai.json`), JSON.stringify(o, null, 2));
    await writeFile(join(outDir, `${stem}__diff.md`), renderDiff(pdfName, c, o));

    const cn = c.result?.comps?.length ?? `ERROR: ${c.error ?? '?'}`;
    const on = o.result?.comps?.length ?? `ERROR: ${o.error ?? '?'}`;
    console.log(`  Claude: ${cn} comps · OpenAI: ${on} comps`);
    summary.push(`- **${pdfName}** — Claude: ${cn} comps, OpenAI: ${on} comps`);
  }

  await writeFile(join(outDir, 'summary.md'), summary.join('\n'));
  console.log(`\n✓ Results: ${outDir}\n`);
  console.log(`Open ${join(outDir, 'summary.md')} to start the review.\n`);
}

main().catch((e) => {
  console.error('\nHarness crashed:', e.message);
  console.error(e.stack);
  process.exit(1);
});

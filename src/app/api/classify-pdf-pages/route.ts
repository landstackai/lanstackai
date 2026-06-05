import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

// Vision-based page classifier for multi-comp PDFs.
//
// Why this exists: regex-based boundary detection on pdf.js text content
// fails on the most common failure mode — appraisal headers rendered as
// stylized graphics (no live text to match). The model receives the page
// IMAGES and reads them the way a human would, returning a structured
// classification per page that the import flow assembles into a CompMap.
//
// Design choices, in order of importance:
//
// 1. SINGLE BATCHED CALL. Earlier draft fanned out one OpenAI call per
//    page. That hit two real production limits:
//      • Vercel serverless body limit is 4.5MB. Ten high-res page
//        images don't fit.
//      • Ten parallel calls per PDF spike OpenAI rate limits unnecessarily.
//    Now: ONE call receives all pages in one multi-part user message,
//    one response returns an array of N classifications. One round trip,
//    one rate-limit cost, one body to size-budget.
//
// 2. CALLER PRE-DOWNSCALES IMAGES. We need the model to see headers,
//    not full-resolution aerials. The client (visionBoundaryDetection.ts)
//    renders dedicated low-res images for the classifier — separate from
//    the high-res images used for downstream extraction. Body stays well
//    under the 4.5MB limit even on long documents.
//
// 3. HIGH DETAIL VISION. 'low' detail downsamples to 512×512 which is
//    insufficient for small/stylized header text. 'high' detail costs
//    ~12× more but lands us at ~$0.005 per PDF total — still trivial.
//    Quality of the boundary signal matters more than cost here.
//
// 4. STRICT JSON SCHEMA. The response shape is locked at the model
//    layer. The model can't drift, omit fields, or return strings where
//    integers are expected. Output is safe to consume without
//    defensive parsing.
//
// 5. PER-PAGE FAILURE TOLERANCE INSIDE A SINGLE CALL. The model
//    classifies all pages in one response. If any individual page is
//    ambiguous, the model returns role='other' for it — never throws.
//    Network/quota failures fail the WHOLE call (which the caller
//    handles by falling back to regex).

export const maxDuration = 60;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Per-page classification. See SYSTEM_PROMPT for the semantics of each
// role and the rules for comp_index / comp_label.
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
} as const;

// Top-level response: a flat array of N page classifications.
const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pages: {
      type: 'array',
      items: PAGE_CLASSIFICATION_SCHEMA,
    },
  },
  required: ['pages'],
} as const;

interface PageClassification {
  page: number;
  role:
    | 'cover'
    | 'subject_property'
    | 'comp_id_page'
    | 'comp_continuation'
    | 'summary'
    | 'other';
  comp_index: number | null;
  comp_label: string | null;
  evidence: string;
}

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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const images: unknown = body?.images;

    if (!Array.isArray(images) || images.length === 0) {
      return NextResponse.json(
        { error: 'request body must include images: string[]' },
        { status: 400 }
      );
    }
    // Bound the per-request page count. 30 pages × ~80KB low-res =
    // ~2.4MB request body, comfortably under the 4.5MB serverless limit.
    if (images.length > 30) {
      return NextResponse.json(
        { error: 'too many pages — max 30 per classification request' },
        { status: 400 }
      );
    }
    for (const img of images) {
      if (typeof img !== 'string' || !img.startsWith('data:image/')) {
        return NextResponse.json(
          { error: 'each image must be a data:image/... URL' },
          { status: 400 }
        );
      }
    }
    const pageImages = images as string[];

    // Single multi-part user message: text instruction + one image_url
    // entry per page. Detail 'high' so the model can read small / stylized
    // header text (the 'low' setting downsamples to 512×512, which loses
    // header detail in real-world appraisal layouts).
    const userContent: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail: 'high' } }
    > = [
      {
        type: 'text',
        text:
          `Classify all ${pageImages.length} pages of this document. ` +
          `Return one classification per page, in page order, in the 'pages' array.`,
      },
      ...pageImages.map((url) => ({
        type: 'image_url' as const,
        image_url: { url, detail: 'high' as const },
      })),
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      // Generous budget — each page classification is ~50-80 tokens out;
      // 6000 covers 30 pages comfortably plus structural overhead.
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
    });

    const text = completion.choices[0]?.message?.content || '{"pages":[]}';
    let parsed: { pages: PageClassification[] };
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      console.error('[classify-pdf-pages] JSON parse failed:', parseErr, text.slice(0, 500));
      return NextResponse.json(
        { error: 'classifier returned unparseable JSON' },
        { status: 502 }
      );
    }

    const out = Array.isArray(parsed?.pages) ? parsed.pages : [];

    // Sanity: the model SHOULD return exactly one classification per input
    // page, in order. If it returned fewer or skipped pages, log loudly so
    // the caller's CompMap-builder can compensate by treating missing
    // pages as 'other' (unassigned).
    if (out.length !== pageImages.length) {
      console.warn(
        `[classify-pdf-pages] expected ${pageImages.length} classifications, got ${out.length}`
      );
    }

    return NextResponse.json({ pages: out });
  } catch (err: any) {
    console.error('[classify-pdf-pages] route failure:', err?.message || err);
    return NextResponse.json(
      { error: err?.message || 'classification failed' },
      { status: 500 }
    );
  }
}

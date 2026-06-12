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

// Retry with exponential backoff for transient OpenAI errors (429 rate
// limits, 500-level transient failures). Cap at 3 attempts so we don't
// burn the entire serverless function timeout on retries.
//
// 429 from OpenAI usually means "TPM saturated in last 60s." The error
// message often includes a "try again in X" hint we honor when present.
// For other transient codes, exponential backoff (5s → 10s → 20s).
async function callOpenAIWithRetry<T>(fn: () => Promise<T>, attempt = 1): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    const isRetryable = status === 429 || (status >= 500 && status < 600);
    if (!isRetryable || attempt >= 3) throw err;

    let waitMs = 5_000 * Math.pow(2, attempt - 1); // 5s, 10s, 20s
    // If the error message includes a "try again in X" hint, honor it.
    const errMsg = err?.message ?? '';
    const waitMatch = errMsg.match(/try again in (\d+\.?\d*)([ms])/i);
    if (waitMatch) {
      const n = parseFloat(waitMatch[1]);
      const hinted = waitMatch[2].toLowerCase() === 's' ? n * 1000 : n;
      waitMs = Math.max(waitMs, hinted);
    }
    // Cap the wait so we don't blow the 60s function timeout.
    waitMs = Math.min(waitMs, 30_000);

    console.warn(
      `[classify-pdf-pages] OpenAI ${status} on attempt ${attempt}, ` +
      `retrying in ${(waitMs / 1000).toFixed(1)}s`
    );
    await new Promise((r) => setTimeout(r, waitMs));
    return callOpenAIWithRetry(fn, attempt + 1);
  }
}

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

// Prompt empirically verified locally against the New Braunfels for
// Christina.pdf (10 pages, 5 comps, Land Sale 1-5 headers). The
// original prompt biased the model toward classifying "Land Sale 1"
// as a subject_property because of the hint "subjects appear at the
// front, before any Sale 1 header." Removed that prior; added an
// explicit "header text WINS over page position" rule. Result: 10/10
// roles + 10/10 comp_indices correct, repeatedly, at the
// production-equivalent image scale (612x792 JPEG q=0.85).
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

    // Retry with backoff on OpenAI rate limits. The TPM cap is a rolling
    // 60s window; when long-appraisal classification fans out into
    // multiple parallel batches (visionBoundaryDetection batches 60+
    // page PDFs), it's possible to spike past the limit for a moment.
    // Backing off and retrying is the right behavior — fail-fast would
    // turn what's actually a transient slowdown into a no-result-found
    // for the broker.
    const completion = await callOpenAIWithRetry(async () =>
      openai.chat.completions.create({
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
      })
    );

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

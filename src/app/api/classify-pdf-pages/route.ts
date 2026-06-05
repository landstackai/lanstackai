import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

// Vision-based page classifier for multi-comp PDFs.
//
// THE PROBLEM this replaces:
// Earlier the import flow used regex pattern-matching on pdf.js text content
// to find comp boundaries ("Land Sale 1", "Sale No. 2", etc.). Three failure
// modes made that approach unreliable in production:
//   1. Appraisal headers are often rendered as STYLIZED GRAPHICS, not live
//      text. pdf.js sees no "Land Sale 1" string to match.
//   2. Letterheads, copyright blocks, and page footers push the actual
//      header below whatever scan window we set.
//   3. Every new appraisal format invented by every new appraiser is
//      another regex we don't have. Whack-a-mole.
//
// THE FIX:
// Use a vision model to read each page the way a human reads it. For every
// page image, the model returns a structured classification:
//   • role: 'cover' | 'comp_id_page' | 'comp_continuation' | 'summary' | 'other'
//   • comp_index: 1-based ordinal of which comp this page belongs to (null
//     for non-comp content)
//   • comp_label: the label the model saw on the page ("Land Sale 1",
//     "Sale 2", "Comp #3", "Property A" — whatever the format uses)
//
// From those per-page classifications, the import flow builds a deterministic
// page→comp map. Format-agnostic — works on rasterized headers, MLS sheets,
// closing statements, anything that visually looks like a real-estate
// document. No regex patterns to maintain.
//
// COST/LATENCY:
// gpt-4o-mini vision at "low" detail runs about $0.0001-0.0005 per page and
// ~1.5-3s per page. Pages run in PARALLEL via Promise.all, so a 10-page
// PDF classifies in roughly the same wall-clock time as one page (limited by
// the slowest single page, not the sum). Total cost per PDF: well under 1¢.

export const maxDuration = 60;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Per-page classification schema. Strict mode so the model can't drift.
const PAGE_CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: {
      type: 'string',
      enum: [
        'cover',              // title page, table of contents, appraiser intro
        'subject_property',   // the property being valued (NOT a comp)
        'comp_id_page',       // first page of a comparable: header + ID table + sale data
        'comp_continuation',  // second/third page of the SAME comp (description, remarks)
        'summary',            // adjustment grid, summary table at end
        'other',              // certifications, qualifications, addenda
      ],
    },
    // 1-based ordinal of the comp this page belongs to. Null for non-comp
    // pages (cover, subject, summary, other). The model is told to count
    // comps in the order they appear in the document, so the FIRST comp
    // it encounters is 1 regardless of its label.
    comp_index: { type: ['integer', 'null'] },
    // The label as it appears on the page ("Land Sale 1", "Comp 2", etc.).
    // Helps with debugging + UX (we can show "Imported: Sale 3" instead of
    // a generic "Comp 3").
    comp_label: { type: ['string', 'null'] },
    // Short free-form summary of what the page contains. Used for
    // diagnostic logs + future broker-facing "what we saw" affordance.
    evidence: { type: 'string' },
  },
  required: ['role', 'comp_index', 'comp_label', 'evidence'],
} as const;

interface PageClassification {
  role: 'cover' | 'subject_property' | 'comp_id_page' | 'comp_continuation' | 'summary' | 'other';
  comp_index: number | null;
  comp_label: string | null;
  evidence: string;
}

const SYSTEM_PROMPT = `You classify pages of land-appraisal and real-estate comp documents. \
You will receive ONE page image at a time. Decide what's on it.

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
you see is comp_index 1, the next is 2, and so on.
  • A subject property is NEVER a comp — set comp_index null for subject_property pages.
  • comp_continuation pages share the comp_index of the comp they continue.
  • cover, subject_property, summary, other pages all have comp_index null.

comp_label rules:
  • Copy the label EXACTLY as it appears on the page: "Land Sale 1", "Sale No. 2", "Comp #3", \
"Property B", etc. Preserve capitalization and punctuation.
  • If the page has no visible label but is clearly a comp page, infer from context \
(e.g. "Comp 2" if it's the second comp you've encountered) and put that in comp_label.
  • Null for non-comp pages.

evidence: one sentence describing what made you classify the page this way. \
Examples: "Header reads 'LAND SALE 1' at top, Transaction Data table below." or \
"Continues property description from prior page; no header." Keep it factual.

Be conservative. If a page could plausibly be a subject property OR a comp, examine the \
context: subjects usually appear at the front, before any "Sale 1" header; comps appear \
after. When in doubt about role, prefer 'other' over guessing.`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const images: string[] = Array.isArray(body?.images) ? body.images : [];

    if (images.length === 0) {
      return NextResponse.json({ error: 'no images provided' }, { status: 400 });
    }
    if (images.length > 30) {
      return NextResponse.json(
        { error: 'too many pages (max 30 per request)' },
        { status: 400 }
      );
    }

    // Parallel classification — one call per page. Caps fan-out implicitly
    // via the 30-page limit above. gpt-4o-mini vision low-detail is fast +
    // cheap; the bottleneck is per-page latency, not throughput.
    const classifications = await Promise.all(
      images.map(async (dataUrl, idx) => {
        try {
          const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            max_tokens: 300,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'page_classification',
                strict: true,
                schema: PAGE_CLASSIFICATION_SCHEMA,
              },
            },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `Classify this page (page ${idx + 1} of ${images.length}).`,
                  },
                  {
                    type: 'image_url',
                    // 'low' detail is plenty for header/role detection and
                    // keeps cost down to ~$0.0001-0.0005 per page.
                    image_url: { url: dataUrl, detail: 'low' as const },
                  },
                ],
              },
            ],
          });
          const text = completion.choices[0]?.message?.content || '{}';
          const parsed = JSON.parse(text) as PageClassification;
          return { page: idx + 1, ...parsed };
        } catch (err: any) {
          // Per-page failure shouldn't kill the whole classification.
          // Mark as 'other' so the caller knows we couldn't classify it
          // but has SOMETHING to work with.
          console.warn(`[classify-pdf-pages] page ${idx + 1} failed:`, err?.message);
          return {
            page: idx + 1,
            role: 'other' as const,
            comp_index: null,
            comp_label: null,
            evidence: `classification failed: ${err?.message || 'unknown'}`,
          };
        }
      })
    );

    return NextResponse.json({ pages: classifications });
  } catch (err: any) {
    console.error('[classify-pdf-pages] route failure:', err);
    return NextResponse.json(
      { error: err?.message || 'classification failed' },
      { status: 500 }
    );
  }
}

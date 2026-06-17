import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

// ─────────────────────────────────────────────────────────────────────────
// Claude PDF extraction — server-side, native PDF handling.
//
// WHY THIS ROUTE EXISTS
// ─────────────────────
// The OG import pipeline rendered every PDF page client-side with pdf.js
// before sending to OpenAI vision. That works for 10-page comp sheets but
// breaks two real-world cases:
//
//   1. Long appraisals (60+ pages, e.g. Stouffer's 71-page Thorndale).
//      Browser holds ALL rendered images in memory while it works through
//      vision classification + per-comp extraction. Safari aggressively
//      throttles non-foreground tabs, so the broker walks away → render
//      stalls forever → "Rendering PDF pages…" toast still spinning
//      10 minutes later. Confirmed in production 2026-06-17.
//
//   2. The Fritz Farm improvements-value bug. Production OpenAI text path
//      returned $190k (the hay barn) and silently dropped the $575k
//      irrigation system. The "improvements_value_source" citation field
//      isn't required by the legacy prompt, so the model can be vague
//      about which dollar figure it grabbed. Confirmed in production
//      2026-06-17.
//
// Claude's native PDF support fixes both at once:
//
//   • The PDF goes straight from the user's browser to this serverless
//     route as raw bytes, then to Anthropic as base64. No client-side
//     rendering. Browser memory pressure → zero. Safari throttling →
//     irrelevant (work happens server-side, not in the tab).
//
//   • The tool-use schema below makes `improvements_value_source`
//     REQUIRED — Claude can't return a value without citing exactly
//     where in the document it came from. Plus the system prompt
//     explicitly teaches Claude that irrigation, water wells, fencing,
//     and other agricultural infrastructure are improvements (the
//     legacy prompt only listed structures, which is what tricked the
//     OpenAI extractor into ignoring the $575k irrigation).
//
// SCOPE
// ─────
// This route does EXTRACTION ONLY. The auto-locate, parcel-matching,
// and dedupe steps still live in /api/import-chat. For V1 we're trading
// some autoLocate coverage for end-to-end reliability — most appraisal
// PDFs include explicit "Geographic Location" lat/lng per comp anyway
// (Thorndale: every comp had it). If we need autoLocate on top of
// Claude extraction, that's a follow-up: same compositional helper
// pattern, called after this route returns.
//
// RESPONSE SHAPE
// ──────────────
// Matches /api/import-chat exactly: { message, comps, diagnostic }.
// The frontend handler can fan in results from either source without
// caring which engine produced them.
// ─────────────────────────────────────────────────────────────────────────

// Vercel hard-caps serverless functions; we have a 90-second budget
// internally to leave 30s headroom for Anthropic latency variance.
export const maxDuration = 120;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Anthropic tool-use input_schema. Mirrors COMP_SCHEMA from
// compExtractionSchema.ts as closely as we can while staying compatible
// with Anthropic's stricter handling of nullable enums.
//
// Three notable additions over the OpenAI schema:
//   1. improvements_value_source is REQUIRED whenever improvements_value
//      is non-null. The legacy schema only required sources on acres,
//      sale_price, price_per_acre, and ppa_land_only — leaving
//      improvements_value as the silent failure point that gave us the
//      Fritz Farm $190k bug.
//   2. document_type is REQUIRED at the top level so the telemetry table
//      can route on it later (extraction_runs.doc_type).
//   3. evidence_pages on each comp lets us deep-link from the vault back
//      into the specific pages this comp was drawn from.
// Exported so the orchestrator route can reuse the same tool schema.
// Single source of truth for Claude's structured-output contract.
export const SUBMIT_COMPS_TOOL: Anthropic.Tool = {
  name: 'submit_comps',
  description:
    'Submit the structured comps extracted from this PDF. Call this tool exactly once after reading the entire document.',
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description:
          'A short summary of what you found, broker-readable. E.g. "Extracted 6 comparable land sales from a 71-page appraisal of a 236.89-acre Milam County ranch."',
      },
      document_type: {
        type: 'string',
        enum: [
          'full_appraisal',
          'single_comp_sheet',
          'comp_list',
          'mls_export',
          'closing_statement',
          'active_listing',
          'broker_packet',
          'other',
        ],
        description:
          'Overall classification of the document. full_appraisal = subject + multiple comps (most common). single_comp_sheet = one farm/ranch sale write-up. active_listing = property for sale (NOT a closed transaction; return comps:[] in this case).',
      },
      comps: {
        type: 'array',
        description:
          'One entry per COMPARABLE SALE in the document. NOT the subject property being valued. In an active_listing, return [].',
        items: {
          type: 'object',
          properties: {
            // ── Identification ────────────────────────────────────────
            property_name: { type: ['string', 'null'] },
            county: { type: ['string', 'null'] },
            state: { type: ['string', 'null'], description: '2-letter state abbreviation, e.g. TX' },

            // ── Numeric core ──────────────────────────────────────────
            acres: { type: ['number', 'null'] },
            acres_source: {
              type: ['string', 'null'],
              description:
                "Document location where acres came from. e.g. 'p2 · Property Description · Gross Acres row'",
            },
            sale_price: { type: ['number', 'null'] },
            sale_price_source: { type: ['string', 'null'] },
            price_per_acre: { type: ['number', 'null'] },
            price_per_acre_source: { type: ['string', 'null'] },
            ppa_land_only: { type: ['number', 'null'] },
            ppa_land_only_source: { type: ['string', 'null'] },
            price_land_only: { type: ['number', 'null'] },

            // ── Improvements (Fritz Farm bug class — this is THE field) ──
            improvements_value: {
              type: ['number', 'null'],
              description:
                'TOTAL contributory value of ALL improvements on the property. Sum every "contributory value of $X" or "ECV of $X" or "CV of $X" you find — including agricultural infrastructure (irrigation systems, water wells, fencing, livestock facilities), recreational improvements (lodge, hunting blinds), AND structures (house, barn, outbuildings). DO NOT use the per-acre figure (e.g. "$1,073/acre for irrigation") as the value — that is the per-acre rate, NOT the total dollar amount.',
            },
            improvements_value_source: {
              type: ['string', 'null'],
              description:
                'REQUIRED when improvements_value is non-null. Itemize each contributory value with its dollar amount and the arithmetic. e.g. "p2 · Remarks · irrigation $575,000 + hay barn $190,000 = $765,000". If improvements_value is null, set this to a brief reason like "no contributory value stated in document".',
            },
            improvements_notes: { type: ['string', 'null'] },
            has_improvements: { type: 'boolean' },

            // ── Transaction ───────────────────────────────────────────
            sale_date: {
              type: ['string', 'null'],
              description: 'ISO format YYYY-MM-DD. If only month/year given, use first day of that month.',
            },
            grantor: { type: ['string', 'null'] },
            grantee: { type: ['string', 'null'] },
            recording_number: { type: ['string', 'null'] },
            financing: { type: ['string', 'null'] },
            confirmation_source: { type: ['string', 'null'] },

            // ── Location ──────────────────────────────────────────────
            address: { type: ['string', 'null'] },
            latitude: { type: ['number', 'null'] },
            longitude: { type: ['number', 'null'] },
            parcel_id: { type: ['string', 'null'] },

            // ── Property characteristics ──────────────────────────────
            minerals_sold: { type: ['string', 'null'] },
            water: {
              type: ['string', 'null'],
              enum: ['None', 'Seasonal', 'Strong', null],
              description: 'None = dry; Seasonal = wet-weather creeks, dirt tanks; Strong = year-round water (live creek, river frontage, springs, multiple lakes/ponds).',
            },
            road_frontage: {
              type: ['string', 'null'],
              enum: ['None', 'Low', 'Medium', 'High', null],
            },
            irrigation: {
              type: ['string', 'null'],
              enum: ['None', 'Medium', 'Strong', null],
              description: 'Strong = active center-pivot or comprehensive irrigation system. Medium = limited or partial. None = no irrigation. SEPARATE from water — irrigated farmland with no live water is irrigation=Strong, water=None.',
            },
            has_water_rights: { type: 'boolean' },
            flood_plain: {
              type: ['string', 'null'],
              enum: ['Yes', 'Partial', 'No', null],
              description: 'Yes = significant portion in 100-year floodplain. Partial = small portion only (creeks/draws). No = outside floodplain.',
            },
            wildlife_notes: { type: ['string', 'null'] },
            description: {
              type: ['string', 'null'],
              description:
                'Broker-readable property description. 3-5 sentences summarizing what makes this property unique. Pull from the Remarks section when present.',
            },

            // ── Flags ─────────────────────────────────────────────────
            is_subject_property: {
              type: 'boolean',
              description:
                'TRUE only if this entry is the SUBJECT being valued (rare — usually you should skip the subject and only return comparable sales). Defaults FALSE.',
            },
            is_comparable: {
              type: 'boolean',
              description: 'TRUE for every comparable sale. FALSE for the subject property.',
            },

            // ── Provenance ─────────────────────────────────────────────
            evidence_pages: {
              type: 'array',
              items: { type: 'integer' },
              description:
                'PDF page numbers this comp was drawn from. E.g. [37, 38] for a Land Sale 1 on pages 37-38.',
            },
            confidence: {
              type: 'object',
              properties: {
                overall: {
                  type: 'number',
                  description: '0.0-1.0. Overall confidence in this extraction.',
                },
                per_field: {
                  type: ['string', 'null'],
                  description:
                    'Optional notes on field-by-field confidence. E.g. "acres: high; improvements_value: medium (no itemized values, used summary)".',
                },
              },
              required: ['overall', 'per_field'],
            },
          },
          required: [
            'property_name',
            'county',
            'state',
            'acres',
            'acres_source',
            'sale_price',
            'sale_price_source',
            'sale_date',
            'price_per_acre',
            'improvements_value',
            'improvements_value_source',
            'has_improvements',
            'is_subject_property',
            'is_comparable',
            'evidence_pages',
            'confidence',
          ],
        },
      },
    },
    required: ['message', 'document_type', 'comps'],
  },
};

// Exported so the orchestrator route can reuse Claude's prompt.
export const CLAUDE_PDF_SYSTEM_PROMPT = `You are Landstack AI — a land and ranch real estate data extraction specialist for Texas land brokers.

You receive a PDF of a real-estate document (most often a Stouffer-style appraisal report or a single-property comp sheet). Read every page, identify what kind of document it is, and extract all comparable sales using the submit_comps tool.

═══════════════════════════════════════════════════════════════════
WHAT TO EXTRACT
═══════════════════════════════════════════════════════════════════

Identify each COMPARABLE SALE in the document. Skip the subject property (the property being valued — its sale isn't being recorded). For an active listing or a document with no closed sales, return comps: [].

A comp is recognizable by:
  • A "Land Sale N" / "Sale N" / "Sale No. N" / "Comparable N" / "Comp #N" / "Property A/B/C" header
  • OR an "Identification" + "Transaction Information" + "Property Information" block on a single-comp sheet

═══════════════════════════════════════════════════════════════════
IMPROVEMENTS VALUE — read this section twice
═══════════════════════════════════════════════════════════════════

improvements_value = TOTAL contributory value of ALL improvements on the property at the time of sale.

Improvements include ALL of these — not just structures:
  STRUCTURES:  house / dwelling / barn / outbuildings / hangars / storage
  AGRICULTURAL: center-pivot irrigation systems, drip irrigation, flood
                irrigation, water wells with pumps, livestock handling
                facilities, cattle pens, scales, hay barns, equipment
                sheds
  LAND IMPS:   cross-fencing, perimeter fencing, internal roads, gated
                entries, cattle guards
  RECREATIONAL: hunting blinds, food plots, deer feeders, lodge
                facilities, shooting houses, boat houses

How to extract:

1. Scan the document for EVERY phrase like:
     "contributory value of $X"
     "ECV of $X"  ("Estimated Contributory Value")
     "CV of $X"   ("Contributory Value")
     "estimated value of $X"
     "Improvement Value: $X"

2. Sum ALL of them. They are often listed separately, sometimes paragraphs apart in dense prose. The Fritz Farm document, for example, mentions "irrigation systems with the estimated contributory value of $575,000" in one sentence and "hay barn with the estimated contributory value of $190,000" in the next. The improvements_value is $575,000 + $190,000 = $765,000.

3. NEVER use a per-acre figure as the total. "$1,073 per acre" for irrigation on a 536-acre property is the per-acre rate; the total contributory value is $575,000.

4. improvements_value_source MUST itemize. Don't just say "p2 · Remarks." Show every contribution and the arithmetic. Format:
     "p2 · Remarks · irrigation systems $575,000 + hay barn $190,000 = $765,000"

5. If you cannot find any contributory value statement AND the property is described as having improvements, set improvements_value to null and explain in improvements_value_source (e.g. "p2 mentions a 2,334-sf residence but no contributory value stated").

═══════════════════════════════════════════════════════════════════
PRIOR SALES — do not confuse with the documented transaction
═══════════════════════════════════════════════════════════════════

Many comp sheets mention a PRIOR sale of the same property at the bottom of the Remarks (e.g. "The 536.01 acres was purchased by the Grantor from Marsha Powell, Trustee of the Powell Family Trust in October 2020 for $1,980,466 or $3,695 per acre"). The CURRENT transaction's sale_price, sale_date, grantor, and grantee are the ones at the top of the Transaction Information block — NOT the prior sale.

Never use prior-sale numbers in any field of the current comp.

═══════════════════════════════════════════════════════════════════
CITE THE SOURCE — every numeric field
═══════════════════════════════════════════════════════════════════

For each comp, provide the *_source field for each numeric value with the EXACT document location:

  PREFERRED — labeled table rows:
    "p37 · Transaction Information · 'Sale Price' row"
    "p38 · Property Description · 'Gross Acres' row"

  ACCEPTABLE — labeled prose:
    "p2 · Remarks · '536.01 acres' first sentence"

  NEVER:
    "inferred from context", "calculated", "guessed"
    A reference to a different comp or the subject
    A reference to a prior sale section

If you cannot cite a source for a numeric field, set both the value AND the _source to null. A missing value with a clear "no labeled value found" beats a fabricated number with a vague source.

═══════════════════════════════════════════════════════════════════
EVIDENCE PAGES
═══════════════════════════════════════════════════════════════════

evidence_pages = ACTUAL PDF page numbers where this comp's data lives. Most multi-comp appraisals dedicate 2 pages per comp (one with the aerial/identification table, one with property description + remarks). E.g. Land Sale 1 might be evidence_pages: [37, 38].

═══════════════════════════════════════════════════════════════════
NORMALIZATION
═══════════════════════════════════════════════════════════════════

  state         → 2-letter abbreviation: "TX" not "Texas"
  county        → name only without "County" suffix: "Frio" not "Frio County"
  sale_date     → ISO YYYY-MM-DD: "2022-06-29" not "June 29, 2022"
  acres         → number to 2 decimal places when stated more precisely

═══════════════════════════════════════════════════════════════════
DOCUMENT TYPE
═══════════════════════════════════════════════════════════════════

  full_appraisal     — subject + multiple comparable sales (most common)
  single_comp_sheet  — one farm/ranch sale write-up (e.g. Fritz Farm)
  comp_list          — broker-curated multi-comp table without an appraisal narrative
  mls_export         — MLS Sold sheet or agent-facing listing summary
  closing_statement  — HUD-1 / settlement statement with buyer/seller, minimal property detail
  active_listing     — property for sale, no sale_date / grantor / grantee → comps: []
  broker_packet      — mixed bag, e.g. an offering memorandum with comp data appended
  other              — anything else

Call submit_comps exactly once with the full result.`;

interface ClaudeCompResult {
  property_name: string | null;
  county: string | null;
  state: string | null;
  acres: number | null;
  acres_source: string | null;
  sale_price: number | null;
  sale_price_source: string | null;
  price_per_acre: number | null;
  price_per_acre_source: string | null;
  ppa_land_only: number | null;
  ppa_land_only_source: string | null;
  price_land_only: number | null;
  improvements_value: number | null;
  improvements_value_source: string | null;
  improvements_notes: string | null;
  has_improvements: boolean;
  sale_date: string | null;
  grantor: string | null;
  grantee: string | null;
  recording_number: string | null;
  financing: string | null;
  confirmation_source: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  parcel_id: string | null;
  minerals_sold: string | null;
  water: string | null;
  road_frontage: string | null;
  irrigation: string | null;
  has_water_rights: boolean;
  flood_plain: string | null;
  wildlife_notes: string | null;
  description: string | null;
  is_subject_property: boolean;
  is_comparable: boolean;
  evidence_pages: number[];
  confidence: { overall: number; per_field: string | null };
}

interface ClaudeResponse {
  message: string;
  document_type: string;
  comps: ClaudeCompResult[];
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { message: 'No file provided.', comps: null },
        { status: 400 }
      );
    }
    if (file.type !== 'application/pdf') {
      return NextResponse.json(
        { message: `Expected a PDF, got ${file.type}.`, comps: null },
        { status: 400 }
      );
    }

    // Anthropic's API caps PDF file size at 32MB per request. Our broker
    // appraisals run 3-10MB typically — Thorndale is 3.9MB / 71 pages.
    // Reject anything over 30MB with a clear error rather than letting
    // Anthropic time out on us.
    const sizeMB = file.size / 1024 / 1024;
    if (sizeMB > 30) {
      return NextResponse.json(
        {
          message: `PDF is ${sizeMB.toFixed(1)}MB — too large. Maximum 30MB per upload. Split the document or scan at lower DPI.`,
          comps: null,
        },
        { status: 413 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const base64Pdf = buffer.toString('base64');

    console.log(
      `[import-pdf-claude] ${file.name} · ${sizeMB.toFixed(2)}MB · sending to Claude…`
    );

    // 90-second hard cap. Vercel will kill us at 120 anyway; failing
    // fast at 90 leaves room for graceful error response and frontend
    // toast. AbortController is wired via the SDK's signal parameter.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90_000);

    let message: Anthropic.Message;
    try {
      message = await anthropic.messages.create(
        {
          model: 'claude-sonnet-4-5',
          // 16k output is comfortable for ~10 comps with full schemas.
          // Long appraisals (Thorndale = 6 comps) stay under 8k tokens
          // out empirically. Bumped to 16k to leave headroom.
          max_tokens: 16000,
          system: CLAUDE_PDF_SYSTEM_PROMPT,
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
                    data: base64Pdf,
                  },
                },
                {
                  type: 'text',
                  text: `Extract every comparable sale from "${file.name}". Call submit_comps once with the full result.`,
                },
              ],
            },
          ],
        },
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const elapsedMs = Date.now() - startTime;

    // Claude returns content blocks; find the submit_comps tool_use.
    const toolUse = message.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === 'tool_use' && b.name === 'submit_comps'
    );

    if (!toolUse) {
      console.error(
        '[import-pdf-claude] Claude did not call submit_comps. stop_reason:',
        message.stop_reason
      );
      return NextResponse.json(
        {
          message:
            "Claude couldn't structure the extraction. The document may be unreadable (corrupt PDF, password-protected, or not a real-estate document). Try a different file.",
          comps: null,
          diagnostic: {
            stop_reason: message.stop_reason,
            elapsed_ms: elapsedMs,
          },
        },
        { status: 502 }
      );
    }

    const parsed = toolUse.input as ClaudeResponse;
    const rawComps = Array.isArray(parsed.comps) ? parsed.comps : [];

    // Drop subject-property entries — we only want comparable sales in
    // the vault. The schema asks Claude to omit subjects already, but
    // double-check defensively.
    const comps = rawComps
      .filter((c) => c.is_comparable !== false && c.is_subject_property !== true)
      .map((c) => ({
        // Re-shape to match what /api/import-chat returns. The frontend
        // verification card flow already consumes this shape; keeping
        // field-for-field parity means zero UI changes.
        ...c,
        // Frontend expects price_land_only and ppa_land_only as derived
        // fields. If Claude didn't compute them, derive them now so the
        // verification card shows the land-only math correctly.
        price_land_only:
          c.price_land_only ??
          (c.sale_price != null && c.improvements_value != null
            ? c.sale_price - c.improvements_value
            : null),
        ppa_land_only:
          c.ppa_land_only ??
          (c.sale_price != null && c.improvements_value != null && c.acres
            ? Math.round((c.sale_price - c.improvements_value) / c.acres)
            : null),
      }));

    const filteredOut = rawComps.length - comps.length;
    console.log(
      `[import-pdf-claude] ${file.name} · ${comps.length} comp(s) extracted ` +
        `(${filteredOut} filtered subject/non-comparable) · ${(elapsedMs / 1000).toFixed(1)}s · ` +
        `tokens in=${message.usage.input_tokens} out=${message.usage.output_tokens}`
    );

    return NextResponse.json({
      message:
        parsed.message ||
        (comps.length === 0
          ? 'Reviewed the document. No comparable sales found.'
          : `Extracted ${comps.length} ${comps.length === 1 ? 'comp' : 'comps'} from the document.`),
      comps,
      diagnostic: {
        document_type: parsed.document_type,
        raw_extracted: rawComps.length,
        filtered_out: filteredOut,
        elapsed_ms: elapsedMs,
        model: 'claude-sonnet-4-5',
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      },
    });
  } catch (error: any) {
    const elapsedMs = Date.now() - startTime;

    // AbortController fired → 90-second timeout was hit. This is the
    // soft cap before Vercel's 120s hard cap; report it cleanly so the
    // broker sees "took too long" instead of a generic 500.
    if (error?.name === 'AbortError') {
      console.error(
        `[import-pdf-claude] timeout at ${(elapsedMs / 1000).toFixed(1)}s`
      );
      return NextResponse.json(
        {
          message:
            'Extraction took longer than 90 seconds and was cancelled. The document may be very long or scanned at high DPI. Try splitting the PDF into smaller sections (e.g. just the Sales Comparison Approach pages).',
          comps: null,
          diagnostic: { timeout: true, elapsed_ms: elapsedMs },
        },
        { status: 504 }
      );
    }

    // Surface Anthropic-side errors with their actual error message
    // — gives the broker (and us debugging) a real signal instead of
    // a generic "something broke."
    const status = error?.status ?? 500;
    const anthropicMessage =
      error?.error?.error?.message || error?.message || 'Unknown error';

    console.error(
      `[import-pdf-claude] error ${status}: ${anthropicMessage}`,
      error?.error || error
    );

    return NextResponse.json(
      {
        message:
          status === 401
            ? 'Landstack lost its API key for the AI service. Please contact support.'
            : status === 429
              ? 'AI service is rate-limited right now. Retry in 30-60 seconds.'
              : status === 400
                ? `Anthropic rejected the request: ${anthropicMessage}`
                : 'Extraction failed. Try the file again, or split it into smaller sections.',
        comps: null,
        diagnostic: {
          status,
          error: anthropicMessage,
          elapsed_ms: elapsedMs,
        },
      },
      { status: status === 401 ? 500 : status }
    );
  }
}

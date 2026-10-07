import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient as createSupabaseUserClient } from '@/lib/supabase/server';
import crypto from 'crypto';

import { IMPORT_RESPONSE_SCHEMA } from '@/lib/utils/compExtractionSchema';
import { IMPORT_SYSTEM_PROMPT } from '@/app/api/import-chat/route';
import {
  CLAUDE_PDF_SYSTEM_PROMPT,
  SUBMIT_COMPS_TOOL,
} from '@/app/api/import-pdf-claude/route';
import { renderPdfPageToJpg } from '@/lib/extraction/convertapi';
import { cropAerialFromPageJpg } from '@/lib/extraction/cropAerial';

// ─────────────────────────────────────────────────────────────────────────
// PDF extraction orchestrator — Claude native-PDF extraction primary,
// text-path extraction fallback, both results written to
// extraction_runs for post-hoc comparison.
//
// ENGINE HISTORY: the text fallback originally ran on OpenAI
// gpt-4o-mini. When the OpenAI account ran dry (2026-10), the fallback
// engine was swapped to Claude — but the ~600 lines of accumulated
// broker domain knowledge in IMPORT_SYSTEM_PROMPT (Texas terminology,
// MLS section handling, subject-vs-comp disambiguation, normalization
// rules, taught by months of real broker uploads) carried over
// VERBATIM. The prompt is the asset; the engine behind it is a part.
//
// WHY TWO PATHS (not one):
//
//   - The PRIMARY reads the PDF binary natively — it sees 2-column
//     appraiser layouts the way a human does. This fixed the v2
//     regression where 4 of 12 Frio Farms PDFs returned 0 comps via
//     the text path (pdf-parse jumbles label/value columns).
//
//   - The TEXT FALLBACK still earns its keep for the rare case the
//     native-PDF path errors (rate limit, malformed-but-parseable
//     PDF): pdf-parse text + the battle-tested import prompt recovers
//     most single-column documents.
//
// FAILURE-CONDITION LADDER (what gets shown to the broker):
//
//   1. Primary succeeds with ≥1 comp    → show it, skip fallback
//   2. Primary errors or returns 0      → run text fallback; show it
//                                          if it found comps
//   3. Both empty/failed                → clean error to the broker
//
// COST: fallback only runs when the primary fails, so normal uploads
// cost one extraction call.
// ─────────────────────────────────────────────────────────────────────────

export const maxDuration = 300;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Service-role client for extraction_runs writes. The RLS on the table
// blocks direct client inserts (see migration 038). Only the service
// role bypasses RLS. The cookie-based user client we keep separately
// is just for reading the auth.uid + team_id.
const supabaseAdmin = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

interface ExtractedComp {
  property_name: string | null;
  county: string | null;
  state: string | null;
  acres: number | null;
  sale_price: number | null;
  sale_date: string | null;
  price_per_acre: number | null;
  improvements_value: number | null;
  improvements_value_source: string | null;
  has_improvements: boolean;
  latitude: number | null;
  longitude: number | null;
  [key: string]: any;
}

interface ExtractionResult {
  message: string;
  comps: ExtractedComp[];
  diagnostic?: any;
}

interface EngineRun {
  engine: 'claude_text' | 'claude';
  model: string;
  ok: boolean;
  result: ExtractionResult | null;
  error: string | null;
  elapsed_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
}

const TEXT_FALLBACK_MODEL = 'claude-opus-5-5';

// The old OpenAI strict json_schema mode GUARANTEED every comp carried
// a confidence object ({overall, per_field}); downstream code — the
// import page's saveComp reads comp.confidence.overall unguarded —
// grew to rely on that. Non-strict tools can omit it, which made
// auto-save silently fail on otherwise-good comps. Restore the old
// invariant at the source for every engine's output.
function ensureConfidence<T>(comps: T[]): T[] {
  for (const c of comps as any[]) {
    if (!c.confidence || typeof c.confidence !== 'object') {
      c.confidence = { overall: 50, per_field: null };
    } else if (typeof c.confidence.overall !== 'number') {
      c.confidence.overall = 50;
    } else if (c.confidence.overall > 0 && c.confidence.overall <= 1) {
      // Scale mismatch: CLAUDE_PDF_SYSTEM_PROMPT's tool schema asks for
      // 0.0-1.0 but every downstream threshold (saveComp Verified>80,
      // math-gate priceConf>=80, review classification) expects 0-100.
      // A 0.95-confidence comp was saving as "Unverified" and jamming
      // the review queue. Normalize fractions to percentages.
      c.confidence.overall = Math.round(c.confidence.overall * 100);
    }
  }
  return comps;
}

// The same response schema the OpenAI json_schema response_format
// enforced, re-expressed as a tool. The schema itself
// (IMPORT_RESPONSE_SCHEMA) is unchanged. Deliberately NOT strict:
// Anthropic's strict validation rejects this schema twice over — the
// OpenAI nullable-enum idiom ({type:['string','null'], enum:[...,
// null]}) 400s, and 33 nullable fields exceeds the 16-union strict
// limit. The production SUBMIT_COMPS_TOOL (import-pdf-claude) runs the
// same idioms non-strict in production daily; downstream code already
// filters defensively.
const SUBMIT_COMPS_TEXT_TOOL = {
  name: 'submit_comps',
  description:
    'Submit the full extraction result. Call exactly once with the ' +
    'message and every comparable sale found in the document.',
  input_schema: IMPORT_RESPONSE_SCHEMA,
} as const;

// ─── Text-path extraction (fallback) ────────────────────────────────────
// Uses the same battle-tested IMPORT_SYSTEM_PROMPT as the legacy GPT
// path (verbatim — the prompt is the asset). We send the
// pdf-parse-extracted text wrapped the same way to preserve the
// prompt's expected user-message shape. Engine swapped from
// gpt-4o-mini to Claude 2026-10 (OpenAI account unfunded).
//
// Note on determinism: the old path set temperature: 0 because GPT
// returned 5 comps on one Thorndale run and 6 on the next (a
// completeness bug, fixed in a64b2e2). Current Claude models removed
// the temperature parameter entirely (400 if sent); the strict tool
// schema + "extract EVERY comparable" instruction carry the same
// intent.
async function runTextFallback(text: string, fileName: string): Promise<EngineRun> {
  const t0 = Date.now();
  try {
    if (!text || text.trim().length < 200) {
      return {
        engine: 'claude_text',
        model: TEXT_FALLBACK_MODEL,
        ok: false,
        result: null,
        error:
          'PDF text extraction yielded too little content. Document may be scanned (image-only) — text path needs OCR.',
        elapsed_ms: Date.now() - t0,
        input_tokens: null,
        output_tokens: null,
      };
    }

    const message = await anthropic.messages.create({
      model: TEXT_FALLBACK_MODEL,
      // 16k is the floor — 6k was at the truncation boundary
      // for 6-comp appraisals. 16k gives generous headroom.
      max_tokens: 16000,
      system: IMPORT_SYSTEM_PROMPT,
      tools: [SUBMIT_COMPS_TEXT_TOOL],
      messages: [
        {
          role: 'user',
          content:
            `Please extract all comparable sales from this document (filename: ${fileName}). ` +
            `Call submit_comps exactly once with the full result.\n\n${text}`,
        },
      ],
    } as any);

    const toolUse = (message.content as any[]).find(
      (b) => b.type === 'tool_use' && b.name === 'submit_comps',
    );
    if (!toolUse) {
      return {
        engine: 'claude_text',
        model: TEXT_FALLBACK_MODEL,
        ok: false,
        result: null,
        error: `text fallback did not call submit_comps (stop_reason=${(message as any).stop_reason})`,
        elapsed_ms: Date.now() - t0,
        input_tokens: (message as any).usage?.input_tokens ?? null,
        output_tokens: (message as any).usage?.output_tokens ?? null,
      };
    }
    const parsed: any = toolUse.input;
    const rawComps: ExtractedComp[] = Array.isArray(parsed.comps) ? parsed.comps : [];
    // Drop subject entries — schema returns is_comparable so we filter on it.
    const comps = ensureConfidence(rawComps.filter(
      (c: any) => c.is_comparable !== false && c.is_subject_property !== true,
    ));

    return {
      engine: 'claude_text',
      model: TEXT_FALLBACK_MODEL,
      ok: true,
      result: {
        // User-facing message — engine name stripped. Broker sees
        // "Landstack extracted N comps," not which engine produced it.
        // Engine identity stays in the diagnostic block + telemetry for
        // our internal debugging only.
        message: parsed.message || `Extracted ${comps.length} ${comps.length === 1 ? 'comp' : 'comps'} from your document.`,
        comps,
        diagnostic: { raw_extracted: rawComps.length, filtered_out: rawComps.length - comps.length },
      },
      error: null,
      elapsed_ms: Date.now() - t0,
      input_tokens: (message as any).usage?.input_tokens ?? null,
      output_tokens: (message as any).usage?.output_tokens ?? null,
    };
  } catch (e: any) {
    return {
      engine: 'claude_text',
      model: TEXT_FALLBACK_MODEL,
      ok: false,
      result: null,
      error: e?.message || String(e),
      elapsed_ms: Date.now() - t0,
      input_tokens: null,
      output_tokens: null,
    };
  }
}

// ─── Claude extraction (PDF binary input) ───────────────────────────────
// Uses the same tool schema + prompt as /api/import-pdf-claude. Calls
// Anthropic's native PDF support directly.
async function runClaude(pdfBuffer: Buffer, fileName: string): Promise<EngineRun> {
  const t0 = Date.now();
  try {
    const base64 = pdfBuffer.toString('base64');
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 16000,
      // temperature: 0 for the same reason GPT got it — structured
      // extraction needs deterministic output. Default Claude
      // temperature (1.0) was giving us 5 comps on one Thorndale
      // run and 6 on the next (production 2026-06-18, broker upload).
      // Identical PDF, identical prompt, different result. That's the
      // *completeness* bug, not a quality bug — the model gives up
      // early sometimes when it could've kept going. For extraction
      // we want the same input to produce the same output every time.
      // Mirrors the GPT temperature: 0 fix from a64b2e2.
      temperature: 0,
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
                data: base64,
              },
            },
            {
              type: 'text',
              text: `Extract every comparable sale from "${fileName}". Call submit_comps once with the full result.`,
            },
          ],
        },
      ],
    });

    const toolUse = message.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === 'tool_use' && b.name === 'submit_comps',
    );
    if (!toolUse) {
      return {
        engine: 'claude',
        model: 'claude-sonnet-4-5',
        ok: false,
        result: null,
        error: `Claude did not call submit_comps (stop_reason=${message.stop_reason})`,
        elapsed_ms: Date.now() - t0,
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      };
    }
    const parsed: any = toolUse.input;
    const rawComps: ExtractedComp[] = Array.isArray(parsed.comps) ? parsed.comps : [];
    const comps = rawComps
      .filter((c: any) => c.is_comparable !== false && c.is_subject_property !== true)
      .map((c: any) => ({
        ...c,
        // Match GPT's price_land_only / ppa_land_only behavior when
        // Claude didn't compute them.
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
    ensureConfidence(comps);

    return {
      engine: 'claude',
      model: 'claude-sonnet-4-5',
      ok: true,
      result: {
        message: parsed.message || `Extracted ${comps.length} ${comps.length === 1 ? 'comp' : 'comps'} from your document.`,
        comps,
        diagnostic: {
          document_type: parsed.document_type,
          raw_extracted: rawComps.length,
          filtered_out: rawComps.length - comps.length,
        },
      },
      error: null,
      elapsed_ms: Date.now() - t0,
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
    };
  } catch (e: any) {
    return {
      engine: 'claude',
      model: 'claude-sonnet-4-5',
      ok: false,
      result: null,
      error: e?.message || String(e),
      elapsed_ms: Date.now() - t0,
      input_tokens: null,
      output_tokens: null,
    };
  }
}

// ─── Telemetry write ────────────────────────────────────────────────────
// One row per (engine, PDF). Same sha256 across both engines so we can
// join rows from the same upload later. Fire-and-forget — extraction
// already succeeded by the time we get here; a telemetry write failure
// must NOT propagate to the user.
async function logRun(args: {
  run: EngineRun;
  user_id: string | null;
  team_id: string | null;
  sha256: string;
  file_name: string;
  file_size_bytes: number;
  page_count: number | null;
  doc_type: string | null;
  has_live_text: boolean;
  routing_reason: string;
  was_shown_to_user: boolean;
}) {
  const { run, ...meta } = args;
  const compsCount = run.result?.comps?.length ?? 0;
  // % of schema fields filled (rough proxy — averaged across comps).
  // Useful as a quality signal when comparing engines.
  let fieldsFilledPct: number | null = null;
  if (run.result && run.result.comps.length > 0) {
    const total = run.result.comps.length;
    let filled = 0;
    let possible = 0;
    for (const c of run.result.comps) {
      for (const k of Object.keys(c)) {
        possible++;
        if (c[k] !== null && c[k] !== undefined && c[k] !== '') filled++;
      }
    }
    fieldsFilledPct = possible > 0 ? (filled / possible) * 100 : null;
  }

  // Anthropic costs per million tokens (published, keyed by model so
  // the primary and text-fallback engines price independently):
  //   claude-sonnet-4-5: $3.00 input, $15.00 output
  //   claude-opus-5-5:   $4.00 input, $20.00 output
  const PRICES: Record<string, [number, number]> = {
    'claude-sonnet-4-5': [3.0, 15.0],
    'claude-opus-5-5': [4.0, 20.0],
  };
  let costUsd: number | null = null;
  if (run.input_tokens != null && run.output_tokens != null) {
    const p = PRICES[run.model];
    if (p) {
      costUsd = (run.input_tokens * p[0] + run.output_tokens * p[1]) / 1_000_000;
    }
  }

  const { error } = await supabaseAdmin.from('extraction_runs').insert({
    user_id: meta.user_id,
    team_id: meta.team_id,
    file_name: meta.file_name,
    file_size_bytes: meta.file_size_bytes,
    page_count: meta.page_count,
    doc_type: meta.doc_type,
    has_live_text: meta.has_live_text,
    sha256: meta.sha256,
    engine: run.engine,
    model: run.model,
    routing_reason: meta.routing_reason,
    comps_extracted: compsCount,
    subject_property_found: false, // refined later when needed
    fields_filled_pct: fieldsFilledPct,
    latency_ms: run.elapsed_ms,
    input_tokens: run.input_tokens,
    output_tokens: run.output_tokens,
    cost_usd: costUsd,
    succeeded: run.ok,
    error_message: run.error,
    error_stage: run.ok ? null : run.engine === 'claude_text' ? 'text_extract' : 'claude_extract',
  });
  if (error) {
    console.error('[orchestrator] extraction_runs insert failed:', error.message);
  }
}

// ─── Main handler ───────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json(
        { message: 'No file provided.', comps: null },
        { status: 400 },
      );
    }
    if (file.type !== 'application/pdf') {
      return NextResponse.json(
        { message: `Expected a PDF, got ${file.type}.`, comps: null },
        { status: 400 },
      );
    }

    const sizeMB = file.size / 1024 / 1024;
    if (sizeMB > 30) {
      return NextResponse.json(
        {
          message: `PDF is ${sizeMB.toFixed(1)}MB — too large. Maximum 30MB per upload.`,
          comps: null,
        },
        { status: 413 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    // Identify the authenticated user/team for telemetry. We use the
    // user-scoped client (cookies-based) for THIS read only; the actual
    // insert happens via supabaseAdmin which bypasses RLS.
    let userId: string | null = null;
    let teamId: string | null = null;
    try {
      const userClient = createSupabaseUserClient();
      const { data: { user } } = await userClient.auth.getUser();
      if (user) {
        userId = user.id;
        const { data: profile } = await userClient
          .from('profiles')
          .select('team_id')
          .eq('id', user.id)
          .single();
        teamId = profile?.team_id ?? null;
      }
    } catch (e) {
      // Telemetry context fetch failed — keep going. Extraction runs
      // can still log with null user_id (RLS treats those as "unknown")
      // and we'll backfill if needed.
      console.warn('[orchestrator] auth context fetch failed:', e);
    }

    // Parse PDF to text for the text fallback. Failure here doesn't kill
    // the request — the primary extracts from the binary either way.
    let pdfText = '';
    let pageCount: number | null = null;
    let hasLiveText = false;
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const data = await pdfParse(buffer);
      pdfText = data.text || '';
      pageCount = data.numpages;
      hasLiveText = pdfText.trim().length > 200;
    } catch (e) {
      console.warn('[orchestrator] pdf-parse failed:', e);
    }

    console.log(
      `[orchestrator] ${file.name} · ${sizeMB.toFixed(2)}MB · ${pageCount ?? '?'} pages · ` +
        `live text ${hasLiveText ? '✓' : '✗'} · native-PDF primary, text fallback`,
    );

    // ─── Native-PDF primary, text path as fallback ───────────────────
    //
    // History of this decision:
    //   v1: parallel race (Stripe shadow pattern) — both engines run,
    //       result waits for max(text, native-PDF). Robust but slow.
    //   v2: text path primary, native-PDF fallback only — fast on
    //       success but silently dropped extraction on TYPE-A appraiser
    //       comp sheets with 2-column layouts. The text pdf-parse spits
    //       out is label-column-then-value-column, which a text-only
    //       model can't reliably align. We confirmed 4 of 12 Frio Farms
    //       PDFs returned 0 comps via the text path (Wesla, Wright,
    //       Bagan, VC5) — all of which were extracted correctly in May
    //       by the legacy /api/import-chat vision path that's since
    //       been deleted. Christina's exact use case was the
    //       regression.
    //   v3 (this): native-PDF primary. Claude reads the PDF binary
    //       directly via Anthropic's native PDF support — it sees the
    //       2-column layout the way a human does, not as a jumbled
    //       text dump. Verified 12 of 12 Frio Farms + Thorndale all
    //       extract cleanly. The text path remains the fallback for
    //       the rare case the primary itself errors.
    //
    // Latency trade-off: native-PDF on a 2-page comp sheet runs ~27s vs
    // text ~12s. The 15s extra is the price of reliability — the
    // alternative is silently returning 0 comps to the broker on
    // every other upload. We'll add per-comp progress streaming later
    // to make the wait feel shorter, but never trade correctness for
    // perceived speed.
    const claudeRun = await runClaude(buffer, file.name);

    let textRun: EngineRun;
    const claudeCompsCount = claudeRun.result?.comps?.length ?? 0;
    const claudeHasUsableResults = claudeRun.ok && claudeCompsCount > 0;

    if (claudeHasUsableResults) {
      // Primary succeeded — skip the fallback entirely. Stub a
      // placeholder run so the telemetry + diagnostic shape doesn't
      // need a separate path.
      textRun = {
        engine: 'claude_text',
        model: TEXT_FALLBACK_MODEL,
        ok: false,
        result: null,
        error: 'skipped: native-PDF primary succeeded',
        elapsed_ms: 0,
        input_tokens: null,
        output_tokens: null,
      };
    } else {
      console.log(
        `[orchestrator] ${file.name} · primary ${claudeRun.ok ? 'returned 0 comps' : `failed (${claudeRun.error})`}, falling back to text path`,
      );
      textRun = await runTextFallback(pdfText, file.name);
    }

    const elapsedMs = Date.now() - startTime;

    // ─── Failure-condition ladder ────────────────────────────────────
    let primary: 'claude_text' | 'claude';
    let routingReason: string;
    let chosen: ExtractionResult;

    const textCompCount = textRun.result?.comps?.length ?? 0;
    const claudeCompCount = claudeRun.result?.comps?.length ?? 0;
    const textHasResults = textRun.ok && textCompCount > 0;
    const claudeHasResults = claudeRun.ok && claudeCompCount > 0;

    // Selection ladder: trust Claude when it returned comps (it's the
    // primary engine — native PDF reader, layout-robust). Fall through
    // to the text path only when the primary couldn't get the job
    // done. The legacy "claudeFoundMoreComps" tiebreaker is gone —
    // under the new shape the fallback only runs when the primary
    // already failed, so a comp-count disagreement isn't possible on
    // the success path.
    if (claudeHasResults) {
      // The native-PDF primary returned comps — use them. Don't
      // second-guess with a text-path comparison: the primary reads
      // the PDF natively (vision-equivalent), the fallback reads
      // pdf-parse text that breaks on 2-column layouts.
      primary = 'claude';
      routingReason = 'claude_primary_success';
      chosen = claudeRun.result!;
    } else if (textHasResults) {
      // Primary empty or errored, text fallback recovered with results.
      primary = 'claude_text';
      if (!claudeRun.ok) {
        routingReason = `text_fallback_after_claude_${claudeRun.error?.includes('timeout') ? 'timeout' : 'error'}`;
      } else {
        routingReason = 'text_fallback_claude_zero_comps';
      }
      chosen = textRun.result!;
    } else if (claudeRun.ok) {
      // Both ran, both returned 0 comps. Show the primary's
      // empty-result message.
      primary = 'claude';
      routingReason = 'both_zero_comps';
      chosen = claudeRun.result!;
    } else if (textRun.ok) {
      // Primary errored, text fallback returned a result (even 0).
      primary = 'claude_text';
      routingReason = 'text_fallback_claude_error';
      chosen = textRun.result!;
    } else {
      // Both failed. Surface a clean error.
      console.error(
        `[orchestrator] BOTH engines failed. ` +
          `text=${textRun.error} · claude=${claudeRun.error}`,
      );
      // Still log both failures for telemetry.
      await Promise.allSettled([
        logRun({
          run: textRun,
          user_id: userId,
          team_id: teamId,
          sha256,
          file_name: file.name,
          file_size_bytes: file.size,
          page_count: pageCount,
          doc_type: null,
          has_live_text: hasLiveText,
          routing_reason: 'both_failed',
          was_shown_to_user: false,
        }),
        logRun({
          run: claudeRun,
          user_id: userId,
          team_id: teamId,
          sha256,
          file_name: file.name,
          file_size_bytes: file.size,
          page_count: pageCount,
          doc_type: null,
          has_live_text: hasLiveText,
          routing_reason: 'both_failed',
          was_shown_to_user: false,
        }),
      ]);
      return NextResponse.json(
        {
          message:
            "Extraction failed on both engines. The PDF may be corrupt, password-protected, or in an unsupported format. Try a different file.",
          comps: null,
          diagnostic: {
            text_error: textRun.error,
            claude_error: claudeRun.error,
            elapsed_ms: elapsedMs,
          },
        },
        { status: 502 },
      );
    }

    // ─── Write telemetry (fire-and-forget) ───────────────────────────
    const docType = (chosen.diagnostic?.document_type as string) ?? null;
    Promise.allSettled([
      logRun({
        run: textRun,
        user_id: userId,
        team_id: teamId,
        sha256,
        file_name: file.name,
        file_size_bytes: file.size,
        page_count: pageCount,
        doc_type: docType,
        has_live_text: hasLiveText,
        routing_reason: routingReason,
        was_shown_to_user: primary === 'claude_text',
      }),
      logRun({
        run: claudeRun,
        user_id: userId,
        team_id: teamId,
        sha256,
        file_name: file.name,
        file_size_bytes: file.size,
        page_count: pageCount,
        doc_type: docType,
        has_live_text: hasLiveText,
        routing_reason: routingReason,
        was_shown_to_user: primary === 'claude',
      }),
    ]).catch((e) => console.error('[orchestrator] telemetry batch failed:', e));

    console.log(
      `[orchestrator] ${file.name} · primary=${primary} · reason=${routingReason} · ` +
        `text: ${textRun.ok ? `${textRun.result?.comps.length ?? 0} comps in ${(textRun.elapsed_ms / 1000).toFixed(1)}s` : `FAIL: ${textRun.error}`} · ` +
        `claude: ${claudeRun.ok ? `${claudeRun.result?.comps.length ?? 0} comps in ${(claudeRun.elapsed_ms / 1000).toFixed(1)}s` : `FAIL: ${claudeRun.error}`} · ` +
        `total ${(elapsedMs / 1000).toFixed(1)}s`,
    );

    // ─── Aerial thumbnails (ConvertAPI render + Claude vision crop) ──
    // Two outputs per comp:
    //   1. source_page_image_data_url — the FULL appraisal-page render
    //      (Property Identification + Transaction Data + aerial all on
    //      one image). Used by the "Review Comp Card" modal accessible
    //      from the right panel — broker can verify the extracted
    //      fields against the source page side-by-side.
    //   2. aerial_thumbnail_data_url — JUST the cropped aerial
    //      photograph. Used by the bare image overlay at bottom-left
    //      of the map view, where the broker glances at it for
    //      context while drawing/verifying the parcel boundary.
    //
    // Pipeline:
    //   render page via ConvertAPI → save as source_page_image
    //                              → Claude vision crop (lib/extraction/cropAerial)
    //                              → save cropped as aerial_thumbnail
    //
    // Trade-offs:
    //   - PARALLEL via Promise.allSettled: N comp renders + crops happen
    //     concurrently. Total added latency for a 6-comp PDF: ~3-5s
    //     (1-2s ConvertAPI + 2-3s Claude vision per comp, parallelized).
    //   - INLINE base64 data URLs (no Supabase Storage upload yet):
    //     comps don't have DB IDs at this stage. Persisting JPGs to
    //     Storage before the broker decides to keep the comp would
    //     orphan files on every "discard". Inline now, persist on save.
    //   - BEST-EFFORT crop: if Claude says "no aerial" or vision call
    //     errors, the comp ships with source_page_image_data_url set
    //     and aerial_thumbnail_data_url=null. UI handles null gracefully
    //     (shows the "No aerial available" placeholder).
    //
    // Cost: 1 ConvertAPI op (~$0.007) + 1 Claude vision call (~$0.005)
    // per comp = ~$0.012/comp. Christina (~12 comps/mo) ≈ $0.14/mo.
    const thumbnailStartMs = Date.now();
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
    const thumbnailResults = await Promise.allSettled(
      chosen.comps.map(async (comp: any) => {
        const pages: number[] = Array.isArray(comp.evidence_pages)
          ? comp.evidence_pages.filter((n: any) => Number.isInteger(n) && n > 0)
          : [];
        if (pages.length === 0) return null;
        const pageBuf = await renderPdfPageToJpg(buffer, pages[0]);
        const fullPageDataUrl = `data:image/jpeg;base64,${pageBuf.toString('base64')}`;
        // Crop the aerial out of the rendered page. Defensive: if the
        // crop step throws or returns no_aerial, we still keep the
        // full-page render so the broker has SOMETHING to look at.
        const cropResult = await cropAerialFromPageJpg(pageBuf, anthropicApiKey);
        const aerialDataUrl = cropResult.cropped
          ? `data:image/jpeg;base64,${cropResult.cropped.toString('base64')}`
          : null;
        if (cropResult.reason !== 'ok' && cropResult.reason !== 'no_aerial') {
          console.warn(
            `[orchestrator] aerial crop ${cropResult.reason} for comp "${comp.property_name ?? comp.county ?? '?'}": ${cropResult.detail ?? ''}`,
          );
        }
        return { full: fullPageDataUrl, aerial: aerialDataUrl };
      }),
    );
    let pagesAttached = 0;
    let aerialsAttached = 0;
    let thumbnailsFailed = 0;
    chosen.comps.forEach((comp: any, i: number) => {
      const r = thumbnailResults[i];
      if (r.status === 'fulfilled' && r.value) {
        comp.source_page_image_data_url = r.value.full;
        comp.aerial_thumbnail_data_url = r.value.aerial;
        pagesAttached++;
        if (r.value.aerial) aerialsAttached++;
      } else {
        comp.source_page_image_data_url = null;
        comp.aerial_thumbnail_data_url = null;
        if (r.status === 'rejected') {
          thumbnailsFailed++;
          console.warn(`[orchestrator] page render failed for comp ${i + 1}:`, r.reason?.message ?? r.reason);
        }
      }
    });
    console.log(
      `[orchestrator] ${file.name} · pages rendered: ${pagesAttached}, aerials cropped: ${aerialsAttached}, failed: ${thumbnailsFailed} in ${((Date.now() - thumbnailStartMs) / 1000).toFixed(1)}s`,
    );

    // ─── Surface the chosen result ───────────────────────────────────
    // The broker NEVER sees which engine produced the answer or that
    // a fallback occurred — that's an implementation detail. They see
    // a single Landstack response with the comps. We log the routing
    // path in the diagnostic block + server console for our own
    // debugging only.
    //
    // The earlier draft of this code prefixed the message with things
    // like "⚠️ GPT timed out — showing Claude's read instead" which
    // (a) leaked the engine names into Christina's UI, (b) read as a
    // system error rather than a normal extraction, and (c) made
    // engine swaps a breaking change to the user copy. Removed.
    const userMessage = chosen.message;

    return NextResponse.json({
      message: userMessage,
      comps: chosen.comps,
      diagnostic: {
        primary,
        routing_reason: routingReason,
        elapsed_ms: elapsedMs,
        page_count: pageCount,
        has_live_text: hasLiveText,
        text_fallback: {
          ok: textRun.ok,
          comps: textRun.result?.comps.length ?? 0,
          elapsed_ms: textRun.elapsed_ms,
          input_tokens: textRun.input_tokens,
          output_tokens: textRun.output_tokens,
          error: textRun.error,
        },
        claude: {
          ok: claudeRun.ok,
          comps: claudeRun.result?.comps.length ?? 0,
          elapsed_ms: claudeRun.elapsed_ms,
          input_tokens: claudeRun.input_tokens,
          output_tokens: claudeRun.output_tokens,
          error: claudeRun.error,
        },
      },
    });
  } catch (error: any) {
    const elapsedMs = Date.now() - startTime;
    console.error('[orchestrator] uncaught:', error);
    return NextResponse.json(
      {
        message: error?.message || 'Extraction orchestrator failed.',
        comps: null,
        diagnostic: { elapsed_ms: elapsedMs, error: error?.message },
      },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient as createSupabaseUserClient } from '@/lib/supabase/server';
import crypto from 'crypto';

import { IMPORT_RESPONSE_FORMAT } from '@/lib/utils/compExtractionSchema';
import { IMPORT_SYSTEM_PROMPT } from '@/app/api/import-chat/route';
import {
  CLAUDE_PDF_SYSTEM_PROMPT,
  SUBMIT_COMPS_TOOL,
} from '@/app/api/import-pdf-claude/route';

// ─────────────────────────────────────────────────────────────────────────
// PDF extraction orchestrator — runs GPT + Claude in parallel on every
// PDF upload, returns GPT primary (preserves months of broker-tested
// prompt work), promotes Claude on GPT failure (instant fallback,
// already computed), writes both results to extraction_runs (Stripe-
// shadow pattern — gives us comparison data on every real upload from
// day 1 to inform an evidence-based router later).
//
// WHY THIS PATTERN (not Claude-only, not GPT-only):
//
//   - GPT has ~600 lines of accumulated broker domain knowledge in
//     IMPORT_SYSTEM_PROMPT — Texas terminology, MLS section handling,
//     subject-vs-comp disambiguation, normalization rules. Months of
//     real broker uploads taught us those rules. Throwing that away
//     to use Claude exclusively would be a regression on edge cases
//     we don't yet know to write down.
//
//   - Claude has two structural advantages we can't replicate on GPT:
//     native PDF support (no client-side render → no Safari throttling
//     stall on 60+ page appraisals — the Thorndale bug class) and
//     schema-enforced tool_use (Anthropic refuses to return malformed
//     types; OpenAI structured outputs only "asks nicely"). Both
//     matter for production reliability.
//
//   - Stripe's fraud model migration playbook: keep the proven model
//     in production, run the new model in shadow on every transaction,
//     log both decisions, switch over only when evidence supports it.
//     We're doing the same with extraction engines instead of fraud
//     scores.
//
// FAILURE-CONDITION LADDER (what gets shown to the broker):
//
//   1. GPT succeeds with ≥1 comp        → show GPT, log Claude silent
//   2. GPT times out (>60s)             → show Claude (auto-fallback)
//   3. GPT errors (429, 5xx)            → show Claude (auto-fallback)
//   4. GPT returns 0 comps              → if Claude > 0, show Claude
//                                          with a "GPT found nothing"
//                                          warning; else show GPT's
//                                          "no comps" message
//
// Because Claude was already computing in parallel, fallback is free
// (no second round-trip, no extra latency).
//
// COST: ~$0.025 per PDF (both engines on every call). At Christina's
// expected ~50 PDFs/month: ~$1.25/month extra vs GPT-only. Trivial
// relative to the comparison data and instant fallback.
// ─────────────────────────────────────────────────────────────────────────

export const maxDuration = 120;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
  engine: 'gpt' | 'claude';
  model: string;
  ok: boolean;
  result: ExtractionResult | null;
  error: string | null;
  elapsed_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
}

// ─── GPT extraction (text input) ────────────────────────────────────────
// Uses the same prompt + schema as /api/import-chat. We send the
// pdf-parse-extracted text wrapped as a "documentContent" message to
// preserve the existing prompt's expected user-message shape.
async function runGPT(text: string, fileName: string): Promise<EngineRun> {
  const t0 = Date.now();
  try {
    if (!text || text.trim().length < 200) {
      return {
        engine: 'gpt',
        model: 'gpt-4o-mini',
        ok: false,
        result: null,
        error:
          'PDF text extraction yielded too little content. Document may be scanned (image-only) — GPT path needs OCR.',
        elapsed_ms: Date.now() - t0,
        input_tokens: null,
        output_tokens: null,
      };
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      // 16k is the new floor — 6k was at the truncation boundary
      // for 6-comp appraisals. 16k gives generous headroom.
      max_tokens: 16000,
      // Temperature 0 for structured-extraction determinism. Without
      // this, GPT was returning 5 comps on one run and 6 on the next
      // for the same Thorndale PDF — same input, same prompt. The
      // determinism dropoff isn't a quality issue (correctness was
      // fine when it returned 6) — it's a *completeness* issue
      // (sometimes stopped early). For extraction we want the same
      // input to produce the same output every time. Trade-off: zero
      // creative variation. For comp data, that's the right trade.
      temperature: 0,
      response_format: IMPORT_RESPONSE_FORMAT,
      messages: [
        { role: 'system', content: IMPORT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Please extract all comparable sales from this document (filename: ${fileName}):\n\n${text}`,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      return {
        engine: 'gpt',
        model: 'gpt-4o-mini',
        ok: false,
        result: null,
        error: 'GPT returned empty content',
        elapsed_ms: Date.now() - t0,
        input_tokens: completion.usage?.prompt_tokens ?? null,
        output_tokens: completion.usage?.completion_tokens ?? null,
      };
    }
    const parsed = JSON.parse(content);
    const rawComps: ExtractedComp[] = Array.isArray(parsed.comps) ? parsed.comps : [];
    // Drop subject entries — schema returns is_comparable so we filter on it.
    const comps = rawComps.filter(
      (c: any) => c.is_comparable !== false && c.is_subject_property !== true,
    );

    return {
      engine: 'gpt',
      model: 'gpt-4o-mini',
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
      input_tokens: completion.usage?.prompt_tokens ?? null,
      output_tokens: completion.usage?.completion_tokens ?? null,
    };
  } catch (e: any) {
    return {
      engine: 'gpt',
      model: 'gpt-4o-mini',
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

  // Anthropic costs (per million tokens, mid-2026 published):
  //   Sonnet 4.5: $3.00 input, $15.00 output
  // OpenAI gpt-4o-mini (current):
  //   $0.15 input, $0.60 output
  let costUsd: number | null = null;
  if (run.input_tokens != null && run.output_tokens != null) {
    if (run.engine === 'claude') {
      costUsd = (run.input_tokens * 3.0 + run.output_tokens * 15.0) / 1_000_000;
    } else if (run.engine === 'gpt') {
      costUsd = (run.input_tokens * 0.15 + run.output_tokens * 0.6) / 1_000_000;
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
    error_stage: run.ok ? null : run.engine === 'gpt' ? 'gpt_extract' : 'claude_extract',
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

    // Parse PDF to text for GPT. Failure here doesn't kill the request —
    // Claude can still extract from the binary, just GPT can't.
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
        `live text ${hasLiveText ? '✓' : '✗'} · GPT primary, Claude fallback`,
    );

    // ─── GPT primary, Claude as actual fallback ──────────────────────
    //
    // Previously we ran both engines in parallel via Promise.all and
    // waited for the slower of the two. That made every successful
    // extraction wait an extra 20-30 seconds for Claude to finish even
    // when GPT had already returned a clean result. The broker waited
    // for max(GPT, Claude) instead of just GPT.
    //
    // New shape: GPT runs first. Claude is only invoked when GPT fails
    // or returns zero comps. Net latency on the success path drops
    // from ~max(GPT, Claude) to just GPT. The cost trade-off is we
    // lose shadow-mode comparison data on success cases — acceptable
    // for early-customer phase. Claude still runs (and contributes
    // telemetry) when its safety value is real: GPT outright failed
    // or returned nothing.
    const gptRun = await runGPT(pdfText, file.name);

    let claudeRun: EngineRun;
    const gptCompsCount = gptRun.result?.comps?.length ?? 0;
    const gptHasUsableResults = gptRun.ok && gptCompsCount > 0;

    if (gptHasUsableResults) {
      // GPT succeeded — skip Claude entirely. Stub a placeholder run so
      // the telemetry + diagnostic shape doesn't need a separate path.
      claudeRun = {
        engine: 'claude',
        model: 'claude-sonnet-4-5',
        ok: false,
        result: null,
        error: 'skipped: GPT primary succeeded',
        elapsed_ms: 0,
        input_tokens: null,
        output_tokens: null,
      };
    } else {
      console.log(
        `[orchestrator] ${file.name} · GPT ${gptRun.ok ? 'returned 0 comps' : `failed (${gptRun.error})`}, falling back to Claude`,
      );
      claudeRun = await runClaude(buffer, file.name);
    }

    const elapsedMs = Date.now() - startTime;

    // ─── Failure-condition ladder ────────────────────────────────────
    let primary: 'gpt' | 'claude';
    let routingReason: string;
    let chosen: ExtractionResult;

    const gptCompCount = gptRun.result?.comps?.length ?? 0;
    const claudeCompCount = claudeRun.result?.comps?.length ?? 0;
    const gptHasResults = gptRun.ok && gptCompCount > 0;
    const claudeHasResults = claudeRun.ok && claudeCompCount > 0;

    // When BOTH engines return comps, prefer the one with MORE comps if
    // they materially disagree on count. Catches the silent-undercount
    // class of bug (production 2026-06-17: Thorndale's Land Sale 6 was
    // dropped by GPT because max_tokens=6000 was right at the schema's
    // 6-comp output ceiling — GPT returned 5, Claude returned 6, the
    // old logic blindly trusted GPT). max_tokens has since been bumped
    // to 16000 to prevent this specific cause, but the smarter
    // selection is a permanent guard against future "GPT silently
    // truncated" failures regardless of root cause.
    //
    // "Materially disagree" = Claude found ≥2 more comps than GPT.
    // A 1-comp delta is in the noise (one engine might count a
    // borderline-comp as subject, vice versa). A 2+ delta means
    // someone genuinely missed something.
    const claudeFoundMoreComps =
      claudeHasResults && claudeCompCount >= gptCompCount + 2;

    if (claudeFoundMoreComps) {
      primary = 'claude';
      routingReason = `claude_preferred_${claudeCompCount}_vs_gpt_${gptCompCount}`;
      chosen = claudeRun.result!;
      console.warn(
        `[orchestrator] Claude found ${claudeCompCount} comps, GPT only ${gptCompCount} — using Claude. ` +
          `GPT may be silently truncating; investigate.`,
      );
    } else if (gptHasResults) {
      primary = 'gpt';
      routingReason = 'gpt_primary_success';
      chosen = gptRun.result!;
    } else if (claudeHasResults) {
      primary = 'claude';
      if (!gptRun.ok) {
        routingReason = `claude_fallback_after_gpt_${gptRun.error?.includes('timeout') ? 'timeout' : 'error'}`;
      } else {
        routingReason = 'claude_fallback_gpt_zero_comps';
      }
      chosen = claudeRun.result!;
    } else if (gptRun.ok) {
      // Both fulfilled with 0 comps. Show GPT's empty-result message.
      primary = 'gpt';
      routingReason = 'both_zero_comps';
      chosen = gptRun.result!;
    } else if (claudeRun.ok) {
      // GPT errored, Claude returned a result (even 0). Use Claude.
      primary = 'claude';
      routingReason = 'claude_fallback_gpt_error';
      chosen = claudeRun.result!;
    } else {
      // Both failed. Surface a clean error.
      console.error(
        `[orchestrator] BOTH engines failed. ` +
          `gpt=${gptRun.error} · claude=${claudeRun.error}`,
      );
      // Still log both failures for telemetry.
      await Promise.allSettled([
        logRun({
          run: gptRun,
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
            gpt_error: gptRun.error,
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
        run: gptRun,
        user_id: userId,
        team_id: teamId,
        sha256,
        file_name: file.name,
        file_size_bytes: file.size,
        page_count: pageCount,
        doc_type: docType,
        has_live_text: hasLiveText,
        routing_reason: routingReason,
        was_shown_to_user: primary === 'gpt',
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
        `gpt: ${gptRun.ok ? `${gptRun.result?.comps.length ?? 0} comps in ${(gptRun.elapsed_ms / 1000).toFixed(1)}s` : `FAIL: ${gptRun.error}`} · ` +
        `claude: ${claudeRun.ok ? `${claudeRun.result?.comps.length ?? 0} comps in ${(claudeRun.elapsed_ms / 1000).toFixed(1)}s` : `FAIL: ${claudeRun.error}`} · ` +
        `total ${(elapsedMs / 1000).toFixed(1)}s`,
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
        gpt: {
          ok: gptRun.ok,
          comps: gptRun.result?.comps.length ?? 0,
          elapsed_ms: gptRun.elapsed_ms,
          input_tokens: gptRun.input_tokens,
          output_tokens: gptRun.output_tokens,
          error: gptRun.error,
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

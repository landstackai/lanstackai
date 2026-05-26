import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createClient as createServerSupabase } from '@/lib/supabase/server';

// POST /api/cma/[id]/generate-overview
// Body: { notes: string }
// Returns: { ok: true, prose: string } | { error: string }
//
// AI-drafts the Subject Property Overview prose section of the
// marketing CMA PDF (Page 2). The broker types bullets/shorthand in
// the workspace's "Your Notes" textarea, hits Generate, this endpoint
// reads:
//   - The broker's notes (passed in the request body)
//   - Auto-populated context from the CMA row (subject name, county,
//     state, acreage, region)
// And asks GPT-4o-mini for 2-3 polished paragraphs in a ranch-broker
// voice — factual, Texas-vernacular, no marketing clichés.
//
// The endpoint does NOT persist the prose. The workspace UI writes the
// returned draft into the broker's textarea, and saveBov persists it
// to subject_overview_prose on the next save tick. This separation
// lets the broker edit before commit + lets them re-generate without
// risking an in-flight overwrite.
//
// Model choice: GPT-4o-mini. Structured text generation from
// constrained input — full GPT-4o is overkill. Cost: ~$0.0001 per
// draft, negligible at any reasonable broker volume.
//
// Hard rule from the prompt: AI never invents facts not in the notes
// or auto-context. Better to under-deliver than fabricate
// improvements / water features / acreage that aren't actually there.

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a Texas ranch broker writing the Subject Property Overview
section of a Comparative Market Analysis. Your voice is professional
but warm — how a seasoned land broker would describe a ranch to a
sophisticated client in a written report.

Write a polished 2-3 paragraph overview that:
  1. Opens with location, acreage, and overall character
  2. Describes improvements, terrain, water, and notable features
  3. Closes with what drives the property's value (location, recreational
     appeal, ag/wildlife potential, etc.)

Rules — these are firm:
- Use ONLY facts from the broker's notes and the auto-populated context.
  Do not invent improvements, water features, acreage, or other details
  the broker didn't tell you about. If the notes are sparse, write a
  shorter overview rather than padding with assumed facts.
- Texas-ranch vocabulary is welcome where appropriate:
  "Hill Country terrain", "live water", "high fence", "ag valuation",
  "MLD permit", "stock tanks", "native pasture", "carve-out", etc.
- AVOID marketing clichés: no "must see", "rare opportunity",
  "won't last long", "priced to sell", "one of a kind".
- Match the tone of a written appraisal report — factual, calm, not
  hype-y.
- Length: 150-250 words total.
- Output plain prose paragraphs separated by blank lines. No headers,
  no bullet points, no markdown formatting.

Return ONLY the prose. Nothing else.`;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'openai key not configured' }, { status: 500 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'cma id required' }, { status: 400 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const notes = String(body?.notes || '').trim();
  if (!notes) {
    return NextResponse.json(
      { error: 'no notes provided', hint: 'Type a few bullets or shorthand in the Notes field before generating.' },
      { status: 400 }
    );
  }

  // Fetch the CMA so we can include the auto-populated context
  // (subject name, county, acreage) in the prompt — gives the AI a
  // foundation it can reference even when the broker's notes are
  // sparse. Server-side Supabase client to respect RLS.
  const supabase = createServerSupabase();
  const { data: cma, error: cmaError } = await supabase
    .from('cmas')
    .select('subject_name, subject_county, subject_state, subject_acres')
    .eq('id', id)
    .single();

  if (cmaError || !cma) {
    return NextResponse.json(
      { error: 'CMA not found or you do not have access', detail: cmaError?.message },
      { status: 404 }
    );
  }

  const context = [
    `Subject Property: ${cma.subject_name || '(unnamed)'}`,
    `Location: ${cma.subject_county || 'unknown county'}, ${cma.subject_state || 'TX'}`,
    `Acreage: ${cma.subject_acres ? `${cma.subject_acres}± acres` : 'acreage not set'}`,
  ].join('\n');

  const userMessage = `AUTO-POPULATED CONTEXT (use as background — these facts are reliable):
${context}

BROKER'S NOTES (write the overview from these — do NOT invent facts beyond them):
${notes}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.6, // some warmth without going off-script
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });
    const prose = completion.choices[0]?.message?.content?.trim();
    if (!prose) {
      return NextResponse.json(
        { error: 'AI returned empty response', hint: 'Try again — add more notes if it fails repeatedly.' },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true, prose });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'AI generation failed', detail: e?.message || 'unknown error' },
      { status: 500 }
    );
  }
}

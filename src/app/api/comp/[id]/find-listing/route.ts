import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Web search + verification can take a while; match the import routes.
export const maxDuration = 120;

// Find a listing URL on the broker's own site / Land.com network /
// Zillow for a saved comp using Claude with the server-side web search
// tool. Two modes:
//
//   manual (default — the panel's "Find listing online" button):
//     returns {url, confidence, reason}; persists nothing. The broker
//     decides what to do with it, exactly as before.
//
//   auto (body {mode:'auto'} — fired in the background after import,
//     and by the backfill script): persists by confidence tier.
//       high   → source_url (+ listing_match_confidence='high_auto')
//       medium → suggested_listing_url ('medium_suggested') — surfaced
//                in the comp panel for an agent to confirm/dismiss,
//                never silently the source of record.
//       none   → nothing written.
//     Skips entirely when the comp already has a source_url.
//
// Engine history: previously OpenAI's gpt-4o-search-preview, which
// OpenAI retired (404 model_not_found) — switched to Anthropic, which
// also powers the PDF extraction pipeline.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let mode: 'manual' | 'auto' = 'manual';
  try {
    const body = await req.json();
    if (body?.mode === 'auto') mode = 'auto';
  } catch {
    // no body — manual
  }

  const { data: comp, error } = await supabase
    .from('comps')
    .select('id,property_name,address,county,state,acres,sale_price,sale_date,latitude,longitude,created_by,source_url,description,grantor,grantee')
    .eq('id', params.id)
    .single();
  if (error || !comp) {
    return NextResponse.json({ error: 'comp not found', detail: error?.message }, { status: 404 });
  }
  if (comp.created_by !== user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (mode === 'auto' && comp.source_url) {
    return NextResponse.json({ url: comp.source_url, confidence: 'existing', reason: 'already has a listing URL' });
  }

  // Core identifying facts on one line
  const facts = [
    comp.property_name,
    comp.address,
    comp.county ? `${comp.county} County` : null,
    comp.state || 'TX',
    comp.acres ? `${Number(comp.acres).toLocaleString()} acres` : null,
    comp.sale_price ? `sold for approximately $${Number(comp.sale_price).toLocaleString()}` : null,
    comp.sale_date ? `around ${comp.sale_date}` : null,
  ].filter(Boolean).join(', ');

  if (!facts.includes(',')) {
    return NextResponse.json({ error: 'comp has no usable identifying info' }, { status: 400 });
  }

  // Cross-reference: appraiser descriptions often contain road names, creek
  // names, neighbor references, and legal subdivision identifiers that help
  // confirm a listing is the same property. Cap length to keep token cost
  // sane.
  const fullDescription = (comp.description || '').slice(0, 1200);
  const partyLine = [
    comp.grantor ? `Sold by: ${comp.grantor}` : null,
    comp.grantee ? `Bought by: ${comp.grantee}` : null,
  ].filter(Boolean).join(' · ');

  // realtor.com blocks Anthropic's crawler — the API rejects it in
  // allowed_domains, so it's excluded from the search entirely.
  const prompt = `Find a real estate listing on one of these sites that matches this Texas land property:
- westandswoperanches.com  (the broker's own site — check here FIRST; many
                            comps are West and Swope's own past deals)
- landsofamerica.com   (preferred for ranches / large land tracts)
- landwatch.com        (preferred for ranches / large land tracts)
- land.com             (preferred for ranches / large land tracts)
- zillow.com           (general)

CORE FACTS:
${facts}
${partyLine ? `PARTIES:\n${partyLine}\n` : ''}
${fullDescription ? `DESCRIPTION (use this to cross-reference road names, creek names, subdivision, abstract numbers, neighbors, and other identifiers):\n${fullDescription}\n` : ''}
CROSS-REFERENCE CHECKLIST — a listing is the same property only if it
matches the description on AT LEAST 3 of these specific identifiers (not
just acres + county which are too generic):

  □ Same road / address / private route number
  □ Same county AND city / nearest town
  □ Same water feature by name (e.g., "Nueces River", "Bullhead Creek",
    "West Frio River") — generic "creek" doesn't count
  □ Same approximate acreage (within ±5%)
  □ Same number of water wells (if either source mentions wells)
  □ Same major improvements by type and approximate size (e.g., "main
    lodge ~3,200 SF", "horse barn", "guest cabin", "barndominium")
  □ Same legal subdivision / abstract / survey name (e.g., "H Criswell
    SUR ABS 136") if mentioned
  □ Same elevation / topography signature (e.g., "440 feet of elevation
    change", "rolling hills with bluffs along the river")
  □ Same fencing / wildlife notes (e.g., "high-fenced pasture with axis
    and elk", "low-fenced perimeter")

A listing that aligns on water-feature-name + improvements + acreage is a
HIGH confidence match even if the price or date is fuzzy. A listing that
shares only acres + county is NOT a match — too many properties qualify.

EXCEPTION — westandswoperanches.com ONLY: on the broker's own site, a
matching property name + same county + acreage within ±5% is sufficient
(comps are often the brokerage's own past deals with sparse records, and
name collisions within one county at the same acreage don't happen on a
single brokerage's site). This relaxation applies to NO other site.

ROAD NAME EQUIVALENCES (treat as identical):
- "PR" / "Prvt Rd" / "Private Rd" / "Private Road"  →  same road
- "FM" / "Farm-to-Market" / "Farm to Market"        →  same road
- "CR" / "County Rd" / "County Road"                →  same road
- "RR" / "Ranch Rd" / "Ranch Road"                  →  same road
So "4670 PR 5500" matches "4670 Prvt Rd 5500" matches "4670 Private Road 5500".

CONFIDENCE TIERS:
  "high"   — meets the full bar: at least 3 specific identifiers match
             (or the westandswoperanches.com exception above), acreage
             within ±5%, you are 95%+ sure it is the same property.
  "medium" — strong but short of certain: exactly 2 specific
             identifiers match AND acreage is within ±15%, on a
             property detail page. A human will confirm or dismiss it.

REJECT (url: null) IF:
- Fewer than 2 specific identifiers match
- Acreage differs by more than ±15%
- The URL is a search-results page, browse page, agent page, or generic
  region landing page (must be a property detail page)

A missing link is far better than a wrong one. Brokers and their clients
will rely on this output — be conservative on edge cases, and NEVER
report "high" when the honest tier is "medium".

OUTPUT — STRICT FORMAT REQUIREMENT:
End your reply with EXACTLY one line of valid JSON. No markdown fences.
The "url" field MUST contain the literal URL string (https://...) or be
null. Do NOT phrase it as "available on Zillow" — paste the URL itself.

Schema:
{"url": "https://...", "confidence": "high", "reason": "short sentence"}
or
{"url": "https://...", "confidence": "medium", "reason": "short sentence"}
or
{"url": null, "confidence": null, "reason": "short sentence explaining why no confident match"}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      // Accuracy over cost: the broker and their clients rely on this link.
      output_config: { effort: 'high' },
      tools: [
        {
          type: 'web_search_20260209',
          name: 'web_search',
          max_uses: 6,
          allowed_domains: [
            'westandswoperanches.com',
            'landsofamerica.com',
            'landwatch.com',
            'land.com',
            'zillow.com',
          ],
        },
      ],
      messages: [{ role: 'user', content: prompt }],
    } as any);

    // Final answer = concatenated text blocks (search-result blocks are
    // interleaved in content; we only need Claude's conclusion).
    const text = (response.content as any[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    // Parse the model's structured response
    let url: string | null = null;
    let reason: string | null = null;
    let confidence: 'high' | 'medium' | null = null;
    try {
      // Last JSON object in the text is the verdict line.
      const jsonMatches = text.match(/\{[^{}]*\}/g);
      const jsonMatch = jsonMatches ? jsonMatches[jsonMatches.length - 1] : null;
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch);
        if (typeof parsed.url === 'string') {
          const m = parsed.url.match(/https?:\/\/(?:[a-z0-9-]+\.)*(zillow|realtor|land|landsofamerica|landwatch|westandswoperanches)\.com\/[^\s)\]]+/i);
          url = m?.[0]?.replace(/[.,;!?]+$/, '') ?? null;
        }
        if (typeof parsed.reason === 'string') reason = parsed.reason.slice(0, 200);
        if (parsed.confidence === 'high' || parsed.confidence === 'medium') {
          confidence = parsed.confidence;
        }
      }
    } catch {
      // Fall back to URL extraction from raw text
      const m = text.match(/https?:\/\/(?:[a-z0-9-]+\.)*(zillow|realtor|land|landsofamerica|landwatch|westandswoperanches)\.com\/[^\s)\]]+/i);
      url = m?.[0]?.replace(/[.,;!?]+$/, '') ?? null;
    }

    if (!url) {
      return NextResponse.json({
        url: null,
        confidence: null,
        reason: reason || 'No matching listing found',
      });
    }
    // A URL with no parseable tier is treated as medium — never let a
    // formatting slip auto-write the source of record.
    if (!confidence) confidence = 'medium';

    if (mode === 'auto') {
      if (confidence === 'high') {
        // Broker rule (2026-10-06): attached links also go into the
        // description as a trailing "Listing: <url>" line so the link
        // travels with the prose everywhere descriptions render.
        const desc = comp.description || '';
        const descWithLink =
          desc.includes(url) || /Listing: https?:\/\//.test(desc)
            ? desc
            : desc.trim()
              ? `${desc}\n\nListing: ${url}`
              : `Listing: ${url}`;
        const { error: upErr } = await supabase
          .from('comps')
          .update({
            source_url: url,
            listing_match_confidence: 'high_auto',
            listing_match_reason: reason,
            suggested_listing_url: null,
            description: descWithLink,
          })
          .eq('id', comp.id);
        if (upErr) console.error('[find-listing auto] high save failed:', upErr.message);
      } else {
        const { error: upErr } = await supabase
          .from('comps')
          .update({
            suggested_listing_url: url,
            listing_match_confidence: 'medium_suggested',
            listing_match_reason: reason,
          })
          .eq('id', comp.id);
        if (upErr) console.error('[find-listing auto] suggestion save failed:', upErr.message);
      }
    }

    // Manual mode stays live-only — we surface the URL but do NOT
    // persist; the broker decides what to do with it (open, copy,
    // save, ignore).
    return NextResponse.json({ url, confidence, reason });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Search failed' }, { status: 500 });
  }
}

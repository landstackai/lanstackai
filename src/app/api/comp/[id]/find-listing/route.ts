import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const maxDuration = 30;

// Auto-find a listing URL on Zillow / Realtor.com / Land.com for a saved comp
// using OpenAI's web-search-enabled model. Saves to comps.source_url.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

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

  const prompt = `Find a real estate listing on one of these sites that matches this Texas land property:
- landsofamerica.com   (preferred for ranches / large land tracts)
- landwatch.com        (preferred for ranches / large land tracts)
- land.com             (preferred for ranches / large land tracts)
- realtor.com          (general)
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

ROAD NAME EQUIVALENCES (treat as identical):
- "PR" / "Prvt Rd" / "Private Rd" / "Private Road"  →  same road
- "FM" / "Farm-to-Market" / "Farm to Market"        →  same road
- "CR" / "County Rd" / "County Road"                →  same road
- "RR" / "Ranch Rd" / "Ranch Road"                  →  same road
So "4670 PR 5500" matches "4670 Prvt Rd 5500" matches "4670 Private Road 5500".

REJECT IF:
- Fewer than 3 specific identifiers match
- Acreage differs by more than ±15%
- The URL is a search-results page, browse page, agent page, or generic
  region landing page (must be a property detail page)
- You are less than 95% confident

A missing link is far better than a wrong one. Brokers and their clients
will rely on this output — be conservative on edge cases.

OUTPUT — STRICT FORMAT REQUIREMENT:
Reply with EXACTLY one line of valid JSON. No prose before or after. No
markdown. No citation footnotes. The "url" field MUST contain the literal
URL string (https://...) or be null. Do NOT phrase it as "available on
Zillow" — paste the URL itself.

Schema:
{"url": "https://...", "reason": "short sentence"}
or
{"url": null, "reason": "short sentence explaining why no confident match"}`;

  try {
    // Full search-preview model for higher verification accuracy. Cost is
    // ~3x mini but the user has explicit trust/accuracy requirements: a
    // wrong link is much worse than a missing link.
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-search-preview',
      web_search_options: {},
      messages: [{ role: 'user', content: prompt }],
    } as any);

    const text = (completion.choices[0]?.message?.content || '').trim();
    // Parse the model's structured response
    let url: string | null = null;
    let reason: string | null = null;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.url === 'string') {
          const m = parsed.url.match(/https?:\/\/(?:[a-z0-9-]+\.)*(zillow|realtor|land|landsofamerica|landwatch)\.com\/[^\s)\]]+/i);
          url = m?.[0]?.replace(/[.,;!?]+$/, '') ?? null;
        }
        if (typeof parsed.reason === 'string') reason = parsed.reason.slice(0, 200);
      }
    } catch {
      // Fall back to URL extraction from raw text
      const m = text.match(/https?:\/\/(?:[a-z0-9-]+\.)*(zillow|realtor|land|landsofamerica|landwatch)\.com\/[^\s)\]]+/i);
      url = m?.[0]?.replace(/[.,;!?]+$/, '') ?? null;
    }

    if (!url) {
      return NextResponse.json({
        url: null,
        reason: reason || 'No matching listing found',
      });
    }

    // Live-only — we surface the URL but do NOT persist it to the comp
    // record. The broker decides what to do with it (open, copy, ignore).
    return NextResponse.json({ url, reason });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Search failed' }, { status: 500 });
  }
}

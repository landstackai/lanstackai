import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import * as cheerio from 'cheerio';

/**
 * POST /api/import-url
 * Body: { url: string }
 *
 * Extract comp data from a listing URL (Land.com, LandsOfTexas, broker
 * websites, etc.). Two-pass extraction:
 *
 *   1. Structured HTML parsing pulls metadata from OpenGraph tags,
 *      schema.org JSON-LD, Twitter cards, and the page <title>. This
 *      captures property name, description, image, and sometimes a
 *      structured price/acres pair on sites that publish good metadata.
 *
 *   2. AI cleanup pass takes the structured signals + raw page text and
 *      normalizes them into the ExtractedComp shape the import flow
 *      expects. The AI also fills in fields the structured parse missed
 *      (acres often need to be parsed out of a description string,
 *      county from address text, etc.).
 *
 * Returns a PARTIAL comp — listings don't have grantor/grantee, recording
 * info, or actual sold price (asking price only). Broker completes the
 * missing fields in the verification card before saving.
 *
 * Hard rule: this endpoint NEVER opens a headless browser. Plain HTTP
 * fetch + HTML parsing only. Pages that require JavaScript to render
 * their content (Zillow, Redfin) won't extract well via this path —
 * by design. Those sites also actively block scraping and have ToS
 * restrictions. V1 targets static-render sites (the bulk of land
 * listings actually fall in this bucket).
 */

export const maxDuration = 30;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Realistic User-Agent so listing sites don't return a 403/bot page.
// Most sites differentiate between obvious bots (curl, requests) and
// real browsers. Matching a current Safari UA passes for most.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export async function POST(req: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'openai key not configured' }, { status: 500 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const url = String(body?.url || '').trim();
  if (!url) {
    return NextResponse.json({ error: 'url required' }, { status: 400 });
  }

  // Validate URL — must be http(s), must not be an internal/private address.
  // Defense against SSRF: even an authenticated broker shouldn't be able to
  // make the server fetch internal infrastructure URLs.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 });
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return NextResponse.json({ error: 'http(s) urls only' }, { status: 400 });
  }
  if (isPrivateHostname(parsedUrl.hostname)) {
    return NextResponse.json({ error: 'private/internal urls not allowed' }, { status: 400 });
  }

  // ── Step 1: HTML source resolution ───────────────────────────────────
  //
  // Two intake modes:
  //   1. Server-fetch (default) — broker pasted a URL, we fetch it
  //      server-side. Works for static-rendered sites (LERA, county
  //      records, brokerage sites). Fails on JS-rendered SPAs and
  //      anti-bot sites (returns empty body or 403).
  //   2. Pre-fetched (bookmarklet) — the browser bookmarklet already
  //      ran inside the broker's authenticated tab and pulled the
  //      RENDERED DOM directly. The script POSTs the page_text +
  //      structured signals here in `body.bookmarklet_payload`. We
  //      SKIP the server fetch and go straight to AI normalization.
  //
  // Mode 2 is the only way to handle Lands of America / Land.com /
  // LandWatch / Zillow because their content is JS-rendered. The
  // broker's browser already has the page loaded; we just consume
  // what they're already seeing.
  let html: string = '';
  let structured: Record<string, any> = {};
  const bookmarkletPayload = body?.bookmarklet_payload;

  if (bookmarkletPayload && typeof bookmarkletPayload === 'object') {
    // Pre-fetched path: rely on what the bookmarklet captured.
    // page_text is the cleaned innerText; _next_data / _json_ld /
    // _opengraph hold structured signals; probe_* are quick-look
    // values from common CSS selectors. Pass all of it to the AI
    // as the "structured" hint, plus page_text as the body.
    structured = {
      source_domain: parsedUrl.hostname,
      page_title: bookmarkletPayload.page_title,
      meta_description: bookmarkletPayload.meta_description,
      og: bookmarkletPayload._opengraph,
      json_ld: bookmarkletPayload._json_ld,
      next_data: bookmarkletPayload._next_data,
      probe_price: bookmarkletPayload.probe_price,
      probe_address: bookmarkletPayload.probe_address,
      probe_acres: bookmarkletPayload.probe_acres,
      bookmarklet_source: bookmarkletPayload._source || 'unknown',
    };
    // For mode 2 we don't have raw HTML — feed page_text directly
    // to the AI step (cleanedText below would just re-derive this).
    html = '';
  } else {
    // Server-fetch path
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });
      if (!res.ok) {
        return NextResponse.json(
          {
            error: `listing site returned ${res.status}`,
            hint: res.status === 403 || res.status === 429
              ? 'this site is blocking automated fetches — install the Landstack bookmarklet (Settings → Bookmarklet) to import while logged in.'
              : 'try a different URL, install the bookmarklet, or paste the listing text manually',
          },
          { status: 502 }
        );
      }
      html = await res.text();
    } catch (e: any) {
      return NextResponse.json(
        { error: 'fetch failed', detail: e?.message || 'unknown' },
        { status: 502 }
      );
    }
    structured = extractStructuredData(html, parsedUrl);
  }

  // ── Step 2: AI cleanup + normalization ───────────────────────────────
  // Send the structured signals + a clean text dump to the AI and ask
  // for a normalized ExtractedComp. AI fills in fields the structured
  // parse missed and standardizes formatting (acres as number, price
  // as integer, county string normalized, etc.).
  //
  // page_text comes from the bookmarklet (browser-side innerText after
  // JS render) when in mode 2; from cleanPageText(html) when in mode 1.
  // The bookmarklet payload is the better signal for JS-heavy sites
  // because it captures what the broker actually saw in their browser.
  const cleanedText: string = bookmarkletPayload && typeof bookmarkletPayload.page_text === 'string'
    ? String(bookmarkletPayload.page_text)
    : cleanPageText(html);

  let comp: any = null;
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-2024-08-06',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: LISTING_EXTRACTION_PROMPT,
        },
        {
          role: 'user',
          content:
            `URL: ${url}\n\n` +
            `STRUCTURED METADATA:\n${JSON.stringify(structured, null, 2)}\n\n` +
            `PAGE TEXT (first 8000 chars):\n${cleanedText.slice(0, 8000)}`,
        },
      ],
    });
    const raw = completion.choices?.[0]?.message?.content || '{}';
    comp = JSON.parse(raw);
  } catch (e: any) {
    return NextResponse.json(
      { error: 'AI extraction failed', detail: e?.message || 'unknown' },
      { status: 500 }
    );
  }

  // Attach provenance + sane defaults
  comp.source_url = url;
  comp.source_type = 'listing_url';
  // Confidence override: listings are marketing copy, not legal records.
  // Cap overall confidence at 65 so the comp doesn't enter the vault as
  // 'Verified' — broker has to complete missing fields and explicitly
  // verify via the thumbnail card.
  if (!comp.confidence || typeof comp.confidence !== 'object') {
    comp.confidence = { overall: 50, per_field: {} };
  } else {
    comp.confidence.overall = Math.min(Number(comp.confidence.overall) || 50, 65);
  }
  // Identify which expected fields the listing didn't provide so the
  // verification card can prompt the broker to complete them before save.
  const REQUIRED_FOR_COMP = ['sale_date', 'grantor', 'grantee'] as const;
  const missing = REQUIRED_FOR_COMP.filter((k) => !comp[k]);
  if (missing.length > 0) {
    comp.needs_completion = true;
    comp.missing_fields = missing;
  }

  return NextResponse.json({
    ok: true,
    comp,
    diagnostic: {
      structured_keys: Object.keys(structured),
      text_chars: cleanedText.length,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Pull metadata from OpenGraph tags, schema.org JSON-LD, Twitter
 * cards, and the page <title>. Returns a flat object the AI can use
 * as a starting point.
 */
function extractStructuredData(html: string, parsedUrl: URL): Record<string, any> {
  const $ = cheerio.load(html);
  const out: Record<string, any> = {
    source_domain: parsedUrl.hostname,
  };

  const title = $('title').first().text().trim();
  if (title) out.page_title = title;

  // OpenGraph meta tags
  $('meta[property^="og:"]').each((_: number, el: any) => {
    const prop = $(el).attr('property');
    const content = $(el).attr('content');
    if (prop && content) out[`og_${prop.slice(3).replace(/:/g, '_')}`] = content;
  });

  // Twitter card meta tags
  $('meta[name^="twitter:"]').each((_: number, el: any) => {
    const name = $(el).attr('name');
    const content = $(el).attr('content');
    if (name && content) out[`twitter_${name.slice(8).replace(/:/g, '_')}`] = content;
  });

  // Standard description / keywords
  const desc = $('meta[name="description"]').attr('content');
  if (desc) out.meta_description = desc;
  const keywords = $('meta[name="keywords"]').attr('content');
  if (keywords) out.meta_keywords = keywords;

  // Schema.org JSON-LD blocks (often have structured place / product /
  // RealEstateListing data with price, geo coordinates, etc.)
  const jsonLdBlocks: any[] = [];
  $('script[type="application/ld+json"]').each((_: number, el: any) => {
    const raw = $(el).text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      jsonLdBlocks.push(parsed);
    } catch {
      // Skip malformed JSON-LD
    }
  });
  if (jsonLdBlocks.length > 0) out.json_ld = jsonLdBlocks;

  return out;
}

/**
 * Strip out scripts, styles, navigation, headers, footers — leave just
 * the main content text. Cheerio's text() collapses whitespace; we
 * also normalize newlines for readability.
 */
function cleanPageText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, header, footer, svg, iframe').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

/**
 * Block private/internal hostnames to prevent SSRF. Covers loopback,
 * private IPv4 ranges, link-local, and metadata-service hostnames.
 */
function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '0.0.0.0' || lower.endsWith('.localhost')) return true;
  if (lower === 'metadata.google.internal') return true;
  // IPv4 private ranges
  const m = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

const LISTING_EXTRACTION_PROMPT = `You are a real estate data extractor. The user gave you a listing URL,
the structured metadata my server parsed from the page, and the raw page text.

Extract a comparable sale ("comp") from this listing in JSON form. Return ONLY a JSON
object matching this shape (no prose, no markdown):

{
  "property_name": string | null,        // best label for the listing
  "county": string | null,                // e.g. "Frio", just the county name without "County"
  "state": string | null,                 // 2-letter code, default "TX" if not specified
  "acres": number | null,                 // total acreage as a number
  "sale_price": number | null,            // listing asking price (broker will replace with actual sold price later)
  "improvements_value": number | null,    // if explicitly stated
  "price_land_only": number | null,
  "price_per_acre": number | null,        // computed if both above are present, else null
  "ppa_land_only": number | null,
  "sale_date": string | null,             // listings DO NOT have sold dates; leave NULL unless the listing explicitly says "SOLD on DATE"
  "address": string | null,
  "latitude": number | null,              // ONLY if explicitly in the listing (geo coords in schema.org / og tags)
  "longitude": number | null,             // ONLY if explicitly in the listing
  "description": string | null,           // listing's main description (the prose, not metadata)
  "grantor": string | null,               // listings rarely have this — leave NULL
  "grantee": string | null,               // listings rarely have this — leave NULL
  "recording_number": string | null,      // listings don't have this — leave NULL
  "water": "None" | "Seasonal" | "Strong" | null,         // "Strong" = year-round/live SURFACE water (creek, river, spring). "Seasonal" = stock tanks / intermittent. "None" = wells only / dry. NEVER mark Strong based on wells alone.
  "road_frontage": "None" | "Low" | "Medium" | "High" | null,  // "High" = paved highway / state hwy frontage. "Medium" = paved county road. "Low" = caliche / gravel access. "None" = no road frontage.
  "irrigation": "None" | "Medium" | "Strong" | null,      // "Strong" = active center pivot / drip; "Medium" = partial; "None" = dryland. NULL when not mentioned.
  "has_improvements": boolean,            // infer from description — true if house/barn/structures mentioned
  "improvements_notes": string | null,
  "minerals_sold": string | null,
  "financing": string | null,
  "confirmation_source": string | null,
  "wildlife_notes": string | null,
  "flood_plain_pct": number | null,
  "confidence": {
    "overall": number,                    // 0-100, base on how complete + reliable the listing data is
    "per_field": { [field: string]: number }
  },
  "document_type": "listing",
  "is_subject_property": false,
  "is_comparable": true
}

Rules:
- If a field is missing or uncertain, return null. Do NOT make up values.
- For sale_price: use the asking price from the listing. The broker will replace this with the actual sold price after they verify the listing represents a property they sold.
- For sale_date: most listings DO NOT have a sold date — leave it null. If the listing explicitly says "Sold on DATE" or "Closed DATE", extract that.
- For coordinates: ONLY extract latitude/longitude if explicitly in the structured metadata (og:latitude, schema.org GeoCoordinates, etc.). Do NOT try to geocode the address yourself.
- For confidence: base overall on how much of the structured shape you could fill in confidently. A listing with price, acres, county, lat/lng all explicit deserves ~75. A listing with just a vague description and asking price deserves ~40.
- Texas terminology is common: "live water" = stream/river through property, "ag exempt" = agricultural property tax exemption, "high fenced" = exotic game ranch.`;

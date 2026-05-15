import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { geocodeComps } from '@/lib/utils/geocode';
import { autoLocateFromMetadata } from '@/lib/utils/autoLocate';
import {
  getCountyParcels,
  getCountySource,
  findParcelAt,
  findContiguousSameOwner,
  mergeFeatures,
  selectBoundaryByAcreage,
} from '@/lib/utils/countyParcels';

export const maxDuration = 120; // vision + multi-page extraction can run up to 60–90s

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const IMPORT_SYSTEM_PROMPT = `You are Landstack AI — a land and ranch real estate data extraction specialist built for Texas land brokers.

Your job is to:
1. Read property documents, appraisals, closing statements, and descriptions
2. Extract comparable sales data with high accuracy  
3. Answer questions about the documents conversationally
4. Help brokers add comps to their vault

You understand deeply:
- Texas ranch and land terminology (live water, senderos, brush country, Hill Country, stock tanks, MLD, ag exemption)
- Appraisal report structure (subject property + comparable sales)
- ECV = Estimated Contributory Value of improvements
- Land-only adjusted price vs total sale price
- Surface rights vs mineral rights
- Recording numbers and county deed records
- Marshall & Swift cost approach methodology
- Texas submarket terminology (Hill Country, South Texas, West Texas, Panhandle, Gulf Coast, etc.)

DOCUMENT TYPES YOU WILL ENCOUNTER:

TYPE A — Single-property appraiser comp sheet (~70% of uploads):
  Title at top: "Farm Sale", "Ranch Sale", "Land Sale", "Sold Property", etc.
  Sections labeled: "Identification", "Transaction Information",
  "Property Information", "Legal Description", "Remarks".
  ONE property described, with: Property Type, Property Name, Location, County,
  Date of Sale, Grantor, Grantee, Recording Information, Sale Price, Sale Price
  Per Acre, Financing, Property Size, etc.
  → Extract as 1 comp. Set is_comparable=true, is_subject_property=false.
  → THE FACT THAT THERE'S ONLY ONE PROPERTY IS NOT A REASON TO RETURN EMPTY.

TYPE B — Multi-comp appraisal report:
  Has a subject property at the front + 3-5 "Comparable Sales" thereafter.
  → Extract all comparable sales. Set is_comparable=true for each.
  → Skip the subject property (its sale isn't being recorded).

TYPE C — Marketing flyer / active listing:
  Says "For Sale", "Asking Price", "Contact Broker". No Grantor / Grantee /
  Recording Number / Sale Date. The property hasn't sold yet.
  → Return comps: []. Set message to "This appears to be an active listing,
     not a sale record. No comp data extracted."

TYPE D — Closing statement / HUD-1 / settlement statement:
  Has buyer + seller, settlement charges, but minimal property detail.
  → Extract what you can (sale_price, sale_date, grantor, grantee, address).
     Set confidence appropriately low for missing fields.

When you find comparable sales in a document:
- Extract ALL comps, not just the subject property
- Type-A single-property docs ARE comps. Do NOT exclude them just because
  the doc has only one property. If you see Sale Price + Sale Date +
  Grantor/Grantee in a single-property doc, that's a Type A — extract it.
- Note the difference between total sale price and land-only adjusted price
- Flag when improvements value (ECV) is mentioned
- Extract GPS coordinates if present anywhere on the page (decimal degrees,
  degrees-minutes-seconds, or "lat/long" labels). Look in headers, footers,
  property cards, and map captions. Convert to decimal degrees.
- Extract recording numbers for verification
- Extract the FULL property description text for each tract verbatim — do not
  summarize. Land brokers rely on the appraiser's exact prose for terrain,
  improvements, water, brush composition, etc. If the description spans
  multiple paragraphs, concatenate them. Put this in the "description" field.
- For the "acres" field, prefer the acreage stated in the descriptive prose
  (e.g. "Sale of 265.210 ac located at..." or "455.92-acre ranch"). That is
  the actual sold tract size. Avoid pulling from totals tables, tax summaries,
  or "subject property" boxes that may show a parent parcel size or
  unrelated acreage. If the description does not contain an acreage,
  fall back to the most explicit value labeled as the sale acreage.
- Accuracy matters more than speed. If a value is illegible or missing, set
  it to null rather than guessing. Reflect uncertainty in confidence.per_field.

CRITICAL: You MUST always respond with a SINGLE valid JSON object.
The response must be parseable by JSON.parse — no prose outside the object, no
markdown fences. If extraction succeeded, return:
  {"message": "<short conversational summary for the user>", "comps": [...]}
If the user is just chatting (no document), return:
  {"message": "<your reply>", "comps": []}

Each comp should have these fields:
{
  "property_name": string or null,
  "county": string or null,
  "state": string (default "TX"),
  "acres": number or null,
  "sale_price": number or null,
  "price_land_only": number or null,
  "improvements_value": number or null,
  "price_per_acre": number or null,
  "ppa_land_only": number or null,
  "sale_date": "YYYY-MM-DD" or null,
  "address": string or null,
  "latitude": number or null,
  "longitude": number or null,
  // CRITICAL — ONLY extract latitude/longitude when the document EXPLICITLY
  // prints them under a labeled field like "Geographic Location: X; Y",
  // "Coordinates: lat, lng", "Lat/Lng:", or similar.
  // NEVER geocode from city names, town proximity, or distance descriptions.
  //   ✗ "Approximately 4.25 miles southeast of Pearsall" → DO NOT return Pearsall's coords
  //   ✗ "Near Devine, TX" → DO NOT look up Devine's coords
  //   ✓ "Geographic Location: 30.10129929; -98.59020233" → DO extract those exact numbers
  //   ✓ "Lat 28.84, Lng -99.06" → DO extract
  // If no explicit coordinates are printed, return latitude:null, longitude:null.
  "parcel_id": string or null,
  "recording_number": string or null,
  "grantor": string or null,
  "grantee": string or null,
  "financing": string or null,
  "minerals_sold": string or null,
  "confirmation_source": string or null,
  "water": "None" | "Seasonal" | "Strong" or null,
    // CRITICAL: this field is for SURFACE WATER ONLY — flowing or standing
    // water visible ON the property surface (creek, river, spring, year-round
    // draw, natural pond/lake). It is NOT about wells, irrigation, or
    // groundwater.
    //
    // DO NOT mark "Strong" based on any of these (they belong in OTHER fields):
    //   * Water wells of any kind, however productive → use has_water_rights
    //   * Carrizo / Edwards / other aquifer access → use has_water_rights
    //   * Irrigation systems (center pivot, drip, etc.) → use irrigation
    //   * Stock tanks (these are seasonal at best; usually "Seasonal" if mentioned)
    //   * Groundwater allocation or pump rates (GPM) → use has_water_rights
    //
    // Tier rules:
    //   "Strong"   = explicitly stated year-round LIVE surface water on the
    //                property (e.g., "3,000 ft of frontage along Bullhead
    //                Creek", "spring-fed", "perennial creek runs through
    //                the property").
    //   "Seasonal" = a creek/draw that runs only after rain, intermittent
    //                streams, dry creeks that "run during wet seasons", or
    //                stock tanks where the only visible water is impounded.
    //   "None"     = no surface water mentioned, OR water is exclusively
    //                via wells/irrigation/aquifer (even if abundant).
  "road_frontage": "None" | "Low" | "Medium" | "High" or null,
  "has_improvements": boolean,
  "irrigation": "None" | "Medium" | "Strong" or null,   // "Strong" = description explicitly says active center pivot / drip / current row crops. "Medium" = partial/limited irrigation. "None" = dry-land. Default null when unsure — don't guess.
  "has_water_rights": boolean,      // true ONLY when description explicitly mentions water rights / well allocation / groundwater rights. Don't infer.
  "improvements_notes": string or null,
  "wildlife_notes": string or null,
  "flood_plain": "Yes" | "Partial" | "No" or null,   // "Yes" = description mentions significant flood plain / floodway. "Partial" = some flood plain mentioned. "No" = explicitly says no flood plain. Default null when unsure.
  "description": string or null,
  "is_subject_property": boolean,
  "is_comparable": boolean,
  "confidence": {
    "overall": number (0-100),
    "per_field": {}
  }
}

For conversational questions (not document extraction), still respond as JSON
with empty comps array, e.g. {"message": "...", "comps": []}.
Be concise, professional, and speak like a knowledgeable land appraiser.`;

export async function POST(request: NextRequest) {
  try {
    const { messages, documentContent, images } = await request.json();

    const systemMessages = [
      { role: 'system' as const, content: IMPORT_SYSTEM_PROMPT },
    ];

    // Replace the final user turn with document context when provided.
    // Image array → multimodal content. documentContent → text. Plain chat → unchanged.
    const lastIdx = messages.length - 1;
    const processedMessages = messages.map((m: any, i: number) => {
      const isLastUser = i === lastIdx && m.role === 'user';
      if (isLastUser && Array.isArray(images) && images.length > 0) {
        const parts: any[] = [
          {
            type: 'text',
            text:
              'Please extract all comparable sales from this document. ' +
              'Each page is provided as an image below. Read carefully — ' +
              'tables, handwriting, and stamps may all contain key data.',
          },
          ...images.map((url: string) => ({
            type: 'image_url',
            image_url: { url, detail: 'high' as const },
          })),
        ];
        return { role: 'user' as const, content: parts };
      }
      if (isLastUser && documentContent) {
        return {
          role: 'user' as const,
          content: `Please extract all comparable sales from this document:\n\n${documentContent}`,
        };
      }
      return { role: m.role as 'user' | 'assistant', content: m.content };
    });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [...systemMessages, ...processedMessages],
    });

    const responseText = completion.choices[0]?.message?.content || '{}';

    let parsed: any = {};
    try {
      parsed = JSON.parse(responseText);
    } catch (e) {
      // Fallback: try to find a `{...}` block in case the model wrapped it
      const m = responseText.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch {}
      }
      if (!parsed || typeof parsed !== 'object') {
        console.error('Failed to parse model JSON:', e, responseText.slice(0, 500));
      }
    }

    // Filter logic:
    //   Keep if explicitly marked is_comparable=true.
    //   Keep if the record has Sale Price > 0 (it's a sold record — that's a
    //     comp by definition, even if the AI mistagged it as subject_property
    //     for a single-property doc).
    //   Drop ONLY if explicitly is_subject_property=true AND no sale data.
    let comps = Array.isArray(parsed.comps)
      ? parsed.comps.filter((c: any) => {
          if (c?.is_comparable) return true;
          const hasSalePrice = c?.sale_price && Number(c.sale_price) > 0;
          if (hasSalePrice) return true;
          if (c?.is_subject_property) return false;
          return true;
        })
      : null;
    if (Array.isArray(parsed.comps) && parsed.comps.length > 0 && (!comps || comps.length === 0)) {
      // Visibility: log what got filtered out so we can debug the "no_comps"
      // outcome that brokers see in the import chat log.
      console.warn(
        'All extracted comps were filtered out. Raw input:',
        JSON.stringify(parsed.comps.map((c: any) => ({
          property_name: c?.property_name,
          sale_price: c?.sale_price,
          is_subject_property: c?.is_subject_property,
          is_comparable: c?.is_comparable,
        })))
      );
    }

    // Authoritative-acreage rule: the appraisal's prose is the ground truth,
    // so if the description text mentions an acreage figure, that value
    // overrides whatever the model extracted into the `acres` field. The
    // `acres` field can come from a totals box, a tax summary, or other
    // sources on the document that aren't always the actual sold tract.
    if (Array.isArray(comps)) {
      for (const c of comps) {
        const fromDesc = extractAcresFromDescription(c?.description);
        if (fromDesc != null) c.acres = fromDesc;
      }
    }

    // $/ac sanity gate: when sale_price AND price_per_acre are both extracted,
    // their ratio implies an acreage. If the extracted `acres` value disagrees
    // with that implied acreage by more than 10%, prefer the implied value —
    // it's anchored to two labeled fields (Sale Price and Sale Price Per Acre)
    // instead of one possibly-ambiguous "Property Size" reading.
    //
    // Catches AI hallucinations where the model fabricates an acres value
    // (observed: 8,820 returned for a 1,179.115-ac comp where price=$5.60M
    // and ppa=$4,750 were both extracted correctly — $5.60M / $4,750 =
    // 1,179.11, gate would correct).
    //
    // Runs AFTER the description-override above. If description prose
    // already corrected `acres` to the prose-stated value, this check
    // usually finds delta near zero and doesn't fire.
    //
    // Threshold = 10%: catches obvious hallucinations while tolerating
    // rounding when ppa is a rounded $/ac (e.g. "$4,750" stated, actual
    // price/acres = $4,749.84).
    if (Array.isArray(comps)) {
      for (const c of comps) {
        const price = Number(c?.sale_price);
        const ppa = Number(c?.price_per_acre);
        const acres = Number(c?.acres);
        if (price > 0 && ppa > 0 && acres > 0) {
          const impliedAcres = price / ppa;
          const delta = Math.abs(impliedAcres - acres) / acres;
          if (delta > 0.10) {
            console.warn(
              `[sanity-gate] ${c.property_name || 'unnamed'}: ` +
              `acres=${acres} disagrees with sale_price/ppa=${impliedAcres.toFixed(3)} ` +
              `(Δ${(delta * 100).toFixed(1)}%). Overriding to implied acres.`
            );
            c.acres = Math.round(impliedAcres * 1000) / 1000;
            // Mark the correction so downstream code (and brokers reviewing
            // the comp) can see this was a sanity correction, not raw AI output.
            c._acres_sanity_corrected = true;
            // Reduce per-field confidence — the model's first guess was wrong,
            // so we have less confidence in this comp overall.
            if (c.confidence && typeof c.confidence === 'object') {
              c.confidence.per_field = c.confidence.per_field || {};
              c.confidence.per_field.acres = Math.min(
                Number(c.confidence.per_field.acres) || 60,
                60
              );
            }
          }
        }
      }
    }

    // Coords from AI extraction are trusted ONLY when they came from an
    // explicitly-printed "Geographic Location" or similar field in the
    // document (per prompt instructions above). Mapbox forward-geocoding
    // on address remains DISABLED — it returned city centroids for
    // "near Pearsall" descriptions, which masked the real property location.
    //
    // If the AI returned null coords (no printed field in doc), autoLocate
    // — server-side and/or browser-side — handles geocoding from owner+county.
    //
    // geocodeComps disabled intentionally:
    // if (Array.isArray(comps) && comps.length > 0) {
    //   try { comps = await geocodeComps(comps); } catch (e) {}
    // }

    // Auto-locate is done BROWSER-SIDE in the import page (see
    // autoLocateInBrowser in src/app/dashboard/import/page.tsx). The browser
    // can hit our cached /api/parcels-by-owner endpoint in <200ms, whereas
    // Vercel function-to-self calls bypass edge cache and take 15-30s+.
    //
    // Server-side autoLocate is DEFAULT-OFF — it was making imports take
    // 60-120s on slow TxGIO afternoons, exceeding Vercel function timeout
    // and producing "no comps" errors. Opt in with RUN_SERVER_AUTOLOCATE=1
    // ONLY if you have a reliable fast TxGIO connection.
    if (Array.isArray(comps) && comps.length > 0 && process.env.RUN_SERVER_AUTOLOCATE === '1') {
      const aerialImage = Array.isArray(images) && images.length > 0 ? images[0] : null;
      for (let i = 0; i < comps.length; i++) {
        const c = comps[i];
        try {
          console.log(`[autoLocate] starting for "${c?.property_name || c?.county}" — ${c?.acres}ac, grantee="${c?.grantee || ''}", grantor="${c?.grantor || ''}"`);
          const located = await autoLocateFromMetadata({
            county: c.county,
            acres: c.acres,
            grantee: c.grantee,
            grantor: c.grantor,
            property_name: c.property_name,
            description: c.description,
            address: c.address,
            aerialImage,
          });
          if (located) {
            console.log(`[autoLocate] ✓ ${located.match_confidence.toUpperCase()}: ${located.match_reason}`);
            comps[i] = {
              ...c,
              latitude: located.latitude,
              longitude: located.longitude,
              parcel_id: located.parcel_id ?? c.parcel_id,
              geometry: located.boundary_geojson,
              _auto_located_confidence: located.match_confidence,
            };
          } else {
            console.log(`[autoLocate] ✗ no match — keeping AI coords if any (lat=${c?.latitude}, lng=${c?.longitude})`);
          }
        } catch (e: any) {
          console.error(`[autoLocate] failed for ${c?.property_name}:`, e?.message || e);
        }
      }
    }

    // Enrich each comp with the full contiguous same-owner holding from the
    // county CAD: locate the parcel at the comp's lat/lng, walk outward
    // through adjacent same-owner parcels, union their geometry. The merged
    // shape becomes the comp's boundary; acres roll up; owner name backfills.
    if (Array.isArray(comps) && comps.length > 0) {
      comps = await Promise.all(comps.map(enrichWithHolding));
    }

    // Surface low-confidence pins so brokers know to verify the boundary.
    // (We no longer reject boundaries on acreage mismatch — appraisal vs CAD
    // divergence is the norm for TX rural land. A pin in the right area with
    // a "verify boundary" hint is much more useful than no pin at all.)
    const warnings: string[] = [];
    if (Array.isArray(comps)) {
      for (const c of comps) {
        const label = c.property_name || c.address || `${c.county || 'comp'} ${c.acres ? c.acres.toFixed(0) + ' ac' : ''}`.trim();
        if (c.partial_sale) {
          warnings.push(
            `ℹ️ "${label}": looks like a partial sale or carve-out — pinned to the matched tract, but the actual boundary may be smaller. Use Edit Boundary to trace the exact shape.`
          );
        } else if (c._auto_located_confidence === 'low') {
          warnings.push(
            `ℹ️ "${label}": pinned to the grantor's parent property as a likely carve-out. Use Edit Boundary to trace the actual ${c.acres}-acre tract.`
          );
        }
      }
    }

    const baseMessage =
      parsed.message ||
      (comps?.length
        ? `Extracted ${comps.length} comp${comps.length === 1 ? '' : 's'}.`
        : 'No comparable sales found in this document.');
    const message = warnings.length
      ? `${baseMessage}\n\n${warnings.join('\n\n')}`
      : baseMessage;

    // Diagnostic — if comps came back empty but the AI extracted SOMETHING
    // before filtering, attach the raw before-filter records so the batch
    // import log can show why. Helps debug single-property doc filtering,
    // mistagged subjects, etc.
    const rawExtractedCount = Array.isArray(parsed.comps) ? parsed.comps.length : 0;
    const filtered_out_count = rawExtractedCount - (comps?.length ?? 0);

    return NextResponse.json({
      message,
      comps,
      diagnostic: {
        raw_extracted: rawExtractedCount,
        filtered_out: filtered_out_count,
        ai_raw_message: parsed.message ?? null,
      },
    });
  } catch (error) {
    console.error('Import chat error:', error);
    return NextResponse.json(
      { message: 'Sorry, I had trouble processing that. Please try again.', comps: null },
      { status: 500 }
    );
  }
}

// Pulls the first acreage figure from descriptive prose. Handles formats like
// "265.210 ac", "1,250 acres", "455.92-acre", "97.5 ac". Ignores numbers
// followed by anything other than acres/acre/ac.
function extractAcresFromDescription(desc: any): number | null {
  if (typeof desc !== 'string' || !desc) return null;
  const m = desc.match(/([0-9][0-9,]*(?:\.\d+)?)\s*[-]?\s*(?:acres?|ac)\b/i);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

async function enrichWithHolding(comp: any): Promise<any> {
  if (!comp || comp.latitude == null || comp.longitude == null) return comp;
  const countyKey = (comp.county || '').toLowerCase();
  if (!countyKey) return comp;
  const source = getCountySource(countyKey);
  if (!source) {
    // No dedicated CAD wiring for this county — fall back to TxGIO statewide.
    return enrichWithTxGIO(comp);
  }

  try {
    const fc = await getCountyParcels(countyKey);
    const seed = findParcelAt(comp.latitude, comp.longitude, fc.features);
    if (!seed) return comp;

    const rawHolding = findContiguousSameOwner(seed, fc.features, source.ownerField);
    // Dedupe by parcel_id — some CAD datasets include duplicate rows for the
    // same parcel; counting them twice inflates acreage.
    const seenIds = new Set<string>();
    const dedupedHolding = rawHolding.filter((f) => {
      const id = String(f.properties?.[source.parcelIdField] ?? '');
      if (!id) return true; // keep id-less features (rare)
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    // Pick which subset of the holding to use as the boundary (seed alone vs
    // full contiguous holding) but do NOT reject on acreage mismatch — TX
    // appraisal acreage routinely diverges from CAD by 20-40% due to
    // carve-outs, surveys, road exclusions. A pin in the right neighborhood
    // is more useful than no pin at all; broker can Edit Boundary to fix.
    const { features: holding, totalAcres, mismatch } = selectBoundaryByAcreage(
      seed,
      dedupedHolding,
      comp.acres,
      source.acresField
    );
    const merged = mergeFeatures(holding);
    if (!merged) return comp;

    const ownerName = String(seed.properties?.[source.ownerField] || '').trim() || comp.owner_name;
    const parcelIds = holding
      .map((f) => f.properties?.[source.parcelIdField])
      .filter((v) => v != null && v !== '')
      .map(String);
    const parcelIdJoined = parcelIds.join(',');
    const rawAddress = source.addressFromProps ? source.addressFromProps(seed.properties || {}) : null;
    // Drop addresses that are just a city name with no street
    const address = rawAddress && /\d/.test(rawAddress) ? rawAddress : comp.address;

    return {
      ...comp,
      owner_name: ownerName || comp.owner_name,
      // Acreage from the report/description always wins. The polygon's area is
      // a derived signal, not authoritative — appraisal docs are.
      acres: comp.acres ?? totalAcres,
      address: address || comp.address,
      parcel_id: parcelIdJoined || comp.parcel_id,
      geometry: merged.geometry || merged,
      holding_parcel_count: holding.length,
      partial_sale: mismatch,
    };
  } catch (e) {
    console.error('Holding enrichment failed:', e);
    return comp;
  }
}

// ── Seed-candidate scoring (used by enrichWithTxGIO when SEED_OWNER_MATCH=1)
// Tokenize an owner name string into significant lowercase tokens for
// matching. Strips entity suffixes (LLC/LTD/etc) and common short words.
function tokenizeOwner(name: string | null | undefined): string[] {
  if (!name) return [];
  return String(name)
    .toUpperCase()
    .replace(/[.,&]/g, ' ')
    .replace(/\b(LLC|LTD|INC|TRUSTEE|TRUST|FAMILY|REVOCABLE|LIVING|JR|SR|THE|OF|AND)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

// Score a candidate parcel as a seed. Higher = better seed.
// When useOwnerMatch is true: prefers parcels whose owner_name matches
// the appraisal's grantee (then grantor) tokens. Falls back to centroid
// distance when no name signal is available or no candidate matches.
function scoreSeedCandidate(
  ownerName: string,
  distDegrees: number,
  granteeTokens: string[],
  grantorTokens: string[],
  useOwnerMatch: boolean
): number {
  // Proximity score: -dist so smaller distance = higher score.
  // Normalize so worst-case distance (1.5km buffer = ~0.015°) ≈ -15.
  const proximityScore = -(distDegrees * 1000);

  if (!useOwnerMatch) return proximityScore;

  const ownerUpper = String(ownerName || '').toUpperCase();
  // Score by fraction of grantee tokens present (×100), then grantor (×50)
  const granteeHits = granteeTokens.filter((t) => ownerUpper.includes(t)).length;
  const grantorHits = grantorTokens.filter((t) => ownerUpper.includes(t)).length;
  const granteeScore = granteeTokens.length > 0
    ? (granteeHits / granteeTokens.length) * 100
    : 0;
  const grantorScore = grantorTokens.length > 0
    ? (grantorHits / grantorTokens.length) * 50
    : 0;
  // Owner-match (when ALL tokens present) dwarfs proximity. Partial match
  // still beats no match. Proximity is the tiebreaker.
  return Math.max(granteeScore, grantorScore) + proximityScore * 0.01;
}

const TXGIO_QUERY =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query';

// Universal TX fallback: query TxGIO for the seed parcel at the click point,
// then for all parcels in the same county with the same owner, then run the
// same contiguous-merge logic. Lower data quality than per-county CADs but
// covers the whole state.
async function enrichWithTxGIO(comp: any): Promise<any> {
  try {
    // 1) Find seed parcel by point — cascading buffer. Appraiser-printed
    // coords often sit on the road/driveway, not inside the parcel.
    // Tight 10m envelope misses; 100m+ catches the actual property.
    const BUFFERS = [0.0001, 0.001, 0.005, 0.015]; // ~10m, 100m, 500m, 1.5km
    const useOwnerMatch = process.env.SEED_OWNER_MATCH === '1';
    const granteeTokens = useOwnerMatch ? tokenizeOwner(comp.grantee) : [];
    const grantorTokens = useOwnerMatch ? tokenizeOwner(comp.grantor) : [];

    let seed: any = null;
    for (const d of BUFFERS) {
      try {
        const seedParams = new URLSearchParams({
          geometry: `${comp.longitude - d},${comp.latitude - d},${comp.longitude + d},${comp.latitude + d}`,
          geometryType: 'esriGeometryEnvelope',
          inSR: '4326',
          spatialRel: 'esriSpatialRelIntersects',
          outFields: 'prop_id,owner_name,gis_area,situs_addr,county',
          returnGeometry: 'true',
          outSR: '4326',
          resultRecordCount: '15',
          f: 'geojson',
        });
        const seedRes = await fetch(`${TXGIO_QUERY}?${seedParams}`, { signal: AbortSignal.timeout(15000) });
        if (!seedRes.ok) continue;
        const seedData = await seedRes.json();
        const features: any[] = Array.isArray(seedData?.features) ? seedData.features : [];
        if (features.length === 0) continue;

        // Score each candidate. Default = closest centroid distance.
        // With SEED_OWNER_MATCH=1, prefer parcels whose owner_name matches
        // the appraisal's grantee (then grantor) — beats pure proximity.
        let bestScore = -Infinity;
        for (const f of features) {
          if (!f?.properties?.owner_name) continue;
          try {
            const ring = f.geometry?.coordinates?.[0];
            if (!Array.isArray(ring) || ring.length === 0) continue;
            let sx = 0, sy = 0;
            for (const pt of ring) { sx += pt[0]; sy += pt[1]; }
            const cx = sx / ring.length, cy = sy / ring.length;
            const dist = Math.hypot(cx - comp.longitude, cy - comp.latitude);
            const score = scoreSeedCandidate(
              f.properties.owner_name,
              dist,
              granteeTokens,
              grantorTokens,
              useOwnerMatch
            );
            if (score > bestScore) {
              bestScore = score;
              seed = f;
            }
          } catch {}
        }
        if (seed) break;
      } catch {}
    }
    if (!seed?.properties?.owner_name) return comp;

    const owner = String(seed.properties.owner_name).trim();
    const county = String(seed.properties.county || comp.county || '').trim();
    if (!owner || !county) return comp;

    // 2) Find all same-owner parcels in the same county (TxGIO is case-sensitive)
    const safeOwner = owner.replace(/'/g, "''");
    const safeCounty = county.replace(/'/g, "''");
    const allParams = new URLSearchParams({
      where: `owner_name='${safeOwner}' AND county='${safeCounty}'`,
      outFields: 'prop_id,owner_name,gis_area,situs_addr,county',
      returnGeometry: 'true',
      outSR: '4326',
      resultRecordCount: '500',
      f: 'geojson',
    });
    const allRes = await fetch(`${TXGIO_QUERY}?${allParams}`, { signal: AbortSignal.timeout(15000) });
    if (!allRes.ok) return comp;
    const allData = await allRes.json();
    const candidates: any[] = allData.features || [];
    if (candidates.length === 0) return comp;

    // 3) Walk the contiguous component starting from the seed
    const rawHolding = findContiguousSameOwner(seed, candidates, 'owner_name');

    // Dedupe by prop_id
    const seenIds = new Set<string>();
    const dedupedHolding = rawHolding.filter((f) => {
      const id = String(f.properties?.prop_id ?? '');
      if (!id) return true;
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    // Pick the boundary subset but DO NOT reject on acreage mismatch.
    // (See matching comment in enrichWithHolding above.)
    const { features: unique, totalAcres, mismatch } = selectBoundaryByAcreage(
      seed,
      dedupedHolding,
      comp.acres,
      'gis_area'
    );
    const merged = mergeFeatures(unique);
    if (!merged) return comp;

    const parcelIdJoined = unique
      .map((f) => f.properties?.prop_id)
      .filter((v) => v != null && v !== '')
      .map(String)
      .join(',');

    return {
      ...comp,
      owner_name: owner || comp.owner_name,
      // Appraisal acreage always wins; polygon area is just a sanity check.
      acres: comp.acres ?? totalAcres,
      address: comp.address || seed.properties?.situs_addr || null,
      parcel_id: parcelIdJoined || comp.parcel_id,
      geometry: merged.geometry || merged,
      holding_parcel_count: unique.length,
      partial_sale: mismatch,
    };
  } catch (e) {
    console.error('TxGIO enrichment failed:', e);
    return comp;
  }
}

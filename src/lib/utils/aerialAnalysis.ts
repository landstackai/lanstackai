// Location signal extractor. Reads the PDF page 1 (aerial photo) and/or
// the comp's description + address text to extract:
//   * Road names visible in the image or mentioned in text
//   * Nearby towns
//   * Distance landmarks ("5mi south of Devine")
//   * A search_hint that can be geocoded by Mapbox
//
// Cost: ~$0.02-0.05 per call (OpenAI vision, single image, low detail).
// Only invoked when county+acreage parcel lookup didn't disambiguate.

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type DistanceLandmark = {
  landmark: string;
  miles: number;
  direction: string;
};

export type LocationSignals = {
  roads: string[];
  nearby_towns: string[];
  water_features: string[];
  distance_landmarks: DistanceLandmark[];
  search_hint: string | null;
};

const LOCATION_PROMPT = `You extract location signals to find a Texas land parcel on a map.

Input may be: an aerial / satellite image (often with a property outlined in yellow), and/or text from the document's Location, Address, and Description fields.

Texas land descriptions frequently include distance-based landmarks like:
  "5.0 miles south of Devine"
  "6.4 miles northwest of Bigfoot"
  "off F.M. 3176"
  "cross section of County Rd 2801 and 140"
TRIANGULATE when multiple landmarks are given — the intersection narrows the property to a small area.

Return STRICT JSON:
{
  "roads": ["F.M. 3176"],
  "nearby_towns": ["Devine"],
  "water_features": ["West Frio River along east edge"],
  "distance_landmarks": [
    {"landmark": "Devine, TX", "miles": 5.0, "direction": "south"}
  ],
  "search_hint": "F.M. 3176 south of Devine, TX"
}

search_hint PRIORITY ORDER (use the highest-priority signal you have):
  1. ROAD INTERSECTION — if two named roads meet at the property
     ("County Rd 2801 and County Rd 140, Frio County, TX"). Most specific.
  2. SINGLE ROAD + NEAREST TOWN — "F.M. 3176 south of Devine, TX"
  3. TOWN ONLY — "near Devine, TX"

Rules:
- Only use signals visible in the image or stated in the text. Don't invent.
- water_features is SURFACE water only (creeks, rivers, ponds, lakes). Do
  NOT list water wells, irrigation, or aquifer access — those aren't water
  features for location purposes.
- Append state abbreviation to landmarks ("Devine, TX").
- Return EMPTY arrays for fields with no signals.
- Output ONLY the JSON object.`;

export async function extractLocationSignals(
  imageDataUrl: string | null | undefined,
  contextText?: {
    description?: string | null;
    address?: string | null;
    location?: string | null;
  }
): Promise<LocationSignals | null> {
  if (!imageDataUrl && !contextText?.description && !contextText?.address && !contextText?.location) {
    return null;
  }

  const textBlocks: string[] = ['Extract location signals.'];
  if (contextText?.location) textBlocks.push(`\nLOCATION:\n${contextText.location}`);
  if (contextText?.address) textBlocks.push(`\nADDRESS:\n${contextText.address}`);
  if (contextText?.description) {
    textBlocks.push(`\nDESCRIPTION:\n${contextText.description.slice(0, 3000)}`);
  }

  const userContent: any[] = [{ type: 'text', text: textBlocks.join('\n') }];
  if (imageDataUrl) {
    userContent.push({
      type: 'image_url',
      image_url: { url: imageDataUrl, detail: 'low' as const },
    });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: LOCATION_PROMPT },
        { role: 'user', content: userContent },
      ],
    });
    const text = completion.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(text);
    return {
      roads: Array.isArray(parsed.roads) ? parsed.roads : [],
      nearby_towns: Array.isArray(parsed.nearby_towns) ? parsed.nearby_towns : [],
      water_features: Array.isArray(parsed.water_features) ? parsed.water_features : [],
      distance_landmarks: Array.isArray(parsed.distance_landmarks) ? parsed.distance_landmarks : [],
      search_hint: typeof parsed.search_hint === 'string' ? parsed.search_hint : null,
    };
  } catch (e: any) {
    console.error('extractLocationSignals failed:', e?.message);
    return null;
  }
}

const VERIFY_PROMPT = `You are verifying a parcel-boundary match.

You will see:
  1. An aerial photo of a property (usually with the property outlined in
     yellow/red, sometimes annotated with text).
  2. A candidate parcel boundary description (county, acreage, owner).

Decide: does the candidate plausibly match the property in the image?

A plausible match means:
  - The candidate's acreage matches the property in the image (use scale
    or context clues — fences, roads, fields).
  - The candidate's location (county) is consistent with the image.
  - Nothing in the image strongly contradicts the candidate (wrong shape,
    wrong terrain, wildly different size).

Output STRICT JSON:
{
  "matches": true | false,
  "confidence": 0-100,
  "reason": "one sentence"
}

Be conservative — only return matches:true with confidence > 70 if you are
genuinely confident. When in doubt, say matches:false.`;

export async function verifyParcelMatch(
  imageDataUrl: string | null | undefined,
  candidate: {
    county?: string | null;
    acres?: number | null;
    owner_name?: string | null;
  }
): Promise<{ matches: boolean; confidence: number; reason: string } | null> {
  if (!imageDataUrl) return null;

  const candidateText = [
    candidate.county && `County: ${candidate.county}`,
    candidate.acres && `Acres: ${candidate.acres.toFixed(1)}`,
    candidate.owner_name && `Owner: ${candidate.owner_name}`,
  ].filter(Boolean).join('\n');

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: VERIFY_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Candidate parcel:\n${candidateText}\n\nDoes this match the property in the image?` },
            { type: 'image_url', image_url: { url: imageDataUrl, detail: 'low' as const } },
          ],
        },
      ],
    });
    const text = completion.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(text);
    return {
      matches: Boolean(parsed.matches),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch (e: any) {
    console.error('verifyParcelMatch failed:', e?.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Aerial-vs-photo classifier
// ──────────────────────────────────────────────────────────────────────
//
// extractLargestAerialPerPage() naively pulls the LARGEST embedded image
// from each PDF page. For a typical Texas appraisal that's a satellite
// aerial of the subject parcel — exactly what we want as the comp's
// thumbnail. But for marketing flyers, MLS sold sheets, or appraisals
// that lead with a hero shot of the ranch house, the largest image can
// be:
//
//   - A terrestrial photo of a house, barn, or pasture (looks great in
//     the PDF, useless as a "this is the parcel" thumbnail)
//   - A logo, headshot, signature, or scanned cover sheet
//   - A floor plan or schematic
//
// Attaching any of those as the comp's aerial gives the broker
// confidently-wrong context — the report shows a house instead of the
// land. We need a cheap binary gate: is this image actually an aerial
// view of a parcel?
//
// GPT-4o-mini vision is the right tool. ~$0.0001 per image. A 5-page
// appraisal classifies in ~3-5 seconds total in parallel; the cost is
// rounding error against any other AI call we make.
//
// Conservative bias: when uncertain, return false. Better to attach NO
// thumbnail than the wrong one — matches the "honest failure beats
// confident wrong" principle from the autolocate work.

const CLASSIFY_AERIAL_PROMPT = `You classify a single image as either an
AERIAL view of a land parcel (suitable as a property thumbnail) or NOT.

Return one word:

  AERIAL — Top-down satellite or aerial photography of land. Trees,
           pastures, fields, roads from above, parcel outlines, terrain
           features visible from the sky. This is what we want.

  PHOTO  — Terrestrial / ground-level photograph. Building exteriors,
           interior shots, livestock, people, vehicles, fence lines from
           ground perspective, landscape with horizon visible.

  OTHER  — Logos, signatures, headshots, scanned cover pages, floor
           plans, charts, marketing graphics, anything else that isn't
           a top-down view of land.

Be conservative — only return AERIAL when you are genuinely confident
the image is a top-down view of land. When in doubt, return PHOTO or
OTHER. Reply with a single word and nothing else.`;

export type AerialClassification = 'AERIAL' | 'PHOTO' | 'OTHER';

/**
 * Classify a single image data URL as AERIAL / PHOTO / OTHER. Returns
 * the classification string, or null if the call failed (caller should
 * treat null as "unverified — don't use as thumbnail").
 *
 * Uses gpt-4o-mini with detail:'low' to keep cost minimal (~$0.0001).
 */
export async function classifyAerial(
  imageDataUrl: string | null | undefined
): Promise<AerialClassification | null> {
  if (!imageDataUrl) return null;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 5,
      temperature: 0,
      messages: [
        { role: 'system', content: CLASSIFY_AERIAL_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Classify this image:' },
            { type: 'image_url', image_url: { url: imageDataUrl, detail: 'low' as const } },
          ],
        },
      ],
    });
    const raw = (completion.choices[0]?.message?.content || '').trim().toUpperCase();
    // Tolerate slight variation in the model's output; first word wins.
    const firstWord = raw.split(/\s+/)[0];
    if (firstWord === 'AERIAL') return 'AERIAL';
    if (firstWord === 'PHOTO') return 'PHOTO';
    if (firstWord === 'OTHER') return 'OTHER';
    // Unrecognized response — treat as unverified
    console.warn(`classifyAerial: unrecognized response "${raw}"`);
    return null;
  } catch (e: any) {
    console.error('classifyAerial failed:', e?.message);
    return null;
  }
}

/**
 * Filter an array of candidate aerial images down to just the ones
 * classified as AERIAL. Runs all classifications in parallel.
 * Maintains the original ordering of survivors.
 *
 * Used by the import pipeline before attaching thumbnails to comps —
 * keeps house photos and logos from sneaking into the comp record as
 * "the parcel aerial."
 */
export async function filterAerialsByClassification<
  T extends { dataUrl: string }
>(candidates: T[]): Promise<T[]> {
  if (candidates.length === 0) return [];
  const classifications = await Promise.all(
    candidates.map((c) => classifyAerial(c.dataUrl))
  );
  return candidates.filter((_, i) => classifications[i] === 'AERIAL');
}

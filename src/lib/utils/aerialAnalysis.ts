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

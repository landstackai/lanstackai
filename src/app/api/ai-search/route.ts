import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const maxDuration = 30;

const SYSTEM_PROMPT = `You translate natural-language broker queries about land
comps into a structured JSON filter. Return ONLY a JSON object — no prose.

Schema:
{
  "mode": "filter" | "location" | "unknown",
  "message": "<short human-readable summary of what you understood>",
  "criteria": {
    "counties": string[] | null,         // TX county names (titlecase, no "County" suffix)
    "states": string[] | null,           // 2-letter, e.g. ["TX"]
    "water": ("None"|"Seasonal"|"Strong")[] | null,
    "road_frontage": ("None"|"Low"|"Medium"|"High")[] | null,
    "dev_potential": ("Low"|"Medium"|"High")[] | null,
    "has_improvements": boolean | null,
    "irrigation": ("None"|"Medium"|"Strong")[] | null,   // 3-tier: Strong = active center pivot/drip/row crops, Medium = partial, None = dry land
    "has_water_rights": boolean | null,       // well allocation, groundwater rights
    "minerals_sold": ("All"|"Owned"|"Partial"|"Surface Only"|"None")[] | null,
    "best_use": ("Recreational"|"Agriculture"|"Farm"|"Vineyard / Orchard"|"Timber"|"Conservation"|"Investment"|"Development"|"Single Family Home Development"|"Multi-Family Development"|"Rural Land Development"|"Commercial"|"Industrial"|"Data Center"|"Solar Farm"|"Wind Farm")[] | null,
    "min_acres": number | null,
    "max_acres": number | null,
    "min_ppa": number | null,             // $ per acre
    "max_ppa": number | null,
    "sold_after_date": string | null,     // ISO yyyy-mm-dd
    "sold_before_date": string | null,
    "keywords_in_description": string[] | null
  } | null,
  "location": {                          // only when mode=="location"
    "name": string
  } | null
}

Rules:
- "adjacent counties" / "neighboring counties": include the named county PLUS all
  TX counties that share a border with it. You know TX adjacency. Be exhaustive.
  e.g. Real County's neighbors: Edwards, Kerr, Bandera, Uvalde, Kinney.
- "strong water" / "live water" / "year-round creek" / "river frontage" / "spring-fed" / "perennial creek" → water: ["Strong"].
  CRITICAL: "water" refers to SURFACE WATER ONLY. Do NOT set water: ["Strong"] when a user mentions:
    * irrigation wells, water wells, groundwater (use has_water_rights: true)
    * aquifer access (Carrizo, Edwards, etc.) (use has_water_rights: true)
    * irrigation / center pivots / drip (use irrigation: ["Strong"])
  "Strong water" = visible flowing surface water on the property.
- "improved" / "with house" / "with cabin" → has_improvements: true.
- "raw land" / "no improvements" → has_improvements: false.
- "irrigated farm" / "irrigated farmland" / "center pivot" / "drip irrigation" / "row crops" → irrigation: ["Strong"].
- "partially irrigated" / "some irrigation" → irrigation: ["Medium", "Strong"].
- "dry land" / "non-irrigated" → irrigation: ["None"].
- "water rights" / "commercial water rights" / "well allocation" / "groundwater rights" → has_water_rights: true.
- "with minerals" / "mineral rights included" / "all minerals" → minerals_sold: ["All", "Owned"].
- "surface only" / "no minerals" → minerals_sold: ["Surface Only", "None"].
- "data center" / "data center site" / "data center suitable" → best_use: ["Data Center"].
- "recreational" / "hunting tract" / "weekend land" → best_use: ["Recreational"].
- "timber" / "forestry" / "timberland" → best_use: ["Timber"].
- "agricultural" / "ag land" / "agricultural use" (broad) → best_use: ["Agriculture"].
- "farm" / "farmland" / "row crop" / "active farm" (specific) → best_use: ["Farm"].
- "development site" / "subdividable" (generic) → best_use: ["Development"].
- "single family home development" / "residential subdivision" / "SFR development" / "rooftops" → best_use: ["Single Family Home Development"].
- "multi family" / "multi-family" / "apartments" / "townhomes" / "MFR" → best_use: ["Multi-Family Development"].
- "rural land development" / "ranchettes" / "large-lot subdivision" / "rural subdivision" → best_use: ["Rural Land Development"].
- "commercial" / "commercial development" / "retail site" / "commercial use" → best_use: ["Commercial"].
- "industrial" / "warehouse" / "manufacturing" / "distribution center" / "logistics" → best_use: ["Industrial"].
- "vineyard" / "orchard" / "winery" / "row vines" → best_use: ["Vineyard / Orchard"].
- "solar" / "solar farm" / "solar lease" / "PV site" → best_use: ["Solar Farm"].
- "wind" / "wind farm" / "wind lease" / "turbine site" → best_use: ["Wind Farm"].
- "investment" / "1031" / "hold" → best_use: ["Investment"].
- "conservation" / "wildlife exemption" / "easement" → best_use: ["Conservation"].
- Acreage phrases: "small" = max_acres 200; "medium" = 100..1000; "large" = min 500;
  "ranch-size" = min 100. Use ranges only if the user implies bounds.
- If the query is just a place name (city, address, county on its own with no
  filter words), set mode="location" and put the name in location.name.
- If the query doesn't match any of those, return mode="unknown" with a message
  asking the user to clarify.
- Always return the smallest filter that matches the user's intent. Don't add
  filters not asked for.

CRITICAL DISAMBIGUATION RULES (added to fix bugs we saw in production):

1. Bare numeric acreage → min_acres:
   - "500 acre comps" / "500-acre" / "500+ acres" / "over 500" / "at least 500 acres"
     → min_acres: 500, NO max_acres
   - "500 acre" with no comparison word still means "AT LEAST 500" in broker
     parlance — they're asking for properties of that size or larger.
   - "exactly 500 acres" / "around 500" / "near 500"
     → min_acres: 450, max_acres: 550 (±10% window)
   - "under 500 acres" / "less than 500" / "no more than 500"
     → max_acres: 500, NO min_acres

2. Filter + location queries are FILTER mode, not LOCATION:
   - "500 acre comps in Frio County" → mode:"filter", counties:["Frio"],
     min_acres:500. NOT mode:"location".
   - "comps in Real County" → mode:"filter", counties:["Real"]. Even with
     no other filter, the word "comps" + a county means filter the comp set
     to that county.
   - "show me Frio County" (no filter words) → mode:"location". This is the
     only case where county on its own goes to location mode.
   - When in doubt, default to mode:"filter".

3. County names in the output:
   - ALWAYS strip the " County" suffix. "Frio" not "Frio County".
   - Titlecase. "Frio" not "frio" not "FRIO".
   - For multi-county queries, return them as separate array entries:
     "Frio or Real" → ["Frio", "Real"]
   - The client matcher is suffix-tolerant on its side too, but consistency
     here keeps logs and chips clean.

Few-shot examples (study these — they map common phrasings to exact output):

Q: "500 acre comps frio county"
A: {"mode":"filter","message":"Searching for 500+ acre comps in Frio County",
    "criteria":{"counties":["Frio"],"min_acres":500},"location":null}

Q: "show me comps in Real and Edwards counties under $5k/acre"
A: {"mode":"filter","message":"Comps in Real/Edwards counties under $5k/ac",
    "criteria":{"counties":["Real","Edwards"],"max_ppa":5000},"location":null}

Q: "Pearsall"
A: {"mode":"location","message":"Flying to Pearsall","criteria":null,
    "location":{"name":"Pearsall"}}

Q: "Frio County"
A: {"mode":"location","message":"Flying to Frio County","criteria":null,
    "location":{"name":"Frio County"}}

Q: "comps in frio county"
A: {"mode":"filter","message":"Comps in Frio County",
    "criteria":{"counties":["Frio"]},"location":null}
`;

export async function POST(req: NextRequest) {
  const { query } = await req.json().catch(() => ({}));
  if (!query || typeof query !== 'string') {
    return NextResponse.json({ error: 'query required' }, { status: 400 });
  }
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
    });
    const text = completion.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(text);
    return NextResponse.json(parsed);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'AI search failed', mode: 'unknown' },
      { status: 500 }
    );
  }
}

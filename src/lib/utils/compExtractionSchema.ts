// Phase 2b.2 — schema-locked extraction output.
//
// OpenAI's "structured outputs" mode (response_format.type = 'json_schema')
// enforces the response shape at the model level. Today we use the looser
// 'json_object' mode and the model is "asked nicely" via the prompt to
// return specific fields. The result: most of the time we get
//   "acres": 344.96
// but sometimes we get
//   "acres": "344.96"        // string, downstream parsers limp by
//   "acres": "$344.96"       // typo'd unit, parser returns NaN
//   "sale_price": "$1.2M"    // shorthand, parser returns NaN
//   "latitude": "29.1024"    // string, sanity layer can't bbox-check
// — and the comp lands in the vault with broken types nobody catches
// until a CMA filter silently excludes it.
//
// Locking the schema kills that class of bug deterministically. The
// model can still hallucinate VALUES, but it can no longer hallucinate
// TYPES.
//
// Design choices:
//
// 1. **All fields nullable, all fields required.** OpenAI structured
//    outputs require every key listed in `properties` to also appear in
//    `required` — nullability is expressed as `["string", "null"]`. This
//    is fine for our use case: a missing field IS data ("no acreage
//    found" is different from "field was forgotten").
//
// 2. **No additional properties.** Locks the shape so future prompt
//    changes can't silently introduce a new field that downstream code
//    doesn't know about.
//
// 3. **Numbers stay numbers, strings stay strings.** No string-coercion
//    shortcuts — if the model wants to return a non-numeric value for
//    `acres`, it must use null. This is the whole point.
//
// 4. **Source fields are paired with their numeric fields.** Required-if
//    semantics are enforced in the prompt today; structured outputs
//    don't support conditional required, so we keep the prompt rule and
//    just make _source fields nullable strings.
//
// 5. **Feature-flagged.** Schema mode is gated behind the
//    USE_SCHEMA_EXTRACTION env var (defaults to OFF) so we can flip
//    it on for testing, watch a few real broker uploads, then ship to
//    everyone. Flag flip is a Vercel env-var change, not a deploy.

// JSON Schema for a single extracted comp. Mirrors the field list
// described in IMPORT_SYSTEM_PROMPT (src/app/api/import-chat/route.ts).
// When this list drifts from the prompt, the model will return fields
// the schema rejects and the API call will hard-fail — that's the
// intent, it forces us to keep the two in sync.
const COMP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    property_name: { type: ['string', 'null'] },
    county: { type: ['string', 'null'] },
    state: { type: ['string', 'null'] },

    // Numeric core. The whole reason this schema exists.
    acres: { type: ['number', 'null'] },
    acres_source: { type: ['string', 'null'] },
    sale_price: { type: ['number', 'null'] },
    sale_price_source: { type: ['string', 'null'] },
    price_land_only: { type: ['number', 'null'] },
    improvements_value: { type: ['number', 'null'] },
    // Required citation paired with improvements_value. Added 2026-06-17
    // after the Fritz Farm production bug: $190k saved when the correct
    // value was $765k. Root cause was zero accountability for where the
    // model grabbed the dollar figure from. Now every improvements_value
    // must be itemized with arithmetic in this source string (e.g.
    // "p2 · Remarks · irrigation $575,000 + hay barn $190,000 = $765,000").
    improvements_value_source: { type: ['string', 'null'] },
    price_per_acre: { type: ['number', 'null'] },
    price_per_acre_source: { type: ['string', 'null'] },
    ppa_land_only: { type: ['number', 'null'] },
    ppa_land_only_source: { type: ['string', 'null'] },

    // Date as ISO string. Schema can't enforce the YYYY-MM-DD shape (no
    // format keyword in structured outputs), but the sanity layer
    // (extractionSanity.ts) catches future-dated + pre-1990 values.
    sale_date: { type: ['string', 'null'] },

    address: { type: ['string', 'null'] },
    latitude: { type: ['number', 'null'] },
    longitude: { type: ['number', 'null'] },
    parcel_id: { type: ['string', 'null'] },
    recording_number: { type: ['string', 'null'] },
    grantor: { type: ['string', 'null'] },
    grantee: { type: ['string', 'null'] },
    financing: { type: ['string', 'null'] },
    minerals_sold: { type: ['string', 'null'] },
    confirmation_source: { type: ['string', 'null'] },

    // Enums. Structured outputs DOES support `enum` for string types,
    // which kills the "model returned 'strong' lowercase" class of bug.
    // Null is still allowed via the type-union pattern.
    water: { type: ['string', 'null'], enum: ['None', 'Seasonal', 'Strong', null] },
    road_frontage: { type: ['string', 'null'], enum: ['None', 'Low', 'Medium', 'High', null] },
    has_improvements: { type: 'boolean' },
    irrigation: { type: ['string', 'null'], enum: ['None', 'Medium', 'Strong', null] },
    has_water_rights: { type: 'boolean' },
    improvements_notes: { type: ['string', 'null'] },
    wildlife_notes: { type: ['string', 'null'] },
    flood_plain: { type: ['string', 'null'], enum: ['Yes', 'Partial', 'No', null] },
    description: { type: ['string', 'null'] },

    is_subject_property: { type: 'boolean' },
    is_comparable: { type: 'boolean' },

    // Provenance: 1-indexed PDF page numbers this comp's data was drawn
    // from. E.g. Land Sale 1 typically lives on pages [37, 38] of a
    // Stouffer appraisal (one aerial/identification page + one
    // description/remarks page). Used post-extraction to:
    //   1. Render the appraiser's aerial image (page[0]) as a thumbnail
    //      that overlays the boundary-draw map for visual reference.
    //   2. Slice those pages out as a standalone sub-PDF and save it to
    //      comp_documents so the broker can re-open the source pages
    //      later without scrolling the full 71-page appraisal.
    // The Claude fallback path already populates this (see import-pdf-claude).
    // Adding it to the GPT primary schema so the orchestrator can hand
    // both engines' output to the same downstream ConvertAPI loop.
    evidence_pages: {
      type: 'array',
      items: { type: 'integer' },
    },

    confidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        overall: { type: 'number' },
        // per_field used to be a free-form object of field→confidence
        // pairs. OpenAI strict mode rejects `additionalProperties: true`
        // on every object — so we can't represent a free-form object.
        // Coerce per_field to a nullable string instead. The AI can
        // return a JSON-serialized summary ("acres: 95, sale_price: 88")
        // or null. Downstream code already treats per_field as opaque
        // (we don't read structured data from it today) so this is a
        // pure shape change, not a behavior change.
        per_field: { type: ['string', 'null'] },
      },
      required: ['overall', 'per_field'],
    },
  },
  // Structured outputs requires EVERY property listed in `properties`
  // to be in `required`. Nullability is expressed via the type unions
  // above. This is a quirk of the spec, not our preference.
  required: [
    'property_name', 'county', 'state',
    'acres', 'acres_source', 'sale_price', 'sale_price_source',
    'price_land_only', 'improvements_value', 'improvements_value_source',
    'price_per_acre', 'price_per_acre_source',
    'ppa_land_only', 'ppa_land_only_source',
    'sale_date', 'address', 'latitude', 'longitude',
    'parcel_id', 'recording_number', 'grantor', 'grantee',
    'financing', 'minerals_sold', 'confirmation_source',
    'water', 'road_frontage', 'has_improvements', 'irrigation',
    'has_water_rights', 'improvements_notes', 'wildlife_notes',
    'flood_plain', 'description',
    'is_subject_property', 'is_comparable', 'evidence_pages', 'confidence',
  ],
} as const;

// The full response: a top-level message string + an array of comps.
// This matches what IMPORT_SYSTEM_PROMPT instructs the model to return.
export const IMPORT_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    comps: {
      type: 'array',
      items: COMP_SCHEMA,
    },
  },
  required: ['message', 'comps'],
} as const;

// Wrapped in the response_format envelope OpenAI expects.
export const IMPORT_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'comp_extraction_response',
    strict: true,
    schema: IMPORT_RESPONSE_SCHEMA,
  },
};

/**
 * Should this request use the new schema-locked extraction format?
 *
 * Default: OFF. The legacy `json_object` mode keeps running until the
 * env var is flipped, so a bad deploy can't break extraction for every
 * user — we opt in deliberately, observe, then make it default.
 *
 * Env var values that turn it ON: "1", "true", "yes", "on" (case
 * insensitive). Anything else → off.
 */
export function isSchemaExtractionEnabled(): boolean {
  const v = process.env.USE_SCHEMA_EXTRACTION;
  if (!v) return false;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

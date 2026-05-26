// Shape of the data the PDF render route passes into the
// MarketingCMAPdf <Document>. Defining this once keeps the page
// components honest — they import this type instead of poking at
// raw Supabase row shapes.
//
// The PDF route is responsible for:
//   1. Fetching the cmas row (server-side, RLS-enforced)
//   2. Fetching all selected_comp_ids comps
//   3. Pulling the broker profile (full_name, brokerage_name)
//   4. Computing the comp averages (mid/low/high acreage, $/acre)
//   5. Generating the mapbox static URL for the comp map
//   6. Generating the subject aerial URL (cover hero fallback)
// And then hands a fully-resolved CmaPdfData object to the Document.
//
// No Supabase calls happen inside the Document — react-pdf renders
// synchronously, async network access mid-render is a footgun.

export type OpinionMode = 'lump_sum' | 'breakdown' | null;
export type OpinionPresentation = 'confirmed' | 'range' | 'discuss' | null;

export type CmaPdfBroker = {
  full_name: string | null;
  brokerage_name: string | null;
  email: string | null;
  phone: string | null;
};

export type CmaPdfSubject = {
  name: string | null;
  county: string | null;
  state: string | null;
  acres: number | null;
  address: string | null;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  boundary_geojson: any | null;

  // Subject Overview prose for Page 2 (PR #48). Either AI-drafted
  // from broker notes or hand-written. Empty string / null means
  // "broker hasn't filled this out yet" — page renders a fallback.
  overview_prose: string | null;

  // Optional broker-supplied cover hero. NULL = use the aerial URL
  // computed from boundary_geojson + lat/lng.
  cover_image_url: string | null;
};

export type CmaPdfComp = {
  id: string;
  property_name: string | null;
  address: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  acres: number | null;

  sale_price: number | null;
  sale_date: string | null; // ISO
  price_per_acre: number | null;
  ppa_land_only: number | null;
  improvements_value: number | null;

  latitude: number | null;
  longitude: number | null;
  aerial_image: string | null;       // base64 data URL
  listing_thumbnail: string | null;  // hosted URL
  source_url: string | null;

  status: string | null;
  water: string | null;
  road_frontage: string | null;
  dev_potential: string | null;
  best_use: string[] | null;
  topography: string | null;
  has_improvements: boolean | null;
  use_land_only_for_cma: boolean | null;

  notes: string | null;
};

// The aggregate stats computed across the selected comps — these
// drive the Opinion of Value reveal on Page 5.
export type CmaPdfStats = {
  count: number;
  avg_ppa: number | null;
  median_ppa: number | null;
  min_ppa: number | null;
  max_ppa: number | null;

  // Implied valuations (avg_ppa × subject_acres) for each band.
  value_low: number | null;
  value_mid: number | null;
  value_high: number | null;

  // Per-acre rendering (used when broker chose to express in $/ac).
  ppa_low: number | null;
  ppa_mid: number | null;
  ppa_high: number | null;
};

export type CmaPdfOpinion = {
  mode: OpinionMode;
  presentation: OpinionPresentation;

  // lump_sum mode
  total: number | null;

  // breakdown mode
  land_value: number | null;
  improvement_value: number | null;
  house_sqft: number | null;
  house_ppsf: number | null;
  additional_vertical: number | null;

  // "range" presentation mode override (broker-set low/high band)
  range_low: number | null;
  range_high: number | null;

  // suggested list price (defaults to total × 1.10)
  suggested_list_price: number | null;

  // broker's free-text rationale
  valuation_notes: string | null;
};

export type CmaPdfData = {
  cma_id: string;
  generated_at: string; // ISO

  broker: CmaPdfBroker;
  subject: CmaPdfSubject;
  comps: CmaPdfComp[];
  stats: CmaPdfStats;
  opinion: CmaPdfOpinion;

  // Pre-built mapbox static URLs (the PDF route generates them; the
  // Document just <Image>s them). NULL when the token isn't set or
  // generation failed.
  comp_map_url: string | null;
  subject_aerial_url: string | null;
};

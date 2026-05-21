// Texas land-broker regions for vault grouping.
//
// Brokers price land by REGION, not by alphabet — Hill Country values
// land differently than South Texas brush which values it differently
// than the Pineywoods. The vault's "By Region" view groups comps under
// regional headers (with aggregate stats) and sub-groups counties
// alphabetically within each region.
//
// ⚠️ COUNTY_TO_REGION IS INTENTIONALLY EMPTY ⚠️
//
// The user is providing the region taxonomy + county mapping
// separately. Until that data is filled in below, every county
// resolves to 'Unassigned' and the "By Region" view collapses to a
// single group. The toggle still works; the data just isn't
// populated.
//
// To populate:
//   1. Set REGION_ORDER to the user's preferred region names in
//      display order (top of vault → bottom).
//   2. Fill COUNTY_TO_REGION with `{ 'Atascosa': 'South Texas', … }`
//      mapping every county to one of the regions in REGION_ORDER.
//   3. Counties not in the map will continue to fall back to
//      'Unassigned' (safe default, surfaces missing-mapping problems
//      to the user without crashing the page).

/**
 * Display order for regions. The vault renders region groups top-down
 * in this order. Add region names here when the user provides their
 * taxonomy. Order can be alphabetical, geographic (north→south), or
 * any custom sequence — the array order is the display order.
 *
 * 'Unassigned' is the always-last fallback bucket for counties not
 * explicitly mapped. It's auto-appended at render time; do NOT
 * include it here.
 */
export const REGION_ORDER: ReadonlyArray<string> = [
  // Populate when user provides region list, e.g.:
  // 'Hill Country',
  // 'Post Oak Savannah',
  // 'South Texas',
  // 'Coastal',
  // 'Trans-Pecos',
  // 'Pineywoods',
  // 'Cross Timbers',
  // 'Blackland Prairie',
  // 'Rolling Plains',
  // 'High Plains',
];

/**
 * County → region mapping. Keys are county names as they appear in
 * comp.county (case-sensitive, no "County" suffix — e.g. "Atascosa"
 * not "Atascosa County"). Values must match an entry in REGION_ORDER.
 *
 * Multi-county comps (e.g. "Atascosa, Frio") are split upstream into
 * virtual rows, each with a single county — so each virtual row
 * resolves to its own region cleanly.
 */
export const COUNTY_TO_REGION: Readonly<Record<string, string>> = {
  // Populate when user provides mapping, e.g.:
  // 'Atascosa': 'South Texas',
  // 'Frio': 'South Texas',
  // 'Comal': 'Hill Country',
  // 'Blanco': 'Hill Country',
  // ...
};

/** Sentinel for counties not yet mapped. */
export const UNASSIGNED_REGION = 'Unassigned';

/**
 * Resolve a single county string to its region. Returns
 * UNASSIGNED_REGION when:
 *   - county is null/empty
 *   - county isn't in COUNTY_TO_REGION yet
 *
 * Normalizes the input (trim + strip "County" suffix) so callers can
 * pass raw comp.county values.
 */
export function getRegionForCounty(county: string | null | undefined): string {
  if (!county) return UNASSIGNED_REGION;
  const normalized = county.trim().replace(/\s+county$/i, '').trim();
  if (!normalized) return UNASSIGNED_REGION;
  return COUNTY_TO_REGION[normalized] ?? UNASSIGNED_REGION;
}

/**
 * Full ordered list of regions for the current data set. Returns
 * REGION_ORDER with UNASSIGNED_REGION appended at the end (only when
 * there are actually unassigned comps in the data set, so we don't
 * show an empty 'Unassigned' header for nothing).
 */
export function getRegionsInDisplayOrder(usedRegions: Set<string>): string[] {
  const order: string[] = REGION_ORDER.filter((r) => usedRegions.has(r));
  if (usedRegions.has(UNASSIGNED_REGION)) {
    order.push(UNASSIGNED_REGION);
  }
  return order;
}

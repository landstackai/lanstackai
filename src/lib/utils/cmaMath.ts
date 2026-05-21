// Compute CMA averages from live comp data, not from the saved
// snapshot. Earlier versions of saveCMA wrote ppa_low/mid/high +
// value_low/mid/high to the cmas row at save time — but those got
// stale if the comps state was incomplete at that moment, or if any
// referenced comp later had its PPA recomputed (sale_price /
// improvements_value changed). Brokers ended up seeing "$0 – $0
// (mid $0)" in the list view even though the workspace recomputed
// the right numbers live.
//
// This module is the single source of truth for CMA averages. Every
// surface (list view, workspace, printable report) should pass through
// the same helpers so they always agree.
//
// Three flavors of $/acre we surface, in display order:
//
//   1. TOTAL $/AC          sale_price / acres
//      "Comps trade at $X/ac" — the headline market signal.
//
//   2. LAND-ONLY $/AC      (sale_price - improvements_value) / acres
//      "What's the dirt worth, stripping improvements?"
//      Only counts comps where improvements_value is populated, so
//      sample sizes can differ from Total.
//
//   3. ADJUSTED $/AC       (sale_price - effective_improvement) / acres
//      Where effective_improvement = broker's per-comp override
//      (cma.comp_adjustments[id].improvement_value) if set,
//      else the comp's stored improvement_value (singular, broker-
//      tagged), else improvements_value (plural, appraiser-tagged).
//      "After my market read, here's what comps look like."

export type CmaComp = {
  id: string;
  acres: number | null;
  sale_price: number | null;
  improvements_value?: number | null;
  improvement_value?: number | null;
  improvement_source?: 'appraiser' | 'agent_verified' | 'broker_estimate' | null;
  // Needed for the Land-Only sample logic. Vacant comps (has_improvements
  // === false) contribute to Land-Only at their total $/Ac — they ARE
  // raw dirt. Without this flag, the helper has to exclude any comp
  // missing improvements_value and the sample size silently undercounts.
  has_improvements?: boolean | null;
};

export type CmaAdjustmentMap = Record<
  string,
  { improvement_value?: number | null; improvement_source?: 'appraiser' | 'agent_verified' | 'broker_estimate' | null }
> | null | undefined;

export type CmaAverages = {
  total: { low: number | null; mid: number | null; high: number | null; n: number };
  landOnly: { low: number | null; mid: number | null; high: number | null; n: number };
  adjusted: { low: number | null; mid: number | null; high: number | null; n: number };
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const totalPpa = (c: CmaComp): number | null => {
  const a = num(c.acres);
  const p = num(c.sale_price);
  if (a <= 0 || p <= 0) return null;
  return p / a;
};

const landOnlyPpa = (c: CmaComp): number | null => {
  const a = num(c.acres);
  const p = num(c.sale_price);
  if (a <= 0 || p <= 0) return null;
  const imp = c.improvements_value;
  if (imp != null) {
    // Improved comp with an itemized improvement value: back it out.
    const land = p - num(imp);
    return land > 0 ? land / a : null;
  }
  // No itemized improvement value. Two cases:
  //   (a) Vacant comp (has_improvements === false) → already raw dirt;
  //       its total $/Ac IS its land-only $/Ac. Include it.
  //   (b) Improved comp with no extracted improvement value
  //       (has_improvements === true with improvements_value null) →
  //       we genuinely don't know the dollar value of the structures,
  //       so we can't fairly back them out. Exclude.
  //   (c) Unknown (has_improvements null) → conservatively exclude.
  //       Most imports populate has_improvements, so this is rare.
  if (c.has_improvements === false) {
    return p / a;
  }
  return null;
};

const adjustedPpa = (c: CmaComp, adj: CmaAdjustmentMap): number | null => {
  const a = num(c.acres);
  const p = num(c.sale_price);
  if (a <= 0 || p <= 0) return null;
  // Resolution: per-CMA draft override > comp's saved improvement_value
  // (singular, broker provenance) > comp's improvements_value (plural,
  // appraisal extraction). Same precedence the map workspace uses.
  const override = adj?.[c.id]?.improvement_value;
  const eff =
    override != null ? num(override) :
    c.improvement_value != null ? num(c.improvement_value) :
    c.improvements_value != null ? num(c.improvements_value) :
    null;
  // Comps without any improvement signal STILL contribute to Adjusted —
  // we treat eff=0 (raw land has no adjustment to subtract). Distinct
  // from Land-Only above where we require improvements_value to be
  // present (signals "this is an improved comp; here's the dirt-only").
  const land = eff != null ? p - eff : p;
  return land > 0 ? land / a : null;
};

const stats = (values: number[]) => {
  const valid = values.filter((v) => Number.isFinite(v) && v > 0);
  if (valid.length === 0) {
    return { low: null, mid: null, high: null, n: 0 };
  }
  return {
    low: Math.min(...valid),
    mid: valid.reduce((s, v) => s + v, 0) / valid.length,
    high: Math.max(...valid),
    n: valid.length,
  };
};

/**
 * Compute all three averages for a CMA from its live comp list.
 *
 * @param comps   The comp records referenced by the CMA's
 *                `selected_comp_ids`. Pre-filter callers — this helper
 *                doesn't do the lookup itself so it stays sync + cheap.
 * @param adj     The CMA's `comp_adjustments` map (per-comp broker
 *                overrides). Pass null/undefined when not relevant.
 */
export function computeCmaAverages(
  comps: CmaComp[],
  adj?: CmaAdjustmentMap
): CmaAverages {
  return {
    total: stats(comps.map(totalPpa).filter((v): v is number => v != null)),
    landOnly: stats(comps.map(landOnlyPpa).filter((v): v is number => v != null)),
    adjusted: stats(comps.map((c) => adjustedPpa(c, adj)).filter((v): v is number => v != null)),
  };
}

/**
 * Multiply each average by `subjectAcres` to get subject-property
 * totals. Returns nulls where the corresponding average is null —
 * we never fabricate a "$0" number when there's no data behind it.
 */
export function subjectTotals(avg: CmaAverages, subjectAcres: number) {
  const apply = (v: number | null) =>
    v != null && Number.isFinite(subjectAcres) && subjectAcres > 0
      ? v * subjectAcres
      : null;
  return {
    total: { low: apply(avg.total.low), mid: apply(avg.total.mid), high: apply(avg.total.high) },
    landOnly: { low: apply(avg.landOnly.low), mid: apply(avg.landOnly.mid), high: apply(avg.landOnly.high) },
    adjusted: { low: apply(avg.adjusted.low), mid: apply(avg.adjusted.mid), high: apply(avg.adjusted.high) },
  };
}

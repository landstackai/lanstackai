// Shared CmaPdfData assembly — used by both the broker-authenticated
// PDF route (/api/cma/[id]/pdf) and the public share-token PDF route
// (/api/share/[token]/pdf). Each route handles its own auth + data
// fetch, then hands the raw rows to this helper which:
//
//   1. Reorders comps to match cma.selected_comp_ids
//   2. Computes three-view stats (Total / Land-Only / Adjusted) via
//      computeCmaAverages + subjectTotals from cmaMath.ts
//   3. Resolves the "active mid" $/Ac that the OOV reveal falls back
//      to when broker_opinion is null (prefers Adjusted)
//   4. Builds Mapbox static URLs for cover hero + annotated comp map
//   5. Converts each comp into the PDF-shape with per-row Total +
//      Adjusted $/Ac pre-computed
//   6. Assembles the final CmaPdfData hand-off

import {
  computeCmaAverages,
  subjectTotals,
} from '@/lib/utils/cmaMath';
import { buildCoverAerial, buildCompMapUrl } from '@/lib/pdf/mapbox';
import type {
  CmaPdfData,
  CmaPdfComp,
  CmaPdfStats,
  CmaPdfBroker,
  CmaPdfSubject,
  CmaPdfOpinion,
} from '@/lib/pdf/types';

export type BuildPdfDataInput = {
  cmaId: string;
  cma: any;
  comps: any[];
  broker: CmaPdfBroker;
};

export function buildPdfData(input: BuildPdfDataInput): CmaPdfData {
  const { cmaId, cma, comps: rawComps, broker } = input;

  // 1. Reorder comps to match selected_comp_ids — keeps row numbers
  // in the PDF table consistent with what the broker saw in the
  // workspace.
  const selectedIds: string[] = Array.isArray(cma.selected_comp_ids)
    ? cma.selected_comp_ids
    : [];
  const compsById = new Map(rawComps.map((c) => [c.id, c]));
  const comps =
    selectedIds.length > 0
      ? selectedIds.map((id) => compsById.get(id)).filter(Boolean)
      : rawComps;

  // 2. Three-view stats from the same helper the workspace + share
  // report use. Pass cma.comp_adjustments for per-comp broker
  // improvement overrides.
  const compAdjustments = cma.comp_adjustments || {};
  const subjectAcres = cma.subject_acres != null ? Number(cma.subject_acres) : null;
  const stats = computeStats(comps, compAdjustments, subjectAcres);

  // 3. Build PDF subject
  const subject: CmaPdfSubject = {
    name: cma.subject_name ?? null,
    county: cma.subject_county ?? null,
    state: cma.subject_state ?? null,
    acres: subjectAcres,
    address: cma.subject_address ?? null,
    description: cma.subject_description ?? null,
    latitude: cma.subject_latitude != null ? Number(cma.subject_latitude) : null,
    longitude: cma.subject_longitude != null ? Number(cma.subject_longitude) : null,
    boundary_geojson: cma.subject_boundary_geojson ?? null,
    overview_prose: cma.subject_overview_prose ?? null,
    cover_image_url: cma.pdf_cover_image_url ?? null,
  };

  // 4. Build PDF opinion
  const opinion: CmaPdfOpinion = {
    mode: (cma.broker_opinion_mode as any) ?? null,
    presentation: (cma.opinion_presentation as any) ?? null,
    total: cma.broker_opinion_value != null ? Number(cma.broker_opinion_value) : null,
    land_value:
      cma.broker_opinion_land_value != null ? Number(cma.broker_opinion_land_value) : null,
    improvement_value:
      cma.broker_opinion_improvement_value != null
        ? Number(cma.broker_opinion_improvement_value)
        : null,
    house_sqft:
      cma.broker_opinion_house_sqft != null ? Number(cma.broker_opinion_house_sqft) : null,
    house_ppsf:
      cma.broker_opinion_house_ppsf != null ? Number(cma.broker_opinion_house_ppsf) : null,
    additional_vertical:
      cma.broker_opinion_additional_vertical != null
        ? Number(cma.broker_opinion_additional_vertical)
        : null,
    range_low: null,
    range_high: null,
    suggested_list_price:
      cma.suggested_list_price != null ? Number(cma.suggested_list_price) : null,
    valuation_notes: cma.valuation_notes ?? null,
  };

  // 5. Mapbox URLs
  const compCoords = comps.map((c: any) => ({
    latitude: c.latitude != null ? Number(c.latitude) : null,
    longitude: c.longitude != null ? Number(c.longitude) : null,
  }));
  const subject_aerial_url = buildCoverAerial(subject);
  const comp_map_url = buildCompMapUrl(subject, compCoords);

  // 6. Per-comp PDF shape — including Total + Adjusted PPA using
  // the same resolution as cmaMath.ts adjustedPpa()
  const pdfComps: CmaPdfComp[] = comps.map((c: any) => {
    const acresN = c.acres != null ? Number(c.acres) : null;
    const saleN = c.sale_price != null ? Number(c.sale_price) : null;

    const adj = compAdjustments?.[c.id] || {};
    const effImp =
      adj.improvement_value != null
        ? Number(adj.improvement_value)
        : c.improvement_value != null
        ? Number(c.improvement_value)
        : c.improvements_value != null
        ? Number(c.improvements_value)
        : null;

    const total_ppa =
      acresN != null && saleN != null && acresN > 0 && saleN > 0
        ? saleN / acresN
        : null;
    const adjusted_ppa =
      acresN != null && saleN != null && acresN > 0 && saleN > 0
        ? (() => {
            const eff = effImp ?? 0;
            const land = saleN - eff;
            return land > 0 ? land / acresN : null;
          })()
        : null;

    return {
      id: c.id,
      property_name: c.property_name ?? null,
      address: c.address ?? null,
      city: c.city ?? null,
      county: c.county ?? null,
      state: c.state ?? null,
      acres: acresN,
      sale_price: saleN,
      sale_date: c.sale_date ?? null,
      price_per_acre: c.price_per_acre != null ? Number(c.price_per_acre) : null,
      ppa_land_only: c.ppa_land_only != null ? Number(c.ppa_land_only) : null,
      improvements_value:
        c.improvements_value != null ? Number(c.improvements_value) : null,
      computed_total_ppa: total_ppa,
      computed_adjusted_ppa: adjusted_ppa,
      effective_improvement: effImp,
      latitude: c.latitude != null ? Number(c.latitude) : null,
      longitude: c.longitude != null ? Number(c.longitude) : null,
      aerial_image: c.aerial_image ?? null,
      listing_thumbnail: c.listing_thumbnail ?? null,
      source_url: c.source_url ?? null,
      status: c.status ?? null,
      water: c.water ?? null,
      road_frontage: c.road_frontage ?? null,
      dev_potential: c.dev_potential ?? null,
      best_use: Array.isArray(c.best_use) ? c.best_use : null,
      topography: c.topography ?? null,
      has_improvements: c.has_improvements ?? null,
      use_land_only_for_cma: c.use_land_only_for_cma ?? null,
      notes: c.improvements_notes ?? null,
    };
  });

  return {
    cma_id: cmaId,
    generated_at: new Date().toISOString(),
    broker,
    subject,
    comps: pdfComps,
    stats,
    opinion,
    comp_map_url,
    subject_aerial_url,
  };
}

// ── computeStats helper ────────────────────────────────────────────

function computeStats(
  comps: any[],
  compAdjustments: any,
  subjectAcres: number | null
): CmaPdfStats {
  const avgs = computeCmaAverages(comps as any, compAdjustments);
  const acres = subjectAcres ?? 0;
  const totals = subjectTotals(avgs, acres);

  // Active mid — prefers Adjusted (broker-considered view) over Total
  const usingAdjusted = avgs.adjusted.n > 0;
  const active_mid_ppa = usingAdjusted ? avgs.adjusted.mid : avgs.total.mid;
  const active_mid_value =
    active_mid_ppa != null && acres > 0 ? active_mid_ppa * acres : null;

  return {
    count: comps.length,
    total: avgs.total,
    landOnly: avgs.landOnly,
    adjusted: avgs.adjusted,
    totals_total: totals.total,
    totals_landOnly: totals.landOnly,
    totals_adjusted: totals.adjusted,
    active_mid_ppa,
    active_mid_value,
    // Legacy aliases for the OOV hero fallback chain.
    value_low: totals.adjusted.low ?? totals.total.low,
    value_mid: active_mid_value,
    value_high: totals.adjusted.high ?? totals.total.high,
    ppa_low: avgs.adjusted.low ?? avgs.total.low,
    ppa_mid: active_mid_ppa,
    ppa_high: avgs.adjusted.high ?? avgs.total.high,
  };
}

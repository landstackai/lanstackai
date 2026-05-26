import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import React from 'react';
import { createClient as createServerSupabase } from '@/lib/supabase/server';
import { MarketingCMAPdf } from '@/lib/pdf/MarketingCMAPdf';
import { buildCoverAerial, buildCompMapUrl } from '@/lib/pdf/mapbox';
import type {
  CmaPdfData,
  CmaPdfComp,
  CmaPdfStats,
  CmaPdfBroker,
  CmaPdfSubject,
  CmaPdfOpinion,
} from '@/lib/pdf/types';

// GET /api/cma/[id]/pdf
//
// Renders the marketing-grade CMA PDF for the given CMA id. Returns
// application/pdf with a sensible filename so the browser saves it
// nicely.
//
// Flow:
//   1. Auth check — implicit via Supabase server client + RLS
//   2. Fetch cmas row (full record — RLS scopes to creator/team)
//   3. Fetch comps in selected_comp_ids
//   4. Fetch broker profile (full_name, brokerage_name, email, phone)
//   5. Compute stats (avg/median/min/max $/Ac across comps)
//   6. Build Mapbox static URLs (cover aerial + annotated comp map)
//   7. Hand the assembled CmaPdfData to <MarketingCMAPdf> and render
//      to a buffer via @react-pdf/renderer
//   8. Return as application/pdf with Content-Disposition: attachment
//
// Runtime: nodejs (NOT edge) — react-pdf relies on Node-only APIs
// (pdfkit underneath). maxDuration: 60s — react-pdf cold start +
// font registration + Mapbox image fetch can take 10-20s; 60s gives
// headroom on slow Vercel cold starts.
//
// Filename: "Landstack CMA - <Subject Name> - <YYYY-MM-DD>.pdf",
// sanitized to a filesystem-safe form.

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'cma id required' }, { status: 400 });
  }

  const supabase = createServerSupabase();

  // 1. Fetch CMA. RLS ensures the requester actually has access.
  const { data: cma, error: cmaErr } = await supabase
    .from('cmas')
    .select('*')
    .eq('id', id)
    .single();

  if (cmaErr || !cma) {
    return NextResponse.json(
      { error: 'CMA not found or you do not have access', detail: cmaErr?.message },
      { status: 404 }
    );
  }

  // 2. Fetch comps in selected_comp_ids
  const selectedIds: string[] = Array.isArray(cma.selected_comp_ids) ? cma.selected_comp_ids : [];
  let comps: any[] = [];
  if (selectedIds.length > 0) {
    const { data: compData } = await supabase
      .from('comps')
      .select('*')
      .in('id', selectedIds);
    if (compData) comps = compData;
  }

  // Preserve the order the broker selected so row numbers in the PDF
  // table match what they see in the workspace.
  comps = selectedIds
    .map((id) => comps.find((c) => c.id === id))
    .filter(Boolean);

  // 3. Broker profile. Public columns only; phone/email may be
  // present if the requester is the owner.
  let broker: CmaPdfBroker = {
    full_name: null,
    brokerage_name: null,
    email: null,
    phone: null,
  };
  if (cma.created_by) {
    const { data: prof } = await supabase
      .from('profiles')
      .select('full_name, brokerage_name, email, phone')
      .eq('id', cma.created_by)
      .maybeSingle();
    if (prof) {
      broker = {
        full_name: prof.full_name ?? null,
        brokerage_name: prof.brokerage_name ?? null,
        email: (prof as any).email ?? null,
        phone: (prof as any).phone ?? null,
      };
    }
  }

  // 4. Compute stats from comps
  const stats = computeStats(comps, Number(cma.subject_acres) || null);

  // 5. Build PDF subject
  const subject: CmaPdfSubject = {
    name: cma.subject_name ?? null,
    county: cma.subject_county ?? null,
    state: cma.subject_state ?? null,
    acres: cma.subject_acres != null ? Number(cma.subject_acres) : null,
    address: cma.subject_address ?? null,
    description: cma.subject_description ?? null,
    latitude: cma.subject_latitude != null ? Number(cma.subject_latitude) : null,
    longitude: cma.subject_longitude != null ? Number(cma.subject_longitude) : null,
    boundary_geojson: cma.subject_boundary_geojson ?? null,
    overview_prose: cma.subject_overview_prose ?? null,
    cover_image_url: cma.pdf_cover_image_url ?? null,
  };

  // 6. Build PDF opinion
  const opinion: CmaPdfOpinion = {
    mode: (cma.broker_opinion_mode as any) ?? null,
    presentation: (cma.opinion_presentation as any) ?? null,
    total: cma.broker_opinion_value != null ? Number(cma.broker_opinion_value) : null,
    land_value: cma.broker_opinion_land_value != null ? Number(cma.broker_opinion_land_value) : null,
    improvement_value:
      cma.broker_opinion_improvement_value != null
        ? Number(cma.broker_opinion_improvement_value)
        : null,
    house_sqft: cma.broker_opinion_house_sqft != null ? Number(cma.broker_opinion_house_sqft) : null,
    house_ppsf: cma.broker_opinion_house_ppsf != null ? Number(cma.broker_opinion_house_ppsf) : null,
    additional_vertical:
      cma.broker_opinion_additional_vertical != null
        ? Number(cma.broker_opinion_additional_vertical)
        : null,
    // V1: range_low / range_high columns don't exist yet — we'll
    // derive from the comp set when in range mode. Add explicit
    // columns in a future migration if brokers want to override.
    range_low: null,
    range_high: null,
    suggested_list_price:
      cma.suggested_list_price != null ? Number(cma.suggested_list_price) : null,
    valuation_notes: cma.valuation_notes ?? null,
  };

  // 7. Map URLs
  const compCoords = comps.map((c) => ({
    latitude: c.latitude != null ? Number(c.latitude) : null,
    longitude: c.longitude != null ? Number(c.longitude) : null,
  }));
  const subject_aerial_url = buildCoverAerial(subject);
  const comp_map_url = buildCompMapUrl(subject, compCoords);

  // 8. Convert comps to PDF shape
  const pdfComps: CmaPdfComp[] = comps.map((c) => ({
    id: c.id,
    property_name: c.property_name ?? null,
    address: c.address ?? null,
    city: c.city ?? null,
    county: c.county ?? null,
    state: c.state ?? null,
    acres: c.acres != null ? Number(c.acres) : null,
    sale_price: c.sale_price != null ? Number(c.sale_price) : null,
    sale_date: c.sale_date ?? null,
    price_per_acre: c.price_per_acre != null ? Number(c.price_per_acre) : null,
    ppa_land_only: c.ppa_land_only != null ? Number(c.ppa_land_only) : null,
    improvements_value: c.improvements_value != null ? Number(c.improvements_value) : null,
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
  }));

  // 9. Final PDF data
  const pdfData: CmaPdfData = {
    cma_id: id,
    generated_at: new Date().toISOString(),
    broker,
    subject,
    comps: pdfComps,
    stats,
    opinion,
    comp_map_url,
    subject_aerial_url,
  };

  // 10. Render to buffer
  try {
    // react-pdf's renderToBuffer takes a ReactElement<DocumentProps>.
    // MarketingCMAPdf returns a <Document> but TypeScript doesn't
    // infer that from the prop signature, so we cast through `any`
    // at the call site.
    const element = React.createElement(MarketingCMAPdf, { data: pdfData });
    const buffer = await renderToBuffer(element as any);

    const filename = buildFilename(subject.name, pdfData.generated_at);

    // NextResponse body typing in Next 14 doesn't accept Node Buffer
    // directly even though it works at runtime. Cast to BodyInit-
    // compatible Uint8Array via `as any` — this is the standard
    // workaround in Next 14 PDF/binary-response patterns.
    return new NextResponse(buffer as any, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, private',
      },
    });
  } catch (e: any) {
    // Surface the full error in the Vercel function logs AND include
    // the stack in the JSON response so the workspace toast can show
    // the actual cause (not just "PDF render failed"). The detail is
    // safe to expose — this endpoint is auth-gated by RLS.
    console.error('[pdf] render failed', {
      message: e?.message,
      name: e?.name,
      stack: e?.stack,
      cma_id: id,
    });
    return NextResponse.json(
      {
        error: 'PDF render failed',
        detail: e?.message || 'unknown error',
        name: e?.name || null,
      },
      { status: 500 }
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Compute aggregate $/Ac and dollar value stats across the comp set.
 * Prefers ppa_land_only (broker-verified, improvements stripped) over
 * raw price_per_acre — matches the workspace math (cmaMath.ts).
 */
function computeStats(comps: any[], subjectAcres: number | null): CmaPdfStats {
  const ppas: number[] = [];
  for (const c of comps) {
    const ppa = (c.ppa_land_only != null ? Number(c.ppa_land_only) : null) ??
                (c.price_per_acre != null ? Number(c.price_per_acre) : null);
    if (ppa != null && Number.isFinite(ppa) && ppa > 0) ppas.push(ppa);
  }

  if (ppas.length === 0) {
    return {
      count: comps.length,
      avg_ppa: null,
      median_ppa: null,
      min_ppa: null,
      max_ppa: null,
      value_low: null,
      value_mid: null,
      value_high: null,
      ppa_low: null,
      ppa_mid: null,
      ppa_high: null,
    };
  }

  const sorted = [...ppas].sort((a, b) => a - b);
  const avg = ppas.reduce((s, n) => s + n, 0) / ppas.length;
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  const acres = subjectAcres ?? 0;

  return {
    count: comps.length,
    avg_ppa: avg,
    median_ppa: median,
    min_ppa: min,
    max_ppa: max,
    value_low: acres > 0 ? min * acres : null,
    value_mid: acres > 0 ? median * acres : null,
    value_high: acres > 0 ? max * acres : null,
    ppa_low: min,
    ppa_mid: median,
    ppa_high: max,
  };
}

/**
 * Build a filename like:
 *   "Landstack CMA - Caraway Ranch - 2026-05-26.pdf"
 * with characters that would confuse Content-Disposition stripped.
 */
function buildFilename(subjectName: string | null, isoDate: string): string {
  const name = (subjectName || 'Subject Property')
    .replace(/[\\/:*?"<>|]/g, '')   // FS-illegal chars
    .replace(/[\r\n]/g, ' ')
    .slice(0, 60)
    .trim();
  const date = isoDate.slice(0, 10); // YYYY-MM-DD
  return `Landstack CMA - ${name} - ${date}.pdf`;
}

import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import React from 'react';
import { createClient as createServerSupabase } from '@/lib/supabase/server';
import { MarketingCMAPdf } from '@/lib/pdf/MarketingCMAPdf';
import { buildPdfData } from '@/lib/pdf/buildPdfData';
import type { CmaPdfBroker } from '@/lib/pdf/types';

// GET /api/cma/[id]/pdf
//
// Renders the marketing-grade CMA PDF for the given CMA id. Returns
// application/pdf with a sensible filename so the browser saves it
// nicely.
//
// AUTH: This route is broker-authenticated via Supabase RLS — only
// the broker who created the CMA (or a teammate via team policies)
// can hit it successfully. Includes broker email + phone in the
// rendered PDF.
//
// For the public/client-facing PDF download (no auth, scoped by
// share_token), see /api/share/[token]/pdf — same renderer, different
// data fetch + a slimmer broker block.
//
// Runtime: nodejs (NOT edge) — react-pdf relies on Node-only APIs.
// maxDuration: 60s headroom for cold starts + Mapbox image load.

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

  // 3. Broker profile — full contact info (email/phone visible to the
  // broker themselves under RLS).
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

  // 4. Assemble CmaPdfData via shared helper.
  const pdfData = buildPdfData({ cmaId: id, cma, comps, broker });

  // Debug bypass: ?debug=1 returns the JSON diagnostic instead of the
  // PDF binary. Lets us see exactly which comps reached the renderer
  // and what coords they carry. Remove once pin-loss issue is settled.
  const url = new URL(_req.url);
  if (url.searchParams.get('debug') === '1') {
    return NextResponse.json({
      cma_id: id,
      selected_comp_ids_count: selectedIds.length,
      selected_comp_ids: selectedIds,
      comps_returned_by_fetch: comps.length,
      comp_ids_returned: comps.map((c: any) => c.id),
      comps_in_pdf_data: pdfData.comps.length,
      comp_map_url_length: pdfData.comp_map_url?.length || 0,
      comp_map_url: pdfData.comp_map_url,
      pin_coords: pdfData.comps.map((c: any, i: number) => ({
        position: i + 1,
        property_name: c.property_name,
        county: c.county,
        latitude: c.latitude,
        longitude: c.longitude,
        latitude_isFinite: Number.isFinite(c.latitude),
        longitude_isFinite: Number.isFinite(c.longitude),
      })),
    }, { status: 200 });
  }

  // 5. Render to buffer
  try {
    const element = React.createElement(MarketingCMAPdf, { data: pdfData });
    const buffer = await renderToBuffer(element as any);

    const filename = buildFilename(pdfData.subject.name, pdfData.generated_at);

    return new NextResponse(buffer as any, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, private',
      },
    });
  } catch (e: any) {
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

/**
 * Build a filename like:
 *   "Landstack CMA - Caraway Ranch - 2026-05-26.pdf"
 * with characters that would confuse Content-Disposition stripped.
 */
function buildFilename(subjectName: string | null, isoDate: string): string {
  const name = (subjectName || 'Subject Property')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 60)
    .trim();
  const date = isoDate.slice(0, 10);
  return `Landstack CMA - ${name} - ${date}.pdf`;
}

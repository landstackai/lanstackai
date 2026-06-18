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

  // 3. Broker profile + team — the report is co-branded:
  //   • Agent-level fields (full_name, title, license_number, email, phone)
  //     come from the profile of whoever created the CMA. These appear in
  //     the "Prepared by" block on the cover + the footer.
  //   • Brokerage-level fields (name, logo, address, phone, website,
  //     license_number) come from that profile's team (if linked). These
  //     anchor the brand presence on the cover. When a broker isn't on a
  //     team (solo accounts), the brokerage block degrades gracefully —
  //     only the agent's contact info renders.
  let broker: CmaPdfBroker = {
    full_name: null,
    title: null,
    license_number: null,
    email: null,
    phone: null,
    brokerage_name: null,
    brokerage_logo_url: null,
    brokerage_address: null,
    brokerage_city_state_zip: null,
    brokerage_phone: null,
    brokerage_website: null,
    brokerage_license_number: null,
  };
  if (cma.created_by) {
    const { data: prof } = await supabase
      .from('profiles')
      .select(
        'full_name, brokerage_name, email, phone, title, license_number, team_id',
      )
      .eq('id', cma.created_by)
      .maybeSingle();
    if (prof) {
      broker.full_name = prof.full_name ?? null;
      broker.title = (prof as any).title ?? null;
      broker.license_number = (prof as any).license_number ?? null;
      broker.email = (prof as any).email ?? null;
      broker.phone = prof.phone ?? null;
      // Legacy brokerage_name on profiles kept as a fallback for solo
      // users who set it before the teams table existed.
      broker.brokerage_name = prof.brokerage_name ?? null;

      // Pull team-level branding when the profile is linked to a team.
      const teamId = (prof as any).team_id as string | null | undefined;
      if (teamId) {
        const { data: team } = await supabase
          .from('teams')
          .select(
            'name, logo_url, address, suite, city, state, zip, phone, website, license_number',
          )
          .eq('id', teamId)
          .maybeSingle();
        if (team) {
          // Team name beats the legacy profile.brokerage_name when present.
          broker.brokerage_name = (team as any).name ?? broker.brokerage_name;
          broker.brokerage_logo_url = (team as any).logo_url ?? null;
          broker.brokerage_phone = (team as any).phone ?? null;
          broker.brokerage_website = (team as any).website ?? null;
          broker.brokerage_license_number = (team as any).license_number ?? null;
          // Compose address into the two display lines the cover renders.
          // Line 1: "<street>, <suite>" (suite optional).
          // Line 2: "<city>, <state> <zip>" (all-or-nothing — partial address
          // looks broken on a report cover).
          const street = (team as any).address as string | null;
          const suite = (team as any).suite as string | null;
          const city = (team as any).city as string | null;
          const state = (team as any).state as string | null;
          const zip = (team as any).zip as string | null;
          broker.brokerage_address =
            street ? [street, suite].filter(Boolean).join(', ') : null;
          broker.brokerage_city_state_zip =
            city && state && zip ? `${city}, ${state} ${zip}` : null;
        }
      }
    }
  }

  // 4. Assemble CmaPdfData via shared helper.
  const pdfData = buildPdfData({ cmaId: id, cma, comps, broker });

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

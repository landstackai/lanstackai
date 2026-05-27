import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import React from 'react';
import { createClient } from '@supabase/supabase-js';
import { MarketingCMAPdf } from '@/lib/pdf/MarketingCMAPdf';
import { buildPdfData } from '@/lib/pdf/buildPdfData';
import type { CmaPdfBroker } from '@/lib/pdf/types';

// GET /api/share/[token]/pdf
//
// Public PDF download for a shared CMA. The client (unauthenticated)
// hits this route from the share report page — same PDF the broker
// gets, with one difference: email + phone are NOT included in the
// broker block (RLS on profiles only exposes id, full_name,
// brokerage_name to anon per migration 009).
//
// Security model:
//   - share_token is the only credential; 32-byte random + RLS-scoped
//     row-level access (migration 008)
//   - share_expires_at acts as a hard expiry — RLS blocks anon SELECT
//     once it passes
//   - Anyone with the share URL can download the PDF, by design
//     (mirrors the share report itself)
//
// Same renderer + same shape as /api/cma/[id]/pdf — both routes
// delegate the CmaPdfData assembly to buildPdfData(). Only the data
// fetch differs.
//
// Runtime: nodejs. maxDuration: 60s.

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!token) {
    return NextResponse.json({ error: 'share token required' }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Try the new publishable key first (matches the rest of the codebase),
  // fall back to NEXT_PUBLIC_SUPABASE_ANON_KEY for backward compat.
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Anonymous client. RLS (migrations 008 + 009) gates everything:
  //   - cmas SELECT is allowed only when share_token matches AND
  //     share_expires_at hasn't passed
  //   - comps SELECT is allowed only when the comp id appears in
  //     any non-expired shared CMA's selected_comp_ids
  //   - profiles SELECT is column-restricted to (id, full_name,
  //     brokerage_name) for anon
  const supabase = createClient(supabaseUrl, anonKey);

  // 1. Fetch CMA by share_token. If RLS blocks it (expired share, or
  // token doesn't exist), .single() returns null + error.
  const { data: cma, error: cmaErr } = await supabase
    .from('cmas')
    .select('*')
    .eq('share_token', token)
    .single();

  if (cmaErr || !cma) {
    return NextResponse.json(
      {
        error: 'Share link not found or expired',
        detail: cmaErr?.message,
      },
      { status: 404 }
    );
  }

  // 2. Fetch the selected comps
  const selectedIds: string[] = Array.isArray(cma.selected_comp_ids)
    ? cma.selected_comp_ids
    : [];
  let comps: any[] = [];
  if (selectedIds.length > 0) {
    const { data: compData } = await supabase
      .from('comps')
      .select('*')
      .in('id', selectedIds);
    if (compData) comps = compData;
  }

  // 3. Broker profile — anon can only see id + full_name +
  // brokerage_name. Email and phone are intentionally left null on
  // the share PDF; the client already has the broker's contact
  // through the existing relationship.
  let broker: CmaPdfBroker = {
    full_name: null,
    brokerage_name: null,
    email: null,
    phone: null,
  };
  if (cma.created_by) {
    const { data: prof } = await supabase
      .from('profiles')
      .select('id, full_name, brokerage_name')
      .eq('id', cma.created_by)
      .maybeSingle();
    if (prof) {
      broker = {
        full_name: prof.full_name ?? null,
        brokerage_name: prof.brokerage_name ?? null,
        email: null, // not exposed to anon
        phone: null, // not exposed to anon
      };
    }
  }

  // 4. Assemble CmaPdfData via shared helper.
  const pdfData = buildPdfData({ cmaId: cma.id, cma, comps, broker });

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
        // Allow client browsers to cache for a short window. The
        // underlying CMA could be edited by the broker, so we keep
        // the TTL short — a fresh download always picks up the
        // latest data.
        'Cache-Control': 'public, max-age=300, must-revalidate',
      },
    });
  } catch (e: any) {
    console.error('[share pdf] render failed', {
      message: e?.message,
      name: e?.name,
      stack: e?.stack,
      share_token: token,
    });
    return NextResponse.json(
      {
        error: 'PDF render failed',
        detail: e?.message || 'unknown error',
      },
      { status: 500 }
    );
  }
}

function buildFilename(subjectName: string | null, isoDate: string): string {
  const name = (subjectName || 'Subject Property')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 60)
    .trim();
  const date = isoDate.slice(0, 10);
  return `Landstack CMA - ${name} - ${date}.pdf`;
}

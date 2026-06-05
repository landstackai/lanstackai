'use client';

// Vision-based comp boundary detection (replaces / augments regex-based
// pdfBoundaryDetection.ts).
//
// Calls the /api/classify-pdf-pages endpoint with per-page images, then
// builds the same CompMap shape that extractFromBoundaryMap expects.
// Drop-in compatible — the import flow can call this first, fall back to
// regex detection if vision fails, fall back to chunked AI extraction if
// both fail.
//
// Why this exists: regex-based boundary detection fails on the most
// common reason a PDF "looks fine to a human but the system can't parse
// it" — rasterized header graphics. Stylized "Land Sale 1" headings are
// often embedded as part of an image, not as live text. pdf.js sees no
// "Land Sale 1" string to match, so regex falls back to AI extraction
// with all its known fragility. Vision classification reads the page the
// way a human does: it can SEE "Land Sale 1" on the page regardless of
// whether the underlying PDF stream has it as text or as a graphic.

import type { CompMap, CompBoundary } from './pdfBoundaryDetection';

interface PageClassification {
  page: number;
  role: 'cover' | 'subject_property' | 'comp_id_page' | 'comp_continuation' | 'summary' | 'other';
  comp_index: number | null;
  comp_label: string | null;
  evidence: string;
}

/**
 * Classify each page image via the vision endpoint and assemble a CompMap.
 *
 * Returns null when classification doesn't find at least 2 comps — the
 * caller should fall back to the legacy chunked path (which can still
 * extract single-comp PDFs and MLS sheets).
 *
 * Why ≥2 comps: a single-comp document doesn't need boundary detection;
 * the legacy path handles it cleanly. Vision classification on 1 comp
 * would just be paying for an extra API call with no benefit.
 */
export async function detectCompBoundariesViaVision(
  images: string[],
): Promise<CompMap | null> {
  if (!images.length) return null;

  let pages: PageClassification[] = [];
  try {
    const res = await fetch('/api/classify-pdf-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images }),
    });
    if (!res.ok) {
      console.warn(`[vision-boundary] classifier HTTP ${res.status}, falling back`);
      return null;
    }
    const data = await res.json();
    pages = Array.isArray(data?.pages) ? data.pages : [];
  } catch (err: any) {
    console.warn('[vision-boundary] classifier call threw:', err?.message);
    return null;
  }

  if (pages.length === 0) return null;

  console.log(`[vision-boundary] classified ${pages.length} pages:`);
  for (const p of pages) {
    console.log(
      `[vision-boundary]   page ${p.page}: ${p.role}` +
      (p.comp_index != null ? ` (comp ${p.comp_index})` : '') +
      (p.comp_label ? ` "${p.comp_label}"` : '') +
      ` — ${p.evidence}`
    );
  }

  // Group consecutive pages by comp_index. Each group becomes one CompBoundary.
  // Pages without a comp_index (cover, subject, summary, other) become
  // unassignedPages. The first comp_id_page in each group provides the
  // label; comp_continuation pages inherit it.
  const groupsByIndex = new Map<number, PageClassification[]>();
  const unassigned: number[] = [];

  for (const p of pages) {
    if (p.comp_index == null || (p.role !== 'comp_id_page' && p.role !== 'comp_continuation')) {
      unassigned.push(p.page);
      continue;
    }
    if (!groupsByIndex.has(p.comp_index)) groupsByIndex.set(p.comp_index, []);
    groupsByIndex.get(p.comp_index)!.push(p);
  }

  // Need ≥2 comps to justify the vision-based path. Single-comp documents
  // pass through to the legacy single-shot extractor (which already works
  // and has no cross-attribution bug since there's only one comp).
  if (groupsByIndex.size < 2) {
    console.log(
      `[vision-boundary] only ${groupsByIndex.size} comp(s) detected — falling back`
    );
    return null;
  }

  // Build CompBoundary list, sorted by comp_index ascending so display order
  // matches document order.
  const sortedIndices = Array.from(groupsByIndex.keys()).sort((a, b) => a - b);
  const comps: CompBoundary[] = sortedIndices.map((idx) => {
    const group = groupsByIndex.get(idx)!.sort((a, b) => a.page - b.page);
    const idPage = group.find((p) => p.role === 'comp_id_page') ?? group[0];
    const label = idPage.comp_label || `Comp ${idx}`;
    return {
      index: idx,
      label,
      // Vision classifier doesn't surface a printed "Sale ID" the way the
      // regex extractor did — null is fine, downstream code treats it as
      // optional metadata.
      saleId: null,
      pages: group.map((p) => p.page),
      // We trust the vision classifier with high confidence — it's much
      // more reliable than the regex path. If accuracy slips in
      // production we can downgrade.
      confidence: 'high',
      evidence: idPage.evidence || `vision: ${idPage.role}`,
    };
  });

  const allHigh = comps.every((c) => c.confidence === 'high');

  return {
    totalPages: pages.length,
    comps,
    overallConfidence: allHigh ? 'high' : 'medium',
    unassignedPages: unassigned.sort((a, b) => a - b),
  };
}

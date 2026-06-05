'use client';

// Vision-based comp boundary detection.
//
// Renders dedicated low-resolution page images SEPARATE from the
// extraction images (which run at higher resolution for downstream
// AI extraction). Reasoning:
//   • Boundary detection only needs to see headers + page structure
//     — 'high'-detail OpenAI vision on a 700×900 page image is plenty.
//   • Keeping classifier images low-res keeps the request body well
//     under Vercel's 4.5MB serverless limit (10 pages × ~80KB = 800KB).
//   • Extraction images stay at full resolution because downstream
//     AI calls need to read small table values, lat/lng coordinates,
//     etc.
//
// One batched POST to /api/classify-pdf-pages returns one
// classification per page. We assemble those into the CompMap shape
// that extractFromBoundaryMap already consumes — drop-in compatible
// with the existing pipeline.

import type { CompMap, CompBoundary } from './pdfBoundaryDetection';
import { pdfToImages } from './pdfToImages';

interface PageClassification {
  page: number;
  role:
    | 'cover'
    | 'subject_property'
    | 'comp_id_page'
    | 'comp_continuation'
    | 'summary'
    | 'other';
  comp_index: number | null;
  comp_label: string | null;
  evidence: string;
}

// Resolution choice for classifier images. EMPIRICALLY DETERMINED:
//
//   • scale 0.5 (306×396 on letter-size) → vision misclassifies EVERY
//     page. The "Land Sale 1" header is too small for the model to read
//     reliably, and the model defaults to classifying every page as
//     subject_property. Verified locally against New Braunfels for
//     Christina.pdf — 0/10 pages correct.
//   • scale 0.75 (459×594) → vision gets 8/10 pages right but loses
//     the first comp entirely, treating its pages as subject_property.
//   • scale 1.0 (612×792) → vision gets 10/10 pages perfect.
//
// We use scale 1.0 with JPEG quality 0.85 to keep request bodies
// compact. At those settings, 10 pages ≈ 1.0–1.5MB total, comfortably
// under the 4.5MB Vercel serverless limit. JPEG quality 0.85 is
// visually indistinguishable from PNG for the model's purposes — vision
// doesn't care about lossless compression artifacts on document text.
const CLASSIFIER_RENDER_SCALE = 1.0;
const CLASSIFIER_JPEG_QUALITY = 0.85;
const CLASSIFIER_MAX_PAGES = 20;

/**
 * Classify the PDF's pages via the vision endpoint and assemble a
 * deterministic CompMap. Returns null when:
 *   - Page rendering fails (corrupt PDF)
 *   - Classifier returns no comps (≥2 required)
 *   - Network/quota error against the classifier
 * The caller then falls back to regex boundary detection, then to the
 * chunked extractor.
 */
export async function detectCompBoundariesViaVision(
  file: File,
): Promise<CompMap | null> {
  // ─── 1. Render low-res classifier images ─────────────────────────
  // Independent of whatever extraction images the caller has rendered.
  // Boundary detection isn't a fan-out per high-res image — we render
  // small images just for the classifier and let extraction images
  // continue to use full resolution.
  let classifierImages: string[];
  try {
    classifierImages = await pdfToImages(file, {
      scale: CLASSIFIER_RENDER_SCALE,
      maxPages: CLASSIFIER_MAX_PAGES,
      format: 'jpeg',
      quality: CLASSIFIER_JPEG_QUALITY,
    });
  } catch (err) {
    console.warn('[vision-boundary] failed to render classifier images:', err);
    return null;
  }
  if (classifierImages.length === 0) return null;

  // ─── 2. Call the classifier (single batched request) ──────────────
  let pages: PageClassification[] = [];
  try {
    const res = await fetch('/api/classify-pdf-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: classifierImages }),
    });
    if (!res.ok) {
      console.warn(`[vision-boundary] classifier HTTP ${res.status}`);
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

  return buildCompMap(pages, classifierImages.length);
}

/**
 * Build a CompMap from per-page classifications, with defensive
 * handling for the realistic failure modes a vision model can produce:
 *
 *   1. GAPS in comp_index (the model returned 1, 2, 4 — skipped 3).
 *      → Renumber to be contiguous: 1, 2, 3.
 *   2. OUT-OF-ORDER labels (page 5 = "Sale 1", page 3 = "Sale 2").
 *      → Order comps by the earliest page they appear on, not by their
 *        numeric label. The PDF's reading order is the source of truth.
 *   3. PAGES MISSING from the response (model returned 8 classifications
 *      for a 10-page PDF).
 *      → Fill the missing pages as role='other', comp_index=null. They
 *        become unassignedPages in the final CompMap.
 *   4. GROUP WITH NO comp_id_page (only continuations classified).
 *      → Still build a CompBoundary, using the first page of the group
 *        as evidence + label source. Log a warning.
 *   5. NO COMPS DETECTED (every page classified as cover/subject/other).
 *      → Return null. Caller falls back to regex/chunked.
 */
function buildCompMap(
  pages: PageClassification[],
  totalRenderedPages: number,
): CompMap | null {
  // Fill any pages the model skipped. The classifier prompt guarantees
  // page numbers 1..N but the model can drift. Build a map keyed by
  // page number, then fill gaps with 'other' before processing.
  const byPage = new Map<number, PageClassification>();
  for (const p of pages) {
    if (p && Number.isInteger(p.page) && p.page > 0) byPage.set(p.page, p);
  }

  const totalPages = Math.max(
    totalRenderedPages,
    ...Array.from(byPage.keys()),
    0
  );
  if (totalPages === 0) return null;

  const completePages: PageClassification[] = [];
  for (let i = 1; i <= totalPages; i++) {
    const existing = byPage.get(i);
    if (existing) {
      completePages.push(existing);
    } else {
      console.warn(`[vision-boundary] page ${i} missing from classifier response — treating as 'other'`);
      completePages.push({
        page: i,
        role: 'other',
        comp_index: null,
        comp_label: null,
        evidence: 'no classification returned for this page',
      });
    }
  }

  // Group comp pages by their (possibly out-of-order, possibly gapped)
  // comp_index. Track first-page-seen so we can renumber by document
  // order in the final pass.
  const compGroups = new Map<
    number,
    { pages: PageClassification[]; firstPage: number }
  >();
  const unassigned: number[] = [];

  for (const p of completePages) {
    const isCompPage = p.role === 'comp_id_page' || p.role === 'comp_continuation';
    if (!isCompPage || p.comp_index == null) {
      unassigned.push(p.page);
      continue;
    }
    const group = compGroups.get(p.comp_index);
    if (group) {
      group.pages.push(p);
      group.firstPage = Math.min(group.firstPage, p.page);
    } else {
      compGroups.set(p.comp_index, { pages: [p], firstPage: p.page });
    }
  }

  // ≥2 comps required — single-comp documents fall through to the
  // legacy single-shot extractor which already handles them cleanly.
  if (compGroups.size < 2) {
    console.log(`[vision-boundary] only ${compGroups.size} comp(s) detected — falling back`);
    return null;
  }

  // Order comps by document order (earliest page), then RENUMBER to be
  // contiguous starting from 1. This eliminates gaps from the model
  // ("comp 1, comp 2, comp 4") and reseats out-of-order labels
  // ("Sale 1" appearing later than "Sale 2") to the actual document
  // sequence the broker will see.
  const ordered = Array.from(compGroups.entries())
    .map(([originalIdx, group]) => ({ originalIdx, ...group }))
    .sort((a, b) => a.firstPage - b.firstPage);

  const comps: CompBoundary[] = ordered.map((group, i) => {
    const sortedPages = group.pages.sort((a, b) => a.page - b.page);
    const idPage =
      sortedPages.find((p) => p.role === 'comp_id_page') ?? sortedPages[0];

    if (!sortedPages.some((p) => p.role === 'comp_id_page')) {
      console.warn(
        `[vision-boundary] comp ${i + 1} has no comp_id_page in its pages — ` +
          `using first continuation page (${sortedPages[0].page}) as fallback`
      );
    }

    return {
      // Renumber 1..N regardless of what the model said.
      index: i + 1,
      label: idPage.comp_label || `Comp ${i + 1}`,
      saleId: null,
      pages: sortedPages.map((p) => p.page),
      confidence: 'high',
      evidence: idPage.evidence || `vision: ${idPage.role}`,
    };
  });

  // All comp groups are 'high' confidence in the vision path; downgrade
  // if we had to fill missing pages above (we know less about the doc).
  const hadGaps = completePages.some((p) =>
    p.evidence === 'no classification returned for this page'
  );

  return {
    totalPages,
    comps,
    overallConfidence: hadGaps ? 'medium' : 'high',
    unassignedPages: unassigned.sort((a, b) => a - b),
  };
}

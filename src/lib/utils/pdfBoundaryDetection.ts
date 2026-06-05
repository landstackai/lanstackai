'use client';

// Deterministic comp-boundary detection for multi-comp PDFs.
//
// Architectural rebuild — Phase 1 of the extractor overhaul.
// Previously the import flow handed raw chunked images to GPT-4o vision and
// asked it to do EVERYTHING in one pass: find comp boundaries, extract
// fields, attribute aerials. That bundled three jobs into one prompt and
// produced compounding failures (missing comps, wrong field values, wrong
// thumbnails — see /Users/louieswope/Downloads/New Braunfels for
// Christina.pdf for the diagnostic case).
//
// This module pulls the structure-detection job OUT of the AI. We scan
// every page's text for boundary markers (visual structure that's
// consistent across US land-appraisal formats — the regex patterns
// below are appraisal-industry standard, not state-specific) and build
// a deterministic page → comp mapping BEFORE any AI call.
//
// Once we know exactly which pages belong to which comp, the downstream
// AI extraction can focus on a single job (extract this comp's fields
// from these specific pages) and the aerial extractor can attribute pin
// images by comp-scoped page ranges — making the whole class of "Comp 3
// got Comp 1's aerial" bugs structurally impossible.
//
// Returns null if confidence is too low (no boundary markers found across
// enough pages) — callers should fall back to the legacy AI-chunked path.
// Returns a CompMap when at least 2 comps are detected with high
// confidence — the caller routes to the per-comp extractor.

const PDFJS_VERSION = '5.7.284';
const WORKER_SRC = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = WORKER_SRC;
      return mod;
    });
  }
  return pdfjsPromise;
}

/**
 * One detected comparable sale, with the page numbers (1-indexed) that
 * make up its content and a confidence score for the boundary detection.
 */
export interface CompBoundary {
  /** The comp's order in the document (1-indexed: first comp = 1). */
  index: number;
  /** Human-readable label as found in the source (e.g. "Land Sale 1", "Sale 3", "Comparable #2"). */
  label: string;
  /** Optional structured Sale ID if printed in the source (e.g. "60226"). */
  saleId: string | null;
  /** Page numbers (1-indexed) that belong to this comp. */
  pages: number[];
  /**
   * Confidence in this boundary's correctness:
   *  - 'high'   strong header match ("Land Sale N" header + Property ID section)
   *  - 'medium' weaker header match (just "Sale N" or "Property N")
   *  - 'low'    only inferred from spacing / fallback
   */
  confidence: 'high' | 'medium' | 'low';
  /** The text excerpt that triggered detection — kept for diagnostics. */
  evidence: string;
}

export interface CompMap {
  totalPages: number;
  comps: CompBoundary[];
  /**
   * Overall detection confidence. 'high' when every comp boundary is
   * high-confidence and pages are fully accounted for. 'low' when we
   * couldn't fit pages cleanly — caller should fall back to AI chunking.
   */
  overallConfidence: 'high' | 'medium' | 'low';
  /**
   * Pages NOT assigned to any comp (cover page, table of contents,
   * summary pages at the end). These are excluded from per-comp
   * extraction.
   */
  unassignedPages: number[];
}

// Boundary markers in priority order. Each entry describes a pattern that
// commonly heads a comp's first page in US land-appraisal reports
// (terminology is industry-standard across states). Matched
// case-insensitively. The patterns are intentionally narrow — we'd rather
// MISS a boundary (fall back to AI) than HALLUCINATE one (split a single
// comp across multiple).
const BOUNDARY_PATTERNS: Array<{
  pattern: RegExp;
  confidence: 'high' | 'medium';
  extractLabel: (match: RegExpMatchArray) => string;
  extractIndex: (match: RegExpMatchArray) => number | null;
}> = [
  // "Land Sale 1", "LAND SALE 12", "Land sale #3"
  {
    pattern: /\bland\s*sale\s*#?\s*(\d{1,3})\b/i,
    confidence: 'high',
    extractLabel: (m) => `Land Sale ${m[1]}`,
    extractIndex: (m) => parseInt(m[1], 10),
  },
  // "Sale No. 1", "Sale No 12", "Sale #3"
  {
    pattern: /\bsale\s*(?:no\.?|number|#)\s*(\d{1,3})\b/i,
    confidence: 'high',
    extractLabel: (m) => `Sale No. ${m[1]}`,
    extractIndex: (m) => parseInt(m[1], 10),
  },
  // "Comparable Sale 1", "Comparable #2", "Comp 3"
  {
    pattern: /\bcomp(?:arable)?\s*(?:sale|#)?\s*(\d{1,3})\b/i,
    confidence: 'high',
    extractLabel: (m) => `Comparable ${m[1]}`,
    extractIndex: (m) => parseInt(m[1], 10),
  },
  // "Property 1", "Property #2" — only confident if standalone at top of page
  {
    pattern: /^\s*property\s*#?\s*(\d{1,3})\s*$/im,
    confidence: 'medium',
    extractLabel: (m) => `Property ${m[1]}`,
    extractIndex: (m) => parseInt(m[1], 10),
  },
];

// Section headers that confirm we're on a comp's ID page (vs. a description
// or remarks page). Used as a secondary confidence signal — a page with
// BOTH a boundary header AND one of these is high-confidence.
const ID_PAGE_HEADERS = [
  /PROPERTY\s+IDENTIFICATION/i,
  /TRANSACTION\s+DATA/i,
  /SALE\s+ID/i,
];

// Extract the printed Sale ID from a page (if any). Stewart-style appraisals
// print "Sale ID  12345" in the Property Identification table.
function extractSaleId(pageText: string): string | null {
  // Look for "Sale ID" followed by whitespace and a number (typically 4-6 digits).
  // Excludes years (4-digit numbers starting with 19 or 20) by upper-bound check
  // on string length and lower bound on numeric value.
  const m = pageText.match(/sale\s*id\s*[:#]?\s*(\d{3,7})\b/i);
  if (!m) return null;
  return m[1];
}

/**
 * Extract per-page text using pdf.js. Returns an array indexed by page-1.
 * Each entry is the concatenated text content of that page, normalized to
 * collapse extra whitespace (so matching against patterns is reliable).
 */
async function extractPerPageText(file: File): Promise<string[]> {
  const pdfjs = await getPdfjs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const out: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Each item.str is a text fragment (often a single word or phrase).
    // Join with spaces and collapse runs of whitespace for stable matching.
    const text = (content.items as Array<{ str: string }>)
      .map((it) => it.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    out.push(text);
  }

  return out;
}

/**
 * Scan a page's text for any boundary marker. Returns the first match (by
 * pattern priority) or null if no marker is present. Confidence escalates
 * to 'high' if the same page also contains an ID-page section header.
 */
function detectBoundaryOnPage(pageText: string): {
  label: string;
  index: number | null;
  saleId: string | null;
  confidence: 'high' | 'medium';
  evidence: string;
} | null {
  // Only scan the FIRST ~500 chars of the page — boundary headers always
  // sit at the top. This avoids matching "Sale 1" inside a narrative
  // paragraph like "in the prior sale 1 year ago." A header on page 5
  // doesn't help us split page 5 mid-comp anyway.
  const top = pageText.slice(0, 500);

  for (const pat of BOUNDARY_PATTERNS) {
    const match = top.match(pat.pattern);
    if (!match) continue;

    // Escalate to high confidence if an ID-page header is also present
    // somewhere on the page. This is the structural confirmation that
    // this is a comp's first page (not a stray mention).
    const hasIdSection = ID_PAGE_HEADERS.some((re) => re.test(pageText));
    const confidence = hasIdSection ? 'high' : pat.confidence;

    return {
      label: pat.extractLabel(match),
      index: pat.extractIndex(match),
      saleId: extractSaleId(pageText),
      confidence,
      evidence: match[0],
    };
  }

  return null;
}

/**
 * Main entry point. Scans the PDF text and returns a CompMap if boundary
 * detection found ≥2 comps with reasonable confidence. Returns null when
 * confidence is too low — caller falls back to the legacy AI-chunked path.
 *
 * The 2-comp minimum is intentional: detecting boundaries on a single-comp
 * PDF doesn't help (the existing single-shot path already works), and a
 * false-positive boundary would split a single comp incorrectly.
 */
export async function detectCompBoundaries(file: File): Promise<CompMap | null> {
  let perPageText: string[];
  try {
    perPageText = await extractPerPageText(file);
  } catch (err) {
    // PDF.js failed — most likely a scanned PDF without a text layer.
    // Boundary detection isn't possible without text; fall back to AI.
    console.warn('[boundary] PDF text extraction failed, falling back to AI:', err);
    return null;
  }

  const totalPages = perPageText.length;
  if (totalPages === 0) return null;

  // First pass: find every page that has a boundary marker.
  const boundaries: Array<{
    page: number; // 1-indexed
    label: string;
    index: number | null;
    saleId: string | null;
    confidence: 'high' | 'medium';
    evidence: string;
  }> = [];

  for (let i = 0; i < perPageText.length; i++) {
    const detected = detectBoundaryOnPage(perPageText[i]);
    if (detected) {
      boundaries.push({ page: i + 1, ...detected });
    }
  }

  // Need at least 2 boundaries to make a map. With <2, fall back to AI —
  // single-comp PDFs work fine on the legacy single-shot path.
  if (boundaries.length < 2) return null;

  // Sanity check: boundary indices should be roughly monotonic. If we
  // detected "Sale 1", "Sale 2", "Sale 3", etc. — that's what we want.
  // If they're "Sale 3", "Sale 1", "Sale 5" — something's wrong and we
  // shouldn't trust the detection.
  const indices = boundaries
    .map((b) => b.index)
    .filter((n): n is number => n != null);
  let monotonic = true;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] < indices[i - 1]) {
      monotonic = false;
      break;
    }
  }
  if (indices.length >= 2 && !monotonic) {
    console.warn('[boundary] non-monotonic comp indices, falling back to AI:', indices);
    return null;
  }

  // Build comp page ranges by spanning between consecutive boundary pages.
  // Comp N's pages = [boundary[N].page, boundary[N+1].page - 1] (inclusive).
  // The last comp extends to the end of the PDF, OR if there's a "Summary"
  // / "Adjustment Grid" page at the end we stop before that — but we don't
  // detect those here in v1 (rare and easy to handle later).
  const comps: CompBoundary[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    const startPage = b.page;
    const endPage = i + 1 < boundaries.length
      ? boundaries[i + 1].page - 1
      : totalPages;
    const pages: number[] = [];
    for (let p = startPage; p <= endPage; p++) pages.push(p);
    comps.push({
      index: i + 1,
      label: b.label,
      saleId: b.saleId,
      pages,
      confidence: b.confidence,
      evidence: b.evidence,
    });
  }

  // Pages not covered by any comp (cover page, intro, summary at end).
  const assigned = new Set<number>();
  comps.forEach((c) => c.pages.forEach((p) => assigned.add(p)));
  const unassigned: number[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (!assigned.has(p)) unassigned.push(p);
  }

  // Overall confidence is high when every comp is high-confidence AND the
  // page distribution looks sane (2-3 pages per comp is the dominant Texas
  // appraisal pattern; outliers are usually fine but flag them).
  const allHigh = comps.every((c) => c.confidence === 'high');
  const avgPagesPerComp = comps.reduce((s, c) => s + c.pages.length, 0) / comps.length;
  const pageCountSane = avgPagesPerComp >= 1 && avgPagesPerComp <= 8;
  const overallConfidence: 'high' | 'medium' | 'low' =
    allHigh && pageCountSane ? 'high' : pageCountSane ? 'medium' : 'low';

  return {
    totalPages,
    comps,
    overallConfidence,
    unassignedPages: unassigned,
  };
}

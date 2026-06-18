// ConvertAPI integration — server-side PDF processing.
//
// Two operations on PDF uploads, both running async after the
// orchestrator returns the broker's comp data:
//
//   1. renderPdfPageToJpg — convert a single PDF page to a JPG image.
//      Used for the aerial thumbnail that overlays the boundary-draw
//      map in the verification UX. Lets the broker visually compare
//      what the appraiser saw against the parcel the system mapped.
//
//   2. slicePdfPages — extract a page range from a PDF, returning a
//      smaller standalone PDF. Used to save each comp's source pages
//      to comp_documents so brokers can click through to "see the
//      original" for any comp later (rather than scrolling a 71-page
//      appraisal looking for KWO's specific pages).
//
// Why ConvertAPI (vs DIY pdfjs-dist on Node):
//   - 60-90 min to ship vs 3-4 hours of fighting node-canvas/pdfjs
//     legacy build quirks
//   - Handles every PDF edge case (scanned, vector aerials, encrypted,
//     weird color spaces) — battle-tested across many production
//     customers
//   - Sandbox token for local dev, production token for live; clean
//     dev/prod separation
//
// Cost is trivial at our scale: $9.99/mo flat for 1,500 page ops.
// One Christina-sized broker (~50 PDFs/month × ~6 pages each = 300
// ops/mo) sits comfortably under the cap.

import { Buffer } from 'node:buffer';

const CONVERTAPI_BASE = 'https://v2.convertapi.com';

function getToken(): string {
  const t = process.env.CONVERTAPI_TOKEN;
  if (!t || t.length < 10) {
    throw new Error(
      'CONVERTAPI_TOKEN is missing or invalid in env. Add it to .env.local for local dev or Vercel env vars for production.',
    );
  }
  return t;
}

// Common multipart form post helper. ConvertAPI accepts the auth token
// via `?Secret=TOKEN` query param (cleanest), file via multipart `File`
// field, and additional params via form fields.
async function postConvertApi(
  endpoint: string,
  pdfBuffer: Buffer,
  fileName: string,
  params: Record<string, string>,
  opts: { timeoutMs?: number } = {},
): Promise<{ Files: Array<{ FileName: string; FileExt: string; FileSize: number; FileData: string }>; ConversionCost: number }> {
  const url = `${CONVERTAPI_BASE}${endpoint}?Secret=${encodeURIComponent(getToken())}`;
  const form = new FormData();
  form.append('File', new Blob([pdfBuffer], { type: 'application/pdf' }), fileName);
  for (const [k, v] of Object.entries(params)) {
    form.append(k, v);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '<unreadable>');
      throw new Error(
        `ConvertAPI ${endpoint} returned ${res.status}: ${errText.slice(0, 300)}`,
      );
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Decode the result file from the base64 FileData ConvertAPI returns.
// ConvertAPI returns bytes inline as base64 in `FileData` (the API also
// supports a `Url` mode if you set `StoreFile=true`, but the default
// inline-base64 mode means we don't have to make a second HTTP roundtrip
// and don't have to worry about URL expiration).
function decodeResult(fileData: string): Buffer {
  if (!fileData) {
    throw new Error('ConvertAPI result missing FileData');
  }
  return Buffer.from(fileData, 'base64');
}

/**
 * Render a single PDF page to a JPG image.
 *
 * @param pdfBuffer  The PDF as a Buffer
 * @param pageNumber 1-indexed page number to render
 * @param opts.dpi   Render resolution in DPI (default 90 — yields
 *                   ~770×1000px on a letter page, ~70KB JPG file.
 *                   ConvertAPI's default 200 DPI gave 1700×2200px /
 *                   ~370KB files, which is overkill for the map-corner
 *                   thumbnail and bloats the inline-base64 response).
 * @param opts.quality JPEG quality 1-100 (default 75 — visually
 *                     indistinguishable from 85 at thumbnail size,
 *                     ~30% smaller files).
 * @returns JPG image as a Buffer
 */
export async function renderPdfPageToJpg(
  pdfBuffer: Buffer,
  pageNumber: number,
  opts: { dpi?: number; quality?: number } = {},
): Promise<Buffer> {
  const params: Record<string, string> = {
    PageRange: String(pageNumber),
    JpegQuality: `${opts.quality ?? 75}`,
    // ImageResolution is the render DPI. Lower DPI = smaller pixel
    // dimensions = smaller JPG file. 90 DPI on letter paper is
    // ~770×1000px which renders cleanly at the verification card's
    // ~200×260px map-overlay slot (4x retina headroom).
    ImageResolution: `${opts.dpi ?? 90}`,
  };
  const result = await postConvertApi(
    '/convert/pdf/to/jpg',
    pdfBuffer,
    'source.pdf',
    params,
    { timeoutMs: 45_000 },
  );
  if (!result.Files || result.Files.length === 0) {
    throw new Error('ConvertAPI returned no files for PDF→JPG conversion');
  }
  return decodeResult(result.Files[0].FileData);
}

/**
 * Slice specific pages from a PDF into a standalone smaller PDF.
 *
 * @param pdfBuffer The PDF as a Buffer
 * @param pageRange Range string in ConvertAPI format. Examples:
 *                    "37"         — just page 37
 *                    "37-38"      — pages 37 and 38
 *                    "37,38,39"   — pages 37, 38, 39 (same as 37-39)
 * @returns The sub-PDF as a Buffer
 */
export async function slicePdfPages(
  pdfBuffer: Buffer,
  pageRange: string,
): Promise<Buffer> {
  const result = await postConvertApi(
    '/convert/pdf/to/pdf',
    pdfBuffer,
    'source.pdf',
    { PageRange: pageRange },
    { timeoutMs: 45_000 },
  );
  if (!result.Files || result.Files.length === 0) {
    throw new Error('ConvertAPI returned no files for PDF slice');
  }
  return decodeResult(result.Files[0].FileData);
}

/**
 * Format an evidence_pages array as a ConvertAPI PageRange string.
 * Tolerates non-contiguous pages (e.g. [37, 38, 41] → "37,38,41").
 */
export function pagesToRange(pages: number[]): string {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('pagesToRange requires at least one page number');
  }
  // Sort + dedupe defensively (Claude usually returns sorted unique
  // pages but the schema doesn't enforce it).
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  return sorted.join(',');
}

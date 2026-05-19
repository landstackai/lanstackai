'use client';

// Client-only helper. Extracts the largest embedded raster image from a PDF.
// Used to surface the source-aerial photo of an appraisal in the import
// verification card WITHOUT rendering the whole PDF page and trying to crop
// visually — CSS cropping doesn't generalize because aerials sit at different
// positions across appraisal formats.
//
// PDF strategy: PDFs store images as discrete XObject streams. We open the
// PDF, scan each page's operator list for paintImageXObject / paintInlineImageXObject
// operations, retrieve each image object, convert it to a canvas, and return
// the LARGEST one as a data URL. "Largest" by pixel area = almost always the
// aerial photo (logos, icons, signature graphics are tiny).
//
// Returns null when:
//   - The PDF has no embedded raster images (text-only appraisal)
//   - All images are below the minimum size threshold (likely icons/logos)
//   - Anything in the PDF parse pipeline throws

const PDFJS_VERSION = '5.7.284';
const WORKER_SRC = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

// Skip anything smaller than this — icons, signatures, headers, decorative
// graphics. Real aerial photos in appraisals are at least 300×300 pixels
// (usually much larger). Tuned conservatively to not miss small aerials in
// older scanned appraisals.
const MIN_IMAGE_DIMENSION = 200;

// Cap output dataURL to roughly 1MB worth of base64. Some PDF aerials are
// huge (multi-megapixel). For a thumbnail comparison the broker doesn't need
// full resolution — re-encode to JPEG at moderate quality to keep the DOM
// snappy.
const OUTPUT_JPEG_QUALITY = 0.8;

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
 * Extract the largest embedded raster image from the PDF. Returns a JPEG
 * data URL or null if none qualifies. Never throws.
 *
 * @param file        The PDF File object
 * @param maxPages    Only scan the first N pages (default 5 — aerials are
 *                    almost always near the front of an appraisal)
 */
export async function extractLargestAerial(
  file: File,
  opts: { maxPages?: number } = {}
): Promise<string | null> {
  const maxPages = opts.maxPages ?? 5;
  let best: { area: number; dataUrl: string } | null = null;

  try {
    const pdfjs = await getPdfjs();
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buffer }).promise;
    const pageCount = Math.min(pdf.numPages, maxPages);

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const page = await pdf.getPage(pageNum);
      // getOperatorList resolves all required image objects as a side effect.
      // After this call, page.objs.get(name) should work synchronously for
      // any image referenced on this page.
      const opList = await page.getOperatorList();
      const PAINT_IMAGE = (pdfjs as any).OPS.paintImageXObject;
      const PAINT_INLINE_IMAGE = (pdfjs as any).OPS.paintInlineImageXObject;

      for (let i = 0; i < opList.fnArray.length; i++) {
        const op = opList.fnArray[i];
        if (op !== PAINT_IMAGE && op !== PAINT_INLINE_IMAGE) continue;

        try {
          // For paintImageXObject the first arg is the object name (string).
          // For paintInlineImageXObject the first arg is the inline image obj
          // (an object with width/height/data — no objs.get lookup needed).
          let img: any = null;
          if (op === PAINT_IMAGE) {
            const name = opList.argsArray[i]?.[0];
            if (typeof name !== 'string') continue;
            img = await resolveObj(page, name);
          } else {
            img = opList.argsArray[i]?.[0];
          }

          if (!img) continue;
          const w = img.width ?? img.bitmap?.width;
          const h = img.height ?? img.bitmap?.height;
          if (!w || !h) continue;
          if (w < MIN_IMAGE_DIMENSION || h < MIN_IMAGE_DIMENSION) continue;

          const dataUrl = await imageToDataUrl(img, w, h);
          if (!dataUrl) continue;

          const area = w * h;
          if (!best || area > best.area) {
            best = { area, dataUrl };
          }
        } catch {
          // Skip this image; try the next
        }
      }
    }
  } catch {
    return null;
  }

  return best?.dataUrl ?? null;
}

/**
 * Per-page variant: returns the largest qualifying aerial for EACH page
 * of the PDF, as an array of {page, dataUrl} entries. Pages with no
 * qualifying image are omitted.
 *
 * Used by multi-comparable imports — when one PDF contains "LAND
 * COMPARABLE 1" on page 1 + "LAND COMPARABLE 2" on page 2, each comp
 * needs ITS OWN aerial. Caller maps comps to pages via the AI's source
 * citations (which now include the page number) and picks the right
 * aerial for each.
 *
 * @param file     The PDF File object
 * @param opts     Optional cap on number of pages to scan (default 10).
 *                 Higher than single-page extractLargestAerial since
 *                 multi-comp documents tend to be longer.
 */
export async function extractLargestAerialPerPage(
  file: File,
  opts: { maxPages?: number } = {}
): Promise<Array<{ page: number; dataUrl: string }>> {
  const maxPages = opts.maxPages ?? 10;
  const results: Array<{ page: number; dataUrl: string }> = [];

  try {
    const pdfjs = await getPdfjs();
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buffer }).promise;
    const pageCount = Math.min(pdf.numPages, maxPages);

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      let pageBest: { area: number; dataUrl: string } | null = null;
      try {
        const page = await pdf.getPage(pageNum);
        const opList = await page.getOperatorList();
        const PAINT_IMAGE = (pdfjs as any).OPS.paintImageXObject;
        const PAINT_INLINE_IMAGE = (pdfjs as any).OPS.paintInlineImageXObject;

        for (let i = 0; i < opList.fnArray.length; i++) {
          const op = opList.fnArray[i];
          if (op !== PAINT_IMAGE && op !== PAINT_INLINE_IMAGE) continue;
          try {
            let img: any = null;
            if (op === PAINT_IMAGE) {
              const name = opList.argsArray[i]?.[0];
              if (typeof name !== 'string') continue;
              img = await resolveObj(page, name);
            } else {
              img = opList.argsArray[i]?.[0];
            }
            if (!img) continue;
            const w = img.width ?? img.bitmap?.width;
            const h = img.height ?? img.bitmap?.height;
            if (!w || !h) continue;
            if (w < MIN_IMAGE_DIMENSION || h < MIN_IMAGE_DIMENSION) continue;
            const dataUrl = await imageToDataUrl(img, w, h);
            if (!dataUrl) continue;
            const area = w * h;
            if (!pageBest || area > pageBest.area) {
              pageBest = { area, dataUrl };
            }
          } catch {
            // Skip this image; try the next
          }
        }
      } catch {
        // Skip this page; try the next
      }
      if (pageBest) {
        results.push({ page: pageNum, dataUrl: pageBest.dataUrl });
      }
    }
  } catch {
    return [];
  }

  return results;
}

/**
 * Resolve a pdfjs object by name. pdfjs's objs.get is documented as taking
 * a callback when the object isn't yet ready, but after a successful
 * getOperatorList() the page's objects should be resolved. Try sync first,
 * fall back to callback for safety.
 */
function resolveObj(page: any, name: string): Promise<any> {
  return new Promise((resolve) => {
    try {
      // Try synchronous first
      const obj = page.objs.get(name);
      if (obj !== undefined) {
        resolve(obj);
        return;
      }
    } catch {
      // Object not ready — fall through to callback
    }
    try {
      page.objs.get(name, (obj: any) => resolve(obj));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Convert a pdfjs image object to a JPEG data URL via canvas.
 *
 * Modern pdfjs (5.x) typically delivers images as { bitmap: ImageBitmap }.
 * Older / fallback path: { data: Uint8ClampedArray | Uint8Array, kind: number }.
 * Both are handled.
 */
async function imageToDataUrl(img: any, w: number, h: number): Promise<string | null> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    if (img.bitmap) {
      // ImageBitmap — fastest path
      ctx.drawImage(img.bitmap, 0, 0);
    } else if (img.data) {
      // Raw pixel data — kind tells us the layout
      // ImageKind constants (from pdfjs):
      //   1 = GRAYSCALE_1BPP
      //   2 = RGB_24BPP
      //   3 = RGBA_32BPP
      const kind = img.kind ?? 3;
      const imageData = ctx.createImageData(w, h);
      if (kind === 3) {
        // RGBA — direct copy
        imageData.data.set(img.data as Uint8ClampedArray);
      } else if (kind === 2) {
        // RGB — expand to RGBA with full alpha
        const src = img.data as Uint8ClampedArray;
        const dst = imageData.data;
        for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
          dst[j] = src[i];
          dst[j + 1] = src[i + 1];
          dst[j + 2] = src[i + 2];
          dst[j + 3] = 255;
        }
      } else {
        // Unsupported kind (1BPP grayscale, JBIG2, etc.) — skip
        return null;
      }
      ctx.putImageData(imageData, 0, 0);
    } else {
      return null;
    }

    return canvas.toDataURL('image/jpeg', OUTPUT_JPEG_QUALITY);
  } catch {
    return null;
  }
}

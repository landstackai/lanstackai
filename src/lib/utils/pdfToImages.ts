'use client';

// Client-only helper. Renders each page of a PDF to a PNG data URL using pdf.js.
// Used by the import flow so scanned PDFs (no text layer) can be sent to the
// vision model.

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

export async function pdfToImages(
  file: File,
  opts: {
    scale?: number;
    maxPages?: number;
    // Output format. PNG is lossless (default — used for high-res
    // extraction images where every pixel of the source matters).
    // JPEG is ~5x smaller for photo-heavy content (used for the
    // classifier where compact request bodies matter and any quality
    // loss is invisible at typical vision-model resolutions).
    format?: 'png' | 'jpeg';
    quality?: number;
  } = {}
): Promise<string[]> {
  const {
    scale = 1.6,
    maxPages = 20,
    format = 'png',
    quality = 0.85,
  } = opts;
  const pdfjs = await getPdfjs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const pageCount = Math.min(pdf.numPages, maxPages);
  const out: string[] = [];

  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    // JPEG doesn't support transparency — fill the canvas with white
    // first so any antialiasing edges don't render as black artifacts.
    if (format === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    await page.render({ canvas, canvasContext: ctx, viewport } as any).promise;
    out.push(
      format === 'jpeg'
        ? canvas.toDataURL(mimeType, quality)
        : canvas.toDataURL(mimeType)
    );
  }
  return out;
}

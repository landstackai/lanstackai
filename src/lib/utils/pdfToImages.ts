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
  opts: { scale?: number; maxPages?: number } = {}
): Promise<string[]> {
  const { scale = 1.6, maxPages = 20 } = opts;
  const pdfjs = await getPdfjs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const pageCount = Math.min(pdf.numPages, maxPages);
  const out: string[] = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    await page.render({ canvas, canvasContext: ctx, viewport } as any).promise;
    out.push(canvas.toDataURL('image/png'));
  }
  return out;
}

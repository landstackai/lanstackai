# Local extraction test harness

Test scripts that run the PDF extraction pipeline against real broker
documents BEFORE code touches production. Built on June 5, 2026 after a
day of speculative bug-fixing made it painfully clear that "looks right
in the code" is not a substitute for "produces correct output on a real
PDF."

## When to run

**Before pushing ANY change** that touches:
- `src/app/api/import-chat/route.ts`
- `src/app/api/classify-pdf-pages/route.ts`
- `src/lib/utils/pdfBoundaryDetection.ts`
- `src/lib/utils/visionBoundaryDetection.ts`
- `src/lib/utils/compExtractionSchema.ts`
- `src/lib/utils/extractionSanity.ts`
- `src/lib/utils/pdfToImages.ts`
- `src/lib/utils/pdfExtractAerial.ts`
- `src/app/dashboard/import/page.tsx` (the boundary-aware + chunked + sendMessage paths)

If any of these are in the diff and you HAVEN'T run the relevant scripts,
do not push. That's the rule that kept June 5 from repeating.

## Setup

The scripts read `OPENAI_API_KEY` from `.env.local` at the project root.
That file already exists for the dev server; no extra setup needed.

PDF rendering uses `pdftoppm` from the `poppler` package. If missing:
```
brew install poppler
```

## Scripts

### `test-pdf-extract.mjs <pdf-path>`

Diagnostic. Loads a PDF, extracts text per page using pdf.js (the same
library the client uses), prints what each page contains plus which
regex boundary patterns match. Run this when "boundary detection didn't
qualify" — it tells you whether pdf.js sees the header text at all, or
whether the headers are rasterized (in which case vision is the only
viable path).

```
node scripts/test-pdf-extract.mjs "/path/to/some.pdf"
```

### `test-vision-classifier.mjs <pdf-path>`

End-to-end test of the vision-based comp boundary detection. Renders
the PDF's pages to PNG via pdftoppm, sends them in a single batched
call to OpenAI using the EXACT prompt and schema the production
classifier uses, prints the per-page classification, then compares to
hardcoded ground truth for the New Braunfels PDF (10 pages, 5 comps).

The ground truth check only applies if the PDF matches the New Braunfels
shape — for other PDFs the per-page output is still printed but the
final "X/10" tally is meaningless.

```
node scripts/test-vision-classifier.mjs \
  "/Users/louieswope/Downloads/New Braunfels for Christina.pdf"
```

### `test-vision-prod-scale.mjs <rendered-images-dir>`

Variant of the classifier test that takes a directory of pre-rendered
images. Used during the June 5 debugging session to test different
render scales against the same OpenAI call. Most useful if you suspect
the image scale is too small / too large for the model.

### `test-prompt-v2.mjs <rendered-images-dir>`

Same as above, but with a tightened classifier prompt that prioritizes
"header text WINS over page position." This is the prompt that landed
in production on June 5. Use this when iterating on prompt changes —
compare its output to test-vision-prod-scale.mjs to see the effect of
prompt tweaks in isolation.

### `test-single-prop-extract.mjs <corpus-dir>`

Runs single-property extraction (the path most ≤5-page PDFs use)
against every PDF in a directory. Parses expected acres and
price-per-acre out of the FILENAME (assumes the broker's naming
convention "Month Year.PropertyName.NNN.NNNAcres.$NNNNAc.Type.pdf").
Reports pass/fail per PDF.

Corpus: `/Users/louieswope/Downloads/fwdfriofarms/` (12 single-property
farm sale PDFs).

```
node scripts/test-single-prop-extract.mjs /Users/louieswope/Downloads/fwdfriofarms
```

### `test-mls-extract.mjs <mls-pdf-path>`

Specifically tests an MLS sold-sheet extraction. Checks that:
1. The address is extracted (for geocode fallback).
2. Agent names ("Sold by", "Listed by", etc.) DO NOT leak into the
   grantor/grantee fields.
3. The extracted comp has what `autoLocateInBrowser` and
   `geocodeAddressFallback` need to find a parcel.

```
node scripts/test-mls-extract.mjs \
  "/Users/louieswope/Downloads/MLS Sale - Wilson County (2).pdf"
```

### `test-autolocate-readiness.mjs <pdf-or-dir>...`

The integration test. Takes one or more PDFs (or directories of PDFs),
extracts each, then for every extracted comp reports whether it's
auto-locatable — and if so, via which path:

- `explicit-coords` — comp has lat/lng already (e.g., "Geographic
  Location" on Texas appraiser sheets); auto-locate is bypassed
- `parcel-match` — has acres + county + owner signal; parcel lookup
  will be attempted
- `address-geocode` — has a street-address with at least one digit;
  geocode fallback can fire
- `NONE` — comp would land in vault without a map pin

Use this as the final "did I break auto-locate?" check before any push.
Run it against the full Frio Farms corpus + Wilson MLS:

```
node scripts/test-autolocate-readiness.mjs \
  /Users/louieswope/Downloads/fwdfriofarms \
  "/Users/louieswope/Downloads/MLS Sale - Wilson County (2).pdf"
```

Last known-good result (June 5, 2026): **13/13 auto-locatable** across
all single-property test PDFs.

## How to extend the corpus

When a broker reports an extraction failure on a new PDF format:
1. Add the PDF to the relevant Downloads folder.
2. Run the relevant script against it, capture the wrong output.
3. Fix the prompt / scale / code until the script passes.
4. Don't push until the script passes.

Over time, the test corpus becomes a living record of every format the
product is known to handle. Every broker report that turns into a fix
ALSO turns into a test fixture — so the same shape of bug can never
ship again.

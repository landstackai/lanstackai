// Authoritative-acreage extraction from appraisal description prose.
//
// Single source of truth for "what acreage does this description say
// the sold tract is?" — used by the import-chat post-extraction
// override AND the map page's description-reconcile effect. The two
// previously had divergent logic (server: cue-aware pick-largest;
// map: naive first-match), and the naive one clobbered broker-corrected
// values: Pletcher Ranch (2026-10-06) reads "Approximately 500 acres
// is high fenced while 276 acres features standard pasture fencing"
// — the appraisal's gross land size is 746, but first-match reset the
// comp to 500 every time the broker opened it.
//
// Decision ladder (first hit wins):
//   1. GROSS_CUE — "gross land size", "gross acreage", "total of",
//      "totaling", "in total" within the match window. An explicitly
//      stated gross/total figure IS the sold tract. Always wins.
//   2. SALE_CUE — sale/subject/tract/comprising/consists near the
//      number ties it to the sold tract.
//   3. Everything else: strip NEG_CUE matches (parent tract, holdings,
//      adjoining — explicitly NOT the sold tract) and COMPONENT_CUE
//      matches (high-fenced portion, irrigated/cultivated/pasture
//      acres, lakes/ponds — parts of the tract, never the whole), then
//      pick the LARGEST survivor.
//   4. If every number was a component/negative, return null — an
//      ambiguous description must not override the extracted or
//      broker-entered acreage.
//
// Why "largest" instead of "last" (historical regression cases):
//   - L&D Farm: parent ranch FIRST + sold tract LAST (8,820 → 1,179).
//     "8,820-acre Cooper Ranch holdings" trips NEG_CUE ("holdings"),
//     leaving 1,179. ✓
//   - Eatwell River Ranch: ±796-acre headline + "9-acre lake" later.
//     The lake trips COMPONENT_CUE; headline survives → 796. ✓
//   - Property totals are reliably the BIGGEST acreage in a
//     description; sub-features are smaller.

const ACRE_RE = /(?<![\d,])([0-9][0-9,]*(?:\.\d+)?)\s*[-±]?\s*(?:acres?|ac)\b/gi;

const GROSS_CUE = /\b(gross\s+(?:land\s+)?(?:size|acreage|area)|total\s+of|totaling|in\s+total|total\s+(?:land\s+)?(?:size|acreage|area))\b/i;
const SALE_CUE = /\b(sale|subject|tract|comprising|consist\w*|totaling)\b/i;
const NEG_CUE = /\b(parent|holdings?|larger|portion of|adjoining|surrounding|abuts|neighbor)\b/i;
// Parts of the tract — a number cued as a component is never the whole.
const COMPONENT_CUE = /\b(high[\s-]?fenc\w*|low[\s-]?fenc\w*|standard\s+(?:pasture\s+)?fenc\w*|game[\s-]?fenc\w*|irrigat\w*|cultivat\w*|tillable|pasture|hay\s*(?:field|meadow)|field|orchard|lake|pond|tank|wooded|timber|bottomland|flood\s*plain|of\s+which|balance\s+of|remainder)\b/i;

function windowAround(desc: string, idx: number): string {
  return desc.slice(Math.max(0, idx - 60), idx + 40);
}

export function extractAcresFromDescription(desc: unknown): number | null {
  if (typeof desc !== 'string' || !desc) return null;
  // Array.from() rather than spread — the project's tsconfig.json doesn't
  // set a "target", so RegExpStringIterator can't be spread (TS2802).
  const all = Array.from(desc.matchAll(ACRE_RE));
  if (all.length === 0) return null;

  const val = (m: RegExpMatchArray) => parseFloat(m[1].replace(/,/g, ''));

  // 1. Gross/total land size — an explicit statement of the whole tract.
  const gross = all.find((m) => GROSS_CUE.test(windowAround(desc, m.index ?? 0)));
  if (gross) {
    const v = val(gross);
    return Number.isFinite(v) ? v : null;
  }

  // 2. Sale-cue preferred match.
  const preferred = all.find((m) => SALE_CUE.test(windowAround(desc, m.index ?? 0)));

  // 3. Fallback pool: strip negatives and components, pick largest.
  const candidates = preferred
    ? [preferred]
    : all.filter((m) => {
        const w = windowAround(desc, m.index ?? 0);
        return !NEG_CUE.test(w) && !COMPONENT_CUE.test(w);
      });

  // 4. Nothing unambiguous — don't override anything.
  if (candidates.length === 0) return null;

  let bestVal = val(candidates[0]);
  for (let i = 1; i < candidates.length; i++) {
    const v = val(candidates[i]);
    if (Number.isFinite(v) && v > bestVal) bestVal = v;
  }
  return Number.isFinite(bestVal) ? bestVal : null;
}

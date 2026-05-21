// Owner-name abbreviation for the review-page search suggestion chips.
//
// TxGIO's parcel database indexes owner names imperfectly — "Eatwell
// River Farms Trust" on a deed might be stored as "EATWELL FARMS" or
// "EATWELL RIVER FARMS TR" or just "EATWELL ENTERPRISES" in the
// appraisal-district roll. The shorter, more distinctive search term
// has a higher hit rate.
//
// The suggestion chips ALSO teach the broker how to search effectively:
//   - For entities: show the brand word ("Eatwell" not "Eatwell River
//     Farms Trust")
//   - For people: show the surname ("Burrow" not "David Burrow")
//   - One combined chip demonstrates refinement ("Burrow Gonzales
//     County" — name + place narrows the result set)
//
// The abbreviation logic distinguishes entities from persons by looking
// for "stop words" (Trust / LLC / Ranch / Farms / etc.). Persons get
// their surname picked; entities get the first 1-2 words BEFORE the
// first stop word.

// Stop words that indicate an entity. When ANY of these appear, treat
// the name as an entity (use first 1-2 words). Listed lowercase; the
// matcher normalizes whitespace + punctuation before lookup.
const STOP_WORDS: ReadonlySet<string> = new Set([
  'river', 'creek', 'lake', 'hill', 'hills', 'valley', 'point', 'ridge',
  'ranch', 'ranches', 'farm', 'farms', 'land',
  'trust', 'trustee', 'trustees', 'family',
  'llc', 'inc', 'lp', 'ltd', 'limited',
  'co', 'company', 'corp', 'corporation',
  'properties', 'property', 'holdings', 'estates', 'estate',
  'ventures', 'partners', 'partnership',
  'group', 'enterprises',
]);

// Personal-name suffixes that should be ignored when picking the
// surname. Without this, "David Burrow Jr" abbreviates to "Jr".
const PERSON_SUFFIXES: ReadonlySet<string> = new Set([
  'jr', 'sr', 'i', 'ii', 'iii', 'iv', 'v',
]);

function normalize(w: string): string {
  return w.toLowerCase().replace(/[.,;:]/g, '');
}

/**
 * Abbreviate an owner name into a search-friendly term.
 *
 * Person names (no entity keyword, 1–4 words) → return surname
 *   "David Burrow"     → "Burrow"
 *   "David A. Burrow"  → "Burrow"
 *   "John Smith Jr."   → "Smith"   (suffix ignored)
 *   "Burrow"           → "Burrow"  (single-word — keep as-is)
 *
 * Entity names (contains Trust/Ranch/LLC/etc.) → first 1-2 words
 * before the first stop word
 *   "Eatwell River Farms Trust" → "Eatwell"
 *   "Twin Oaks Ranch"           → "Twin Oaks"
 *   "Lazy J Ranch"              → "Lazy J"
 *   "Smith Family Holdings"     → "Smith"
 *
 * Returns null when the input has no usable content.
 */
export function abbreviateOwner(rawName: string | null | undefined): string | null {
  if (!rawName) return null;
  const trimmed = rawName.trim();
  if (!trimmed) return null;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  if (words.length === 1) return words[0];

  const hasStopWord = words.some((w) => STOP_WORDS.has(normalize(w)));

  if (!hasStopWord) {
    // Person name path — return surname, ignoring suffixes
    let idx = words.length - 1;
    while (idx > 0 && PERSON_SUFFIXES.has(normalize(words[idx]))) {
      idx -= 1;
    }
    return words[idx];
  }

  // Entity path — collect words until the first stop word, cap at 2
  const result: string[] = [];
  for (const word of words) {
    if (STOP_WORDS.has(normalize(word))) break;
    result.push(word);
    if (result.length >= 2) break;
  }
  return result.length > 0 ? result.join(' ') : words[0];
}

/**
 * Build a chip set for the review-page search suggestions.
 * Generates up to 3 chips, varied to teach broker search strategies:
 *   - abbreviated grantee (if present)
 *   - abbreviated grantor surname(s) (deduped, max 1)
 *   - one combined "surname + county" chip showing refinement
 *
 * Multi-party grantors ("David Burrow, Justin Burrow") get split on
 * commas and deduplicated by abbreviated form — so "Burrow" only
 * shows once even if multiple Burrows are on the deed.
 */
export function buildOwnerSearchChips(opts: {
  grantee?: string | null;
  grantor?: string | null;
  county?: string | null;
}): string[] {
  const chips: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    chips.push(t);
  };

  // 1) Abbreviated grantee
  if (opts.grantee) {
    const a = abbreviateOwner(opts.grantee);
    if (a) add(a);
  }

  // 2) Abbreviated grantor (first party only — multiple grantors usually
  //    share a surname, so the first one's surname covers the family)
  let grantorAbbr: string | null = null;
  if (opts.grantor) {
    const firstParty = opts.grantor.split(',').map((s) => s.trim()).filter(Boolean)[0];
    if (firstParty) {
      grantorAbbr = abbreviateOwner(firstParty);
      if (grantorAbbr) add(grantorAbbr);
    }
  }

  // 3) Combined chip — picks the most distinctive seed (grantor surname
  //    preferred; grantee abbreviation as fallback) + county
  if (opts.county) {
    const seed = grantorAbbr ?? (opts.grantee ? abbreviateOwner(opts.grantee) : null);
    if (seed) {
      add(`${seed} ${opts.county} County`);
    }
  }

  return chips.slice(0, 3);
}

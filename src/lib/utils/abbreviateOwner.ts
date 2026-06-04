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
 * Is this "word" a real word? Filters out tokens that contain no
 * alphanumeric character (like "&", "/", "—") so they don't get
 * picked up as part of an abbreviation.
 *
 * Real bug this catches: "Schwartz & Ralston Investments, LLC" tokenizes
 * to ["Schwartz", "&", "Ralston", "Investments,", "LLC"]. The entity-
 * path picker would grab the first 2 ("Schwartz", "&") and produce
 * "Schwartz &" as a search chip — useless and looks broken to the
 * broker. After this filter the picker correctly skips "&" and grabs
 * the next real word, producing "Schwartz Ralston".
 */
function isRealWord(w: string): boolean {
  return /[a-z0-9]/i.test(w);
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

  // Drop pure-punctuation tokens like "&" before any picker logic runs.
  // Without this, "Schwartz & Ralston Investments LLC" would
  // abbreviate to "Schwartz &" because the entity picker grabs the
  // first two words and "&" counts as a word here.
  const words = trimmed.split(/\s+/).filter((w) => Boolean(w) && isRealWord(w));
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
 *
 * Generates up to 5 chips intentionally varied to teach broker search
 * strategies — each chip is a different *type* of query so the chip
 * set itself demonstrates the spectrum from broad to specific:
 *
 *   1. Full grantee name       "Eatwell River Farms Trust"  — canonical
 *                              entity as it appears on the deed
 *   2. Abbreviated grantee     "Eatwell"                    — distinctive word
 *   3. Abbreviated grantor     "Burrow"                     — surname (broadest match)
 *   4. Full grantor name       "David Burrow"               — specific person
 *   5. Combined refinement     "Burrow Gonzales County"     — narrow w/ place
 *
 * Per broker request, the FULL grantee leads — TxGIO sometimes
 * indexes the canonical entity name and a precise match has the
 * highest signal-to-noise. The abbreviated variant follows to cover
 * the case where TxGIO truncated or reformatted the name.
 *
 * Multi-party grantors ("David Burrow, Justin Burrow") get split on
 * commas; we use the first party for the surname + full-name chips.
 *
 * Dedup logic: if a chip's text matches one already in the set
 * (case-insensitive), it's skipped to avoid duplicates — e.g. a
 * single-word grantee "Burrow" would only render once even though
 * both the "full" and "abbreviated" paths produce the same string.
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

  // 1) Full grantee name — canonical entity as on the deed
  if (opts.grantee) {
    add(opts.grantee.trim());
  }

  // 2) Abbreviated grantee — distinctive word for fuzzy matches
  if (opts.grantee) {
    const a = abbreviateOwner(opts.grantee);
    if (a) add(a);
  }

  // First-party grantor (e.g. "David Burrow" out of "David Burrow, Justin Burrow")
  let firstGrantor: string | null = null;
  let grantorAbbr: string | null = null;
  if (opts.grantor) {
    const candidate = opts.grantor.split(',').map((s) => s.trim()).filter(Boolean)[0] ?? '';
    if (candidate) {
      firstGrantor = candidate;
      grantorAbbr = abbreviateOwner(candidate);
    }
  }

  // 3) Abbreviated grantor (surname) — broadest person match
  if (grantorAbbr) add(grantorAbbr);

  // 4) Full grantor name — specific person; deduped against surname
  if (firstGrantor && grantorAbbr) {
    if (firstGrantor.toLowerCase() !== grantorAbbr.toLowerCase()) {
      add(firstGrantor);
    }
  }

  // 5) Combined refinement — picks the most distinctive seed (grantor
  //    surname preferred; grantee abbreviation as fallback) + county
  if (opts.county) {
    const seed = grantorAbbr ?? (opts.grantee ? abbreviateOwner(opts.grantee) : null);
    if (seed) {
      add(`${seed} ${opts.county} County`);
    }
  }

  return chips.slice(0, 5);
}

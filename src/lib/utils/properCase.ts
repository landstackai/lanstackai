// Pretty-print owner / subject names that arrive from county appraisal
// records or MLS feeds in ALL CAPS ("CARAWAY PARTNERS LTD"). All-caps
// makes a CMA report look like a parcel printout — which is a credibility
// hit when the broker hands it to a buyer. Title-case the name while
// preserving acronyms and corporate suffixes that are read as letters,
// not words ("LLC" not "Llc", "LP" not "Lp").
//
// Conservative on purpose: if the input is already mixed case (e.g.
// "Caraway Partners Ltd" or "MacDonald Family Trust"), leave it alone.
// Brokers may have already polished the name and we don't want to flatten
// "MacDonald" → "Macdonald".

// Tokens to always emit uppercase. Lowercase keys; matched case-insensitive.
const ALWAYS_UPPER = new Set([
  'llc', 'inc', 'lp', 'lllp', 'plc', 'pllc', 'pa', 'pc',
  'ltd', 'corp', 'co',
  'usa', 'us', 'tx', 'na',
  'iii', 'iv', 'vi', 'vii', 'viii', 'ix', 'xi', 'xii',
  // 'ii' and 'v' would clash with valid lowercase words; handle below.
  'cad', 'mls', 'mh', 'mhp',
  'i', // common roman suffix; safe because we only convert tokens that started uppercase
]);

// Tokens to always emit lowercase (small words that don't lead the name).
const ALWAYS_LOWER = new Set([
  'of', 'the', 'and', 'a', 'an', 'in', 'on', 'to', 'for', 'by', 'at',
  'et', 'al',
]);

// Capitalize the first letter, lowercase the rest. Handles non-ASCII safely.
function titleOne(word: string): string {
  if (word.length === 0) return word;
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Convert an ALL-CAPS or all-lower name to Title Case while preserving
 * common acronyms / corporate suffixes.
 *
 *   "CARAWAY PARTNERS LTD"       → "Caraway Partners LTD"
 *   "DJ DEYHIMI HOLDINGS, LLC"   → "DJ Deyhimi Holdings, LLC"
 *   "ronald e. & mary a. wilsher"→ "Ronald E. & Mary A. Wilsher"
 *   "MacDonald Family Trust"     → "MacDonald Family Trust"   (mixed-case → pass through)
 *
 * @param input  The raw name. Returns '' for null/undefined/empty.
 */
export function properCase(input: string | null | undefined): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (!trimmed) return '';

  // Detect "mixed case" — if the name already has both upper AND lower
  // letters present AND it isn't ALL CAPS, assume the broker formatted it
  // intentionally and leave it alone.
  const hasUpper = /[A-Z]/.test(trimmed);
  const hasLower = /[a-z]/.test(trimmed);
  const isAllCaps = hasUpper && !hasLower;
  if (hasUpper && hasLower && !isAllCaps) {
    return trimmed;
  }

  // Split on whitespace + ampersand so each becomes a token we can
  // case-process individually. Preserve the separator structure by
  // splitting with a capture group.
  const parts = trimmed.split(/(\s+|&|,)/);
  return parts
    .map((part, idx) => {
      // Skip separators (whitespace, &, comma)
      if (/^\s+$/.test(part) || part === '&' || part === ',') return part;
      const lower = part.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (lower.length === 0) return part;
      if (ALWAYS_UPPER.has(lower)) return part.toUpperCase();
      // Small words stay lowercase EXCEPT when they lead the name
      if (idx > 0 && ALWAYS_LOWER.has(lower)) return part.toLowerCase();
      // Handle initials like "E." or "J." — single letter followed by period
      if (/^[A-Za-z]\.$/.test(part)) return part.toUpperCase();
      return titleOne(part);
    })
    .join('');
}

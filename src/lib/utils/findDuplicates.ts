// ─────────────────────────────────────────────────────────────────────────
// Duplicate-comp detection.
//
// Identifies likely-duplicate comps based on a deterministic signature:
//   - sale_date matches exactly
//   - sale_price matches within $1
//   - grantor + grantee match (fuzzy, normalized)
//
// What this catches:
//   - Re-importing the same PDF (3 L & D Farm and Ranch rows from
//     debugging the math gate — same transaction every time)
//   - Slight variations of the same entry (different acres / coords /
//     parcel_ids but same transaction)
//
// What this does NOT catch (intentionally — these are legit comps):
//   - Same property selling twice in the same year — grantor/grantee
//     change on the second sale (flip = new owner), signature differs
//   - Same property selling years apart — date differs
//   - Coincidental matches: two unrelated transactions for the same
//     price on the same date are vanishingly unlikely if both grantor
//     and grantee also match by name
//
// Confidence tiers:
//   - 'exact'  — date + price + grantor + grantee ALL match (very high
//                confidence this is the same transaction)
//   - 'high'   — date + price match, only one of grantor/grantee matches
//                (could still be the same deal with a name typo)
//
// Returned matches are sorted exact-first so the UI can lead with the
// most damning case.
// ─────────────────────────────────────────────────────────────────────────

import type { Comp } from '@/types';

export type DuplicateConfidence = 'exact' | 'high';

export type DuplicateMatch = {
  comp: Comp;
  confidence: DuplicateConfidence;
  matchedOn: string[];
};

export type DuplicateCandidate = {
  id?: string;                         // present when checking an existing row vs. others
  grantor?: string | null;
  grantee?: string | null;
  sale_date?: string | null;
  sale_price?: number | null;
};

// Normalize a name for fuzzy comparison. Strips punctuation, casing,
// entity suffixes (LLC/LTD/etc), and common filler words ("et al",
// "the", "and"). So "L & D Farm and Ranch, LLC" and "L&D Farm and
// Ranch LLC" and "L D Farm Ranch" all reduce to the same canonical
// form. Conservative: doesn't try Levenshtein, just string equality
// after normalization.
function normalizeName(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[.,'’]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(llc|l\.?l\.?c\.?|ltd|inc|llp|lp|trust|company|co|et\s*al|the|and|&)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find existing comps that look like duplicates of `candidate`.
 *
 * @param candidate    The comp being imported / about to be saved
 * @param existing     The pool of saved comps to check against
 * @returns Array of matches sorted by confidence (exact first). Empty
 *          array means no duplicates detected.
 *
 * Requires at minimum that `candidate` has BOTH sale_date AND
 * sale_price — without those, the signature isn't strong enough to
 * call anything a duplicate (returns []).
 *
 * When checking an existing row against the rest of the pool, pass
 * `candidate.id` so we skip self-matches.
 */
export function findDuplicateCandidates(
  candidate: DuplicateCandidate,
  existing: Comp[]
): DuplicateMatch[] {
  const candDate = candidate.sale_date || '';
  const candPrice = Number(candidate.sale_price || 0);
  // Bail when the signature is too weak to make a confident call.
  // sale_date + sale_price alone has too many coincidence opportunities
  // — we also need at least one party (grantor or grantee).
  if (!candDate || !(candPrice > 0)) return [];
  const candGrantor = normalizeName(candidate.grantor);
  const candGrantee = normalizeName(candidate.grantee);
  if (!candGrantor && !candGrantee) return [];

  const matches: DuplicateMatch[] = [];
  for (const comp of existing) {
    if (candidate.id && comp.id === candidate.id) continue; // self-skip
    const ePrice = Number(comp.sale_price || 0);
    const eDate = comp.sale_date || '';
    if (!eDate || !(ePrice > 0)) continue;
    if (eDate !== candDate) continue;
    if (Math.abs(ePrice - candPrice) >= 1) continue;

    const eGrantor = normalizeName(comp.grantor);
    const eGrantee = normalizeName(comp.grantee);
    const grantorMatch = candGrantor.length > 0 && candGrantor === eGrantor;
    const granteeMatch = candGrantee.length > 0 && candGrantee === eGrantee;

    // At least one party must match — otherwise it's just two
    // transactions that happened to close for the same price on the
    // same day, which is too thin to flag.
    if (!grantorMatch && !granteeMatch) continue;

    const matchedOn = ['sale_date', 'sale_price'];
    if (grantorMatch) matchedOn.push('grantor');
    if (granteeMatch) matchedOn.push('grantee');

    matches.push({
      comp,
      confidence: grantorMatch && granteeMatch ? 'exact' : 'high',
      matchedOn,
    });
  }

  return matches.sort((a, b) => {
    if (a.confidence !== b.confidence) {
      return a.confidence === 'exact' ? -1 : 1;
    }
    return 0;
  });
}

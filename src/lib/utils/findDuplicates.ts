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

// ─────────────────────────────────────────────────────────────────────────
// Cluster detection across the whole vault
// ─────────────────────────────────────────────────────────────────────────
//
// findDuplicateCandidates above is pairwise + import-time strict (exact date
// + price within $1 + party match). Good for "is this new import already
// in my vault?" but too tight for spotting duplicates that ALREADY landed
// in the vault — because the rule below tolerates:
//
//   - Acreage variance ±1% (CAD vs appraisal rounding)
//   - Sale price variance ±0.1% (rounding noise)
//   - Sale date variance ±30 days (closing vs deed-recording date drift)
//   - Missing-field skips (MLS sheets without grantor/grantee still cluster
//     if everything else matches)
//
// What this catches that findDuplicateCandidates misses:
//   - The "VC5 Properties LLC." vs "VC5 Properties, LLC" cluster from the
//     vault screenshot — same property entered four ways with formatting
//     drift. Strict pairwise misses because acreage rounds differently
//     in one source vs another, or price is off by $50 due to closing fees.
//
// What this still doesn't catch (intentional v1 cost):
//   - 1-char typo in name (VC5 vs VCS) where the typo flips the name match.
//     Future fuzzy work if we see it in production.
//   - Two unrelated transactions with by-chance-identical 4-field fingerprint
//     but different sale_dates >30 days apart — sale_date check protects us.
//
// Clustering uses union-find so an indirect duplicate chain (A↔B, B↔C →
// A,B,C are one cluster) groups together. Returns clusters of size ≥2
// only — single comps aren't "duplicates of themselves."

export type DuplicateClusterInput = {
  id: string;
  county?: string | null;
  acres?: number | null;
  sale_price?: number | null;
  sale_date?: string | null;
  grantor?: string | null;
  grantee?: string | null;
};

export type DuplicateCluster = {
  /** Stable cluster id (smallest comp id in the cluster, for React keys). */
  key: string;
  /** Comp ids that are duplicates of each other. Length ≥ 2. */
  ids: string[];
};

/** Normalize county string for comparison — lowercase, strip "County",
 *  collapse whitespace. Handles "Frio County" vs "Frio" vs "FRIO". For
 *  multi-county fields ("Atascosa, Frio") we split + sort + rejoin so
 *  "Frio, Atascosa" and "Atascosa, Frio" match. */
function normalizeCountyField(s: unknown): string {
  const raw = String(s ?? '').toLowerCase();
  if (!raw) return '';
  const parts = raw
    .split(/[,&]|\s+and\s+/i)
    .map((p) => p.replace(/\bcount(y|ies)\b/gi, '').trim())
    .filter(Boolean);
  parts.sort();
  return parts.join(',');
}

/**
 * Do these two comps look like the same transaction under the locked rule?
 *
 * Rule:
 *   - Same county (after normalization)
 *   - Acreage matches within ±1%
 *   - Sale price matches within ±0.1% (effectively exact, allows for $50
 *     rounding noise on a $5M sale)
 *   - Grantor or grantee tokens overlap (SKIP this check if both comps
 *     are missing owner data)
 *   - Sale date within ±30 days (SKIP this check if one is missing the date)
 *
 * Missing-field semantics: "skip that check" not "fail the rule." But at
 * least one of (owner check, date check) must run — otherwise the rule
 * is just (county + acreage + price) which has too many coincidence
 * opportunities to call duplicate.
 */
function looksLikeDuplicate(a: DuplicateClusterInput, b: DuplicateClusterInput): boolean {
  // County — required
  const ca = normalizeCountyField(a.county);
  const cb = normalizeCountyField(b.county);
  if (!ca || !cb || ca !== cb) return false;

  // Acreage — required, ±1%
  const aa = Number(a.acres);
  const ab = Number(b.acres);
  if (!(aa > 0) || !(ab > 0)) return false;
  if (Math.abs(aa - ab) / Math.max(aa, ab) > 0.01) return false;

  // Sale price — required, ±0.1%
  const pa = Number(a.sale_price);
  const pb = Number(b.sale_price);
  if (!(pa > 0) || !(pb > 0)) return false;
  if (Math.abs(pa - pb) / Math.max(pa, pb) > 0.001) return false;

  // Owner check (skip if both missing).
  const na = normalizeName(a.grantor) + '|' + normalizeName(a.grantee);
  const nb = normalizeName(b.grantor) + '|' + normalizeName(b.grantee);
  const aHasOwner = na !== '|';
  const bHasOwner = nb !== '|';
  let ownerCheckRan = false;
  let ownerCheckPassed = false;
  if (aHasOwner && bHasOwner) {
    ownerCheckRan = true;
    const grantorMatch =
      normalizeName(a.grantor).length > 0 && normalizeName(a.grantor) === normalizeName(b.grantor);
    const granteeMatch =
      normalizeName(a.grantee).length > 0 && normalizeName(a.grantee) === normalizeName(b.grantee);
    ownerCheckPassed = grantorMatch || granteeMatch;
    if (!ownerCheckPassed) return false;
  }

  // Date check (skip if either is missing).
  const da = a.sale_date || '';
  const db = b.sale_date || '';
  let dateCheckRan = false;
  let dateCheckPassed = false;
  if (da && db) {
    const tA = Date.parse(da);
    const tB = Date.parse(db);
    if (Number.isFinite(tA) && Number.isFinite(tB)) {
      dateCheckRan = true;
      const days = Math.abs(tA - tB) / (1000 * 60 * 60 * 24);
      dateCheckPassed = days <= 30;
      if (!dateCheckPassed) return false;
    }
  }

  // At least one of the soft checks must have actually run. Without
  // either, the fingerprint is just (county + acreage + price) which
  // has too much coincidence risk — two different families selling
  // similar tracts at the same comp-set price in the same county is
  // rare but not implausible. Requiring owner OR date as a tiebreaker
  // protects against that.
  if (!ownerCheckRan && !dateCheckRan) return false;

  return true;
}

/**
 * Scan an entire pool of comps and return all clusters of size ≥ 2.
 *
 * O(N²) pairwise — fine up to a few thousand comps per broker. Beyond
 * that, partition by county first (only comps in the same county can
 * cluster anyway) and run the pairwise scan per partition.
 *
 * Optional `dismissedPairs` excludes pairs the broker has already marked
 * as "not duplicates" so we don't keep nagging them about the same
 * false positive. Format: a Set of strings "smallerId|largerId".
 */
export function findDuplicateClusters(
  comps: DuplicateClusterInput[],
  dismissedPairs?: Set<string>
): DuplicateCluster[] {
  if (comps.length < 2) return [];

  // Partition by normalized county — only comps in the same county can
  // ever match. Cuts the pairwise comparisons by ~Nx where N is the
  // number of counties.
  const byCounty = new Map<string, DuplicateClusterInput[]>();
  for (const c of comps) {
    const key = normalizeCountyField(c.county);
    if (!key) continue;
    const arr = byCounty.get(key) || [];
    arr.push(c);
    byCounty.set(key, arr);
  }

  // Union-find: comp.id → parent id
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let p = parent.get(id) || id;
    while (p !== (parent.get(p) || p)) {
      p = parent.get(p) || p;
    }
    parent.set(id, p);
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      // Smaller id wins so cluster keys are stable across runs.
      if (ra < rb) parent.set(rb, ra);
      else parent.set(ra, rb);
    }
  };

  // Pairwise scan within each county partition.
  for (const partition of Array.from(byCounty.values())) {
    for (let i = 0; i < partition.length; i++) {
      for (let j = i + 1; j < partition.length; j++) {
        const a = partition[i];
        const b = partition[j];

        // Sticky dismissal — broker already said "not a duplicate" for
        // this pair, don't re-suggest.
        if (dismissedPairs) {
          const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (dismissedPairs.has(key)) continue;
        }

        if (looksLikeDuplicate(a, b)) {
          union(a.id, b.id);
        }
      }
    }
  }

  // Group by root.
  const groups = new Map<string, string[]>();
  for (const c of comps) {
    const root = find(c.id);
    if (root === c.id) {
      // Will be added when others find it, or stays solo (filtered below)
      if (!groups.has(root)) groups.set(root, [c.id]);
      else groups.get(root)!.push(c.id);
    } else {
      const list = groups.get(root) || [root];
      if (!list.includes(c.id)) list.push(c.id);
      groups.set(root, list);
    }
  }

  // Return only multi-member clusters, sorted so the largest cluster
  // surfaces first (broker triages the worst dupes first).
  const clusters: DuplicateCluster[] = [];
  Array.from(groups.entries()).forEach(([root, ids]) => {
    if (ids.length >= 2) {
      const dedup = Array.from(new Set(ids)).sort();
      clusters.push({ key: root, ids: dedup });
    }
  });
  clusters.sort((a, b) => b.ids.length - a.ids.length);
  return clusters;
}

// Phase 2a — extraction safety layer. Runs AFTER AI extraction completes,
// BEFORE the comp is saved to the vault. Catches the dumbest errors the AI
// can produce: fabricated coordinates outside Texas, math that doesn't
// add up, dates in the future, etc.
//
// Design principle: this layer can FLAG a comp or NULL OUT a clearly-bad
// field, but it should never QUIETLY OVERRIDE a value. If lat/lng look
// hallucinated (way outside Texas), null them — the downstream auto-locate
// chain will take over. If acres × ppa wildly disagree with sale_price,
// log a warning + flag the comp so the broker sees it during review.
//
// Why this is separate from saveComp: saveComp has its own resilient-retry
// logic for schema-cache misses; we don't want to bury validation in there.
// This sanitizer runs as a clean checkpoint between extraction and save.

export interface SanityWarning {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface SanityResult<T> {
  comp: T;
  warnings: SanityWarning[];
}

// ─── County normalization (local copy of the storage rule) ───────────
// We don't import normalizeCountyForStorage here to avoid a hard dep —
// the sanity layer should be readable in isolation. This is the same
// idea: lowercase, strip "County" suffix, take the first segment if a
// compound is given. Used by crossCheckGeocodedCounty below.
function canonCounty(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Take only the first piece on a compound ("Atascosa, Wilson" → "Atascosa")
  const first = s.split(/\s+and\s+|\s*&\s*|\s*,\s*|\s*\/\s*/i)[0] || '';
  const cleaned = first.toLowerCase().replace(/\bcounty\b/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

// Texas bounding box. Slight padding on each side so legitimate parcels
// at the very edge of the state still pass. Outside this box → almost
// certainly an AI hallucination or a typo we shouldn't trust.
const TX_BBOX = {
  minLat: 25.5,
  maxLat: 36.8,
  minLng: -107.0,
  maxLng: -93.3,
};

function isInTexas(lat: number, lng: number): boolean {
  return (
    lat >= TX_BBOX.minLat &&
    lat <= TX_BBOX.maxLat &&
    lng >= TX_BBOX.minLng &&
    lng <= TX_BBOX.maxLng
  );
}

/**
 * Run sanity checks against an extracted comp. Mutates clearly-bad fields
 * (e.g., NULLs out hallucinated coords) and returns a list of warnings to
 * surface in logs and (eventually) the review UI.
 */
export function sanitizeExtractedComp<T extends Record<string, any>>(
  comp: T,
): SanityResult<T> {
  const warnings: SanityWarning[] = [];
  const out = { ...comp } as T;

  // ─── Lat/lng bounding box check ─────────────────────────────────
  // If the AI extracted coords but they don't land in Texas, NULL them
  // out so the downstream auto-locate chain (owner-name parcel match +
  // address geocode fallback) takes over. Better to retry the locator
  // than to save coords that put the comp in Mexico.
  const lat = Number(out.latitude);
  const lng = Number(out.longitude);
  if (out.latitude != null && out.longitude != null) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      warnings.push({
        field: 'latitude/longitude',
        message: `non-numeric coords (${out.latitude}, ${out.longitude}) — nulled`,
        severity: 'error',
      });
      (out as any).latitude = null;
      (out as any).longitude = null;
    } else if (!isInTexas(lat, lng)) {
      warnings.push({
        field: 'latitude/longitude',
        message: `coords (${lat}, ${lng}) are outside Texas bbox — likely AI hallucination, nulled to retry auto-locate`,
        severity: 'error',
      });
      (out as any).latitude = null;
      (out as any).longitude = null;
    }
  }

  // ─── Math gate: PPA × acres ≈ sale_price ─────────────────────────
  // Catches the New Braunfels Land Sale 3 class of bug (AI extracts the
  // wrong acres from the narrative — 349.7 instead of 344.96 — and the
  // math no longer ties to the sale price). Tolerance is 5% to allow for
  // rounding, broker-adjusted PPAs, etc. — anything outside that range
  // is a strong signal that ONE of the three values is wrong.
  const acres = Number(out.acres);
  const salePrice = Number(out.sale_price);
  const ppa = Number(out.price_per_acre);
  if (
    Number.isFinite(acres) && acres > 0 &&
    Number.isFinite(salePrice) && salePrice > 0 &&
    Number.isFinite(ppa) && ppa > 0
  ) {
    const computed = salePrice / acres;
    const drift = Math.abs(computed - ppa) / ppa;
    if (drift > 0.05) {
      warnings.push({
        field: 'acres × price_per_acre',
        message:
          `math gate: sale_price ${salePrice} ÷ acres ${acres} = ${computed.toFixed(0)}/ac, ` +
          `but extracted PPA was ${ppa}/ac (${(drift * 100).toFixed(1)}% drift). ` +
          `One of these three fields likely came from the wrong source.`,
        severity: 'warning',
      });
    }
  }

  // ─── Sale date sanity ────────────────────────────────────────────
  // Future-dated sales are almost always an AI typo (year inversion, etc.).
  if (out.sale_date) {
    try {
      const d = new Date(out.sale_date as string);
      const now = new Date();
      if (Number.isFinite(d.getTime())) {
        if (d.getTime() > now.getTime() + 86_400_000) {
          // > 1 day in the future is suspect (allow today, allow brokers
          // entering a same-day pending deal, but not next-year sales).
          warnings.push({
            field: 'sale_date',
            message: `sale_date ${out.sale_date} is in the future — likely typo`,
            severity: 'warning',
          });
        }
        // Pre-1990 dates are usually OCR errors on 19xx vs 20xx.
        if (d.getFullYear() < 1990) {
          warnings.push({
            field: 'sale_date',
            message: `sale_date ${out.sale_date} is before 1990 — likely OCR error on year`,
            severity: 'warning',
          });
        }
      }
    } catch {
      // Invalid date string — leave warning, don't crash.
      warnings.push({
        field: 'sale_date',
        message: `sale_date "${out.sale_date}" couldn't be parsed`,
        severity: 'warning',
      });
    }
  }

  // ─── Required-field presence ─────────────────────────────────────
  // These are the fields a comp NEEDS to be useful in a CMA. Missing
  // any of them is fine (broker can fix), but we surface so it shows
  // up in the verification card with explicit "missing" markers rather
  // than silently passing through.
  const required: Array<{ key: keyof T; label: string }> = [
    { key: 'acres' as keyof T, label: 'acres' },
    { key: 'sale_price' as keyof T, label: 'sale_price' },
    { key: 'sale_date' as keyof T, label: 'sale_date' },
    { key: 'county' as keyof T, label: 'county' },
  ];
  for (const { key, label } of required) {
    const v = out[key];
    if (v == null || (typeof v === 'string' && v.trim() === '') || (typeof v === 'number' && v === 0)) {
      warnings.push({
        field: label,
        message: `required field ${label} is missing/empty`,
        severity: 'warning',
      });
    }
  }

  // Stash warnings on the comp under a transient key. The review UI can
  // pick this up later (Phase 3). For now it's just for logging.
  (out as any)._sanity_warnings = warnings;

  return { comp: out, warnings };
}

/**
 * Cross-check the AI-extracted county against a geocoded county
 * (returned by Mapbox v6 in geocodePlace.ts). Mutates the comp in
 * place: appends a warning to _sanity_warnings if the counties
 * disagree. Returns true when a mismatch was flagged.
 *
 * Designed to be called from the locator path RIGHT AFTER a geocode
 * hit, so we don't burn an extra Mapbox call just to validate. The
 * cheap path (auto-locate already returned the right parcel) skips
 * this entirely — that match is already validated by acres + owner.
 *
 * NOTE: Mapbox's county is the "ground truth" for the geocoded
 * address; the extracted county is the AI's read of the document.
 * If they disagree, one of:
 *   1. AI got the county wrong (most common — flag the comp)
 *   2. Address itself was wrong/typo'd (Mapbox geocoded to the
 *      wrong city, county is right) → still worth surfacing
 *   3. Comp straddles a county line (rare for land sales of any
 *      meaningful size) → broker can dismiss the warning
 *
 * We never auto-correct the county here. The broker decides during
 * Phase 3 review.
 */
export function crossCheckGeocodedCounty<T extends Record<string, any>>(
  comp: T,
  geocoded: { county?: string | null } | null,
): boolean {
  if (!geocoded || !geocoded.county) return false;
  const extracted = canonCounty(comp.county);
  const resolved = canonCounty(geocoded.county);
  if (!extracted || !resolved) return false;
  if (extracted === resolved) return false;

  const warning: SanityWarning = {
    field: 'county',
    message:
      `county mismatch: extracted "${comp.county}" but geocoded address resolves to "${geocoded.county}". ` +
      `One of these is wrong — likely the AI misread the county header.`,
    severity: 'warning',
  };
  const existing = Array.isArray((comp as any)._sanity_warnings)
    ? (comp as any)._sanity_warnings as SanityWarning[]
    : [];
  (comp as any)._sanity_warnings = [...existing, warning];
  return true;
}

/**
 * Batch helper. Runs sanity on every comp, returns the array of sanitized
 * comps + a flat summary of warnings for logging.
 */
export function sanitizeExtractedBatch<T extends Record<string, any>>(
  comps: T[],
): { comps: T[]; totalWarnings: number; errorCount: number } {
  let totalWarnings = 0;
  let errorCount = 0;
  const out = comps.map((c) => {
    const { comp, warnings } = sanitizeExtractedComp(c);
    totalWarnings += warnings.length;
    errorCount += warnings.filter((w) => w.severity === 'error').length;
    if (warnings.length > 0) {
      const label = (c as any).property_name || (c as any)._boundary_label || 'unnamed comp';
      console.warn(
        `[sanity] ${label} (${warnings.length} warning${warnings.length === 1 ? '' : 's'}):\n` +
        warnings.map((w) => `  • [${w.severity}] ${w.field}: ${w.message}`).join('\n')
      );
    }
    return comp;
  });
  return { comps: out, totalWarnings, errorCount };
}

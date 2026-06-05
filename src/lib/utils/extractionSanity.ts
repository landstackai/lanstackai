// Phase 2a — extraction safety layer. Runs AFTER AI extraction completes,
// BEFORE the comp is saved to the vault. Catches the dumbest errors the AI
// can produce: fabricated coordinates outside the comp's state (or CONUS
// when the state isn't profiled yet), math that doesn't add up, dates in
// the future, etc.
//
// Design principle: this layer can FLAG a comp or NULL OUT a clearly-bad
// field, but it should never QUIETLY OVERRIDE a value. If lat/lng look
// hallucinated (way outside the expected geography), null them — the
// downstream auto-locate chain will take over. If acres × ppa wildly
// disagree with sale_price, log a warning + flag the comp so the broker
// sees it during review.
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

// ─── Bounding boxes for sanity-checking AI-extracted coordinates ─────
//
// Texas was the only state for V1, but the product is not TX-only long
// term — adding a state means dropping its bbox in STATE_BBOXES below
// (a one-line change). Until a state is registered, comps from that
// state fall back to CONUS_BBOX, which still catches the bad cases
// the sanity layer was designed for (AI hallucinated coords in Mexico,
// Canada, Europe, etc.) while not nulling legitimate out-of-TX comps.
//
// Each bbox is padded ~20-25 miles outside the actual state border so
// parcels along the very edge still pass.
type Bbox = { minLat: number; maxLat: number; minLng: number; maxLng: number };

const STATE_BBOXES: Record<string, Bbox> = {
  TX: { minLat: 25.5, maxLat: 36.8, minLng: -107.0, maxLng: -93.3 },
  // Add states here as the product expands. Each entry should pad the
  // actual state bounds by ~0.3° on each side. Quick reference for
  // common land-broker expansion targets when we get there:
  //   OK: { minLat: 33.3, maxLat: 37.3, minLng: -103.3, maxLng: -94.1 }
  //   NM: { minLat: 31.0, maxLat: 37.3, minLng: -109.3, maxLng: -102.7 }
  //   LA: { minLat: 28.6, maxLat: 33.3, minLng:  -94.4, maxLng: -88.5 }
  //   AR: { minLat: 32.7, maxLat: 36.9, minLng:  -94.9, maxLng: -89.4 }
  //   CO: { minLat: 36.7, maxLat: 41.3, minLng: -109.3, maxLng: -101.7 }
};

// Continental US fallback. Used when a comp's `state` field doesn't
// match any registered bbox above. Wide net — catches truly bad coords
// (AI returned a European or Latin American location) without rejecting
// legitimate US parcels in states we haven't profiled yet.
const CONUS_BBOX: Bbox = {
  minLat: 24.0,    // south tip of FL (with padding for Keys)
  maxLat: 49.7,    // northern edge MN/ND/WA
  minLng: -125.5,  // Pacific edge WA
  maxLng: -66.5,   // ME / FL east coast
};

function isInBbox(lat: number, lng: number, b: Bbox): boolean {
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

/**
 * Look up the bbox to validate against for this comp's state. Returns
 * the per-state bbox if registered, otherwise the CONUS fallback.
 *
 * `state` is the 2-letter code from comp.state. We accept lowercase
 * or null and normalize to upper. Unknown states get CONUS — better
 * to let a coord through than to null a legitimate parcel just
 * because we haven't profiled the state yet.
 */
function bboxForState(state: unknown): { bbox: Bbox; scope: 'state' | 'conus' } {
  if (typeof state === 'string') {
    const code = state.trim().toUpperCase();
    if (code && STATE_BBOXES[code]) {
      return { bbox: STATE_BBOXES[code], scope: 'state' };
    }
  }
  return { bbox: CONUS_BBOX, scope: 'conus' };
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
  // If the AI extracted coords but they don't land in the comp's
  // state (or in CONUS for un-profiled states), NULL them out so the
  // downstream auto-locate chain (owner-name parcel match + address
  // geocode fallback) takes over. Better to retry the locator than
  // to save coords that put the comp in Mexico.
  //
  // bboxForState() returns the per-state bbox when comp.state is a
  // registered code (today: TX only), otherwise falls back to a
  // CONUS-wide bbox. Expanding to a new state = adding one entry
  // to STATE_BBOXES, no other code changes needed.
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
    } else {
      const { bbox, scope } = bboxForState(out.state);
      if (!isInBbox(lat, lng, bbox)) {
        const scopeLabel = scope === 'state'
          ? `${String(out.state).toUpperCase()} bbox`
          : 'CONUS bbox';
        warnings.push({
          field: 'latitude/longitude',
          message:
            `coords (${lat}, ${lng}) are outside ${scopeLabel} — likely AI hallucination, ` +
            `nulled to retry auto-locate`,
          severity: 'error',
        });
        (out as any).latitude = null;
        (out as any).longitude = null;
      }
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

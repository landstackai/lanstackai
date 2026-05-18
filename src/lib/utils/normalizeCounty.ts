// ─────────────────────────────────────────────────────────────────────────
// Canonical county-name normalization for STORAGE.
//
// Background: the AI extraction pipeline was producing inconsistent county
// values — "Frio County", "Frio", "Frio and Medina", "Atascosa & Frio",
// "frio county", etc. — which silently broke county-based filtering and
// made the data hard to reason about.
//
// This util collapses every input into ONE canonical form:
//   - Titlecase ("Frio", not "FRIO" or "frio")
//   - No "County" suffix
//   - Compound counties joined by ", " (a single comma + space)
//   - No duplicate counties within the string
//
// Examples:
//   "Frio County"        → "Frio"
//   "frio"               → "Frio"
//   "FRIO"               → "Frio"
//   " Frio County "      → "Frio"
//   "Frio and Medina"    → "Frio, Medina"
//   "Atascosa & Frio"    → "Atascosa, Frio"
//   "Atascosa, Wilson"   → "Atascosa, Wilson"
//   "Frio / Medina"      → "Frio, Medina"
//   "Frio and FRIO"      → "Frio"     (deduped)
//   null / "" / "   "    → null
//
// Apply this at EVERY comp insert/update site so the database stays
// canonical. Read-side code in the map page still uses suffix-tolerant
// matching (splitCounties) as defense-in-depth for any pre-canonical
// rows that linger.
// ─────────────────────────────────────────────────────────────────────────

export function normalizeCountyForStorage(raw: unknown): string | null {
  if (raw == null) return null;
  const input = String(raw).trim();
  if (input.length === 0) return null;

  // Split on compound separators: " and " / " & " / "," / "/"
  // Case-insensitive on "and" so "AND" doesn't survive.
  const pieces = input.split(/\s+and\s+|\s*&\s*|\s*,\s*|\s*\/\s*/i);

  const canonical: string[] = [];
  const seen = new Set<string>();
  for (let piece of pieces) {
    piece = piece
      .toLowerCase()
      .replace(/\bcounty\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!piece) continue;
    // Titlecase each word ("medina" → "Medina", "san saba" → "San Saba")
    const titlecased = piece
      .split(' ')
      .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : ''))
      .join(' ');
    const dedupeKey = titlecased.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    canonical.push(titlecased);
  }

  return canonical.length > 0 ? canonical.join(', ') : null;
}

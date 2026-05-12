'use client';

/**
 * FeatureChip — displays a categorical comp attribute (water, road, dev,
 * minerals) as a small labeled box. When `strong` is true the chip is
 * "lit up" with emerald accents to signal a value-driving feature; when
 * the value is missing/None it renders muted so the eye skips it.
 *
 * Visual language matches the Mid-row highlight in the averages tables.
 */
type FeatureChipProps = {
  label: string;
  value: string | null | undefined;
  strong?: boolean;
};

export function FeatureChip({ label, value, strong = false }: FeatureChipProps) {
  const trimmed = (value ?? '').trim();
  const displayValue = trimmed.length > 0 ? trimmed : 'None';
  // "Empty" state for grey-out: literally none, or no value at all.
  const isEmpty = trimmed.length === 0 || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'n/a';

  return (
    <div
      className={`rounded-lg p-2 border transition-colors ${
        strong ? 'bg-emerald-400/10 border-emerald-400/30' : 'bg-card border-border'
      }`}
    >
      <p
        className={`text-[9px] font-bold uppercase tracking-wider ${
          strong ? 'text-emerald-300/80' : 'text-slate-500'
        }`}
      >
        {label}
      </p>
      <p
        className={`text-xs font-bold mt-0.5 ${
          strong ? 'text-emerald-200' : isEmpty ? 'text-slate-500' : 'text-white'
        }`}
      >
        {displayValue}
      </p>
    </div>
  );
}

/**
 * Per-attribute rule for what counts as a "strong" feature.
 * - water: "Strong" is the top tier on a None/Seasonal/Strong scale
 * - road_frontage: "High" is the top tier
 * - dev_potential: "High" drives broader buyer pool → typically higher $/ac
 * - irrigation: 3-tier (None / Medium / Strong). Only "Strong" (active center
 *   pivot, drip, current row crops) highlights — that's the value-driver tier
 *   that trades at multiples of dry-land prices in the same submarket.
 * - minerals_sold: kept for historical callers. The minerals chip itself was
 *   demoted in favor of Irrigation; minerals data is still searchable.
 */
export function isStrongFeature(
  attr: 'water' | 'road' | 'dev' | 'irrigation' | 'minerals',
  value: string | null | undefined
): boolean {
  if (!value) return false;
  const v = value.trim();
  switch (attr) {
    case 'water':
      return v === 'Strong';
    case 'road':
      return v === 'High';
    case 'dev':
      return v === 'High';
    case 'irrigation':
      return v === 'Strong';
    case 'minerals':
      return /\b(all|owned)\b/i.test(v);
  }
}

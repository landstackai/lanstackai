'use client';

/**
 * FeatureChip — displays a categorical comp attribute (water, road, dev,
 * minerals, irrigation) as a small labeled box. When `strong` is true the
 * chip "lights up"; when the value is None/missing it renders muted.
 *
 * Strong-state color coding by attribute (semantic palette):
 *   water       → sky blue     (water = blue, universal)
 *   dev         → purple        (development = future, growth)
 *   road        → olive        (earthen — paths/roads default)
 *   irrigation  → olive        (agricultural)
 *   minerals    → olive        (resource — default)
 *
 * Distinct colors give the right-panel grid visual variety without
 * randomness — every color carries semantic meaning. Falls back to olive
 * when no attr is passed (backwards-compatible).
 */
type AttrKey = 'water' | 'road' | 'dev' | 'irrigation' | 'minerals';

type FeatureChipProps = {
  label: string;
  value: string | null | undefined;
  strong?: boolean;
  attr?: AttrKey;
};

// Strong-state palettes per attribute. Each token group has bg / border /
// label-text / value-text variants tuned for the cream surface.
const STRONG_PALETTE: Record<AttrKey, {
  bg: string;
  border: string;
  label: string;
  value: string;
}> = {
  water: {
    bg: 'bg-sky-50',
    border: 'border-sky-200',
    label: 'text-sky-700/80',
    value: 'text-sky-700',
  },
  dev: {
    bg: 'bg-purple-50',
    border: 'border-purple-200',
    label: 'text-purple-700/80',
    value: 'text-purple-700',
  },
  road: {
    bg: 'bg-olive-tint',
    border: 'border-olive-border',
    label: 'text-olive-2/80',
    value: 'text-olive-2',
  },
  irrigation: {
    bg: 'bg-olive-tint',
    border: 'border-olive-border',
    label: 'text-olive-2/80',
    value: 'text-olive-2',
  },
  minerals: {
    bg: 'bg-olive-tint',
    border: 'border-olive-border',
    label: 'text-olive-2/80',
    value: 'text-olive-2',
  },
};

const DEFAULT_STRONG = STRONG_PALETTE.road;

export function FeatureChip({ label, value, strong = false, attr }: FeatureChipProps) {
  const trimmed = (value ?? '').trim();
  const displayValue = trimmed.length > 0 ? trimmed : 'None';
  // "Empty" state for grey-out: literally none, or no value at all.
  const isEmpty = trimmed.length === 0 || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'n/a';
  const palette = attr ? STRONG_PALETTE[attr] : DEFAULT_STRONG;

  return (
    <div
      className={`rounded-lg p-2 border transition-colors ${
        strong ? `${palette.bg} ${palette.border}` : 'bg-cream border-beige'
      }`}
    >
      <p
        className={`text-[9px] font-bold uppercase tracking-wider ${
          strong ? palette.label : 'text-ink-3'
        }`}
      >
        {label}
      </p>
      <p
        className={`text-xs font-bold mt-0.5 ${
          strong ? palette.value : isEmpty ? 'text-ink-3' : 'text-ink'
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

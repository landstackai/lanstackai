// Marketing CMA PDF — shared theme tokens.
//
// One source of truth for the colors, type scale, spacing, and page
// metrics used across every page component in src/lib/pdf/pages/*.
//
// The palette is intentionally close to the Borgelt CMA report the
// broker shared as a reference (warm gold accents, charcoal ink on
// cream, generous whitespace) but pulled from Landstack's existing
// Tailwind tokens so future brokerage-branding customization can swap
// these out without rewriting the page components.
//
// react-pdf font registration happens lazily on first PDF render — see
// registerPdfFonts() below. We register Google's "Instrument Serif"
// for the display headings (matches the Landstack web brand) and lean
// on the built-in Helvetica family for body copy (no font fetch on
// cold start, no risk of "font not found" failures in serverless).

import { Font, StyleSheet } from '@react-pdf/renderer';

// Palette — drawn from /tailwind.config.js. Hex values inlined so
// the PDF render path doesn't depend on the Tailwind config import.
export const COLORS = {
  // Surfaces
  cream: '#FAF8F2',       // page background
  cream2: '#F3EFE3',      // alternate row stripe / muted panel
  beige: '#E8E5DD',       // hairline borders
  beige2: '#DAD5C7',      // stronger borders / dividers

  // Ink
  ink: '#1F1F1C',         // body copy + headings
  ink2: '#3F3F38',        // section labels (slightly softer than ink)
  ink3: '#6B6960',        // captions, meta, footnotes
  ink4: '#9C9A8F',        // hairline labels (uppercase tracked)

  // Accent (gold/bronze — the Borgelt palette)
  gold: '#B68A35',        // primary accent — page accent bars, OOV hero
  goldDark: '#8C6A29',    // darker accent — hover-equivalent, accents on cream
  goldTint: '#F4ECD8',    // very light gold — accent backgrounds

  // Secondary accents (kept from Landstack web brand)
  olive: '#6B7B3F',       // "Sold" status pill
  oliveTint: '#EFF1E3',
  slateBlue: '#4A6FA5',
  brick: '#C8503F',       // subject property pin
} as const;

// Type scale — react-pdf takes font sizes as bare numbers (= points).
// Body copy lands at 10pt, which is appraisal-report standard.
export const TYPE = {
  hero: 36,        // cover title
  heroSub: 14,     // cover subtitle
  h1: 22,          // page section heading
  h2: 16,          // sub-section heading
  h3: 12,          // card/inline heading
  body: 10,        // default body copy
  small: 9,        // table cells, captions
  tiny: 8,         // footers, hairline meta
  micro: 7,        // legend labels, uppercase tracking
} as const;

// Page metrics — Letter at 612x792pt. We use generous margins
// (0.6in = 43pt) to give the layout breathing room.
export const PAGE = {
  width: 612,
  height: 792,
  margin: 43,
  innerWidth: 612 - 86, // width minus L+R margin
} as const;

// Has Font.register been called yet? react-pdf will silently use
// Helvetica if a font isn't registered, but we want intentional fonts
// where we ask for them. Registration is idempotent but expensive on
// cold start — track it to avoid re-fetching.
let fontsRegistered = false;

/**
 * Register the display font for headings. Body copy uses the built-in
 * Helvetica so PDFs render even if the Google Fonts CDN is unreachable
 * during a serverless cold start.
 *
 * Call this once at the top of the PDF render route, BEFORE building
 * the Document tree. Safe to call multiple times.
 */
export function registerPdfFonts() {
  if (fontsRegistered) return;
  try {
    // Instrument Serif — the Landstack web display font. Use the
    // direct Google Fonts file URLs (react-pdf can't follow CSS @font-face).
    Font.register({
      family: 'Instrument Serif',
      fonts: [
        {
          // Regular 400
          src: 'https://fonts.gstatic.com/s/instrumentserif/v12/jizDREVItHgc8qDIbSTKq4XKVUMYHA.ttf',
          fontWeight: 400,
        },
        {
          // Italic 400
          src: 'https://fonts.gstatic.com/s/instrumentserif/v12/jizBREVItHgc8qDIbSTKq4XkRiUa6zUTiw.ttf',
          fontWeight: 400,
          fontStyle: 'italic',
        },
      ],
    });
    fontsRegistered = true;
  } catch (e) {
    // If font registration fails, the doc still renders (react-pdf
    // falls back to Helvetica). Log and move on — a broken cover font
    // is better than a 500 on the download.
    console.warn('[pdf] font registration failed; falling back to Helvetica', e);
  }
}

// Shared StyleSheet — every page component imports `styles` from here
// for layout primitives (page chrome, dividers, two-column rows, etc.)
// and composes its own page-specific styles on top.
export const styles = StyleSheet.create({
  page: {
    backgroundColor: COLORS.cream,
    paddingTop: PAGE.margin,
    paddingBottom: PAGE.margin + 18, // leave room for footer
    paddingHorizontal: PAGE.margin,
    color: COLORS.ink,
    fontFamily: 'Helvetica',
    fontSize: TYPE.body,
    lineHeight: 1.5,
  },

  // Headings
  hero: {
    fontFamily: 'Instrument Serif',
    fontSize: TYPE.hero,
    color: COLORS.ink,
    lineHeight: 1.1,
  },
  h1: {
    fontFamily: 'Instrument Serif',
    fontSize: TYPE.h1,
    color: COLORS.ink,
    lineHeight: 1.2,
  },
  h2: {
    fontFamily: 'Helvetica-Bold',
    fontSize: TYPE.h2,
    color: COLORS.ink,
  },
  h3: {
    fontFamily: 'Helvetica-Bold',
    fontSize: TYPE.h3,
    color: COLORS.ink,
  },

  // Section label — uppercase, tracked, gold underline (the marker we
  // use to anchor every section on every page).
  sectionLabel: {
    fontFamily: 'Helvetica-Bold',
    fontSize: TYPE.micro,
    color: COLORS.goldDark,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 4,
  },

  // Body copy
  body: {
    fontSize: TYPE.body,
    color: COLORS.ink,
    lineHeight: 1.5,
  },
  bodyMuted: {
    fontSize: TYPE.body,
    color: COLORS.ink3,
    lineHeight: 1.5,
  },
  caption: {
    fontSize: TYPE.small,
    color: COLORS.ink3,
  },

  // Dividers
  rule: {
    height: 1,
    backgroundColor: COLORS.beige2,
    marginVertical: 12,
  },
  goldRule: {
    height: 2,
    backgroundColor: COLORS.gold,
    width: 48,
    marginBottom: 8,
  },

  // Layout primitives
  row: { flexDirection: 'row' },
  col: { flexDirection: 'column' },
  spaceBetween: { justifyContent: 'space-between' },
  center: { alignItems: 'center', justifyContent: 'center' },

  // Page footer (shared across all interior pages — cover renders its
  // own footer treatment).
  footer: {
    position: 'absolute',
    bottom: 20,
    left: PAGE.margin,
    right: PAGE.margin,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: TYPE.tiny,
    color: COLORS.ink4,
    borderTopWidth: 0.5,
    borderTopColor: COLORS.beige2,
    paddingTop: 8,
  },
});

// Number formatting helpers — shared across pages so $ values look
// consistent everywhere.
export function fmtMoney(n: number | null | undefined, opts: { decimals?: number } = {}): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: opts.decimals ?? 0,
    maximumFractionDigits: opts.decimals ?? 0,
  }).format(n);
}

export function fmtAcres(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const fixed = n >= 100 ? n.toFixed(0) : n.toFixed(1);
  return `${fixed}± ac`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

// Compact $/acre — usually rendered alongside acres for context.
export function fmtPpa(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${fmtMoney(n)}/ac`;
}

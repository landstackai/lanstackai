// Marketing CMA PDF — Page 5 (Opinion of Value).
//
// The headline page — what the client opens the report to see. Models
// the Borgelt OOV reveal but driven by Landstack's three presentation
// modes from migration 031:
//
//   confirmed  → one big number (the broker stands behind it)
//   range      → low–high band (broker wants to leave headroom)
//   discuss    → "Let's discuss" placeholder + valuation_notes prose
//
// Plus, in any mode, an optional suggested LIST price (broker's
// number after listing premium) and the broker's free-text valuation
// notes from the workspace.

import React from 'react';
import { Page, View, Text } from '@react-pdf/renderer';
import { styles, COLORS, TYPE, DISPLAY_FONT, DISPLAY_ITALIC, fmtMoney, fmtAcres, fmtPpa } from '../theme';
import type { CmaPdfData, CmaPdfBand } from '../types';
import { PageFooter } from './_chrome';

export function OpinionPage({ data }: { data: CmaPdfData }) {
  const opinion = data.opinion;
  const presentation = opinion.presentation || 'confirmed';
  const stats = data.stats;
  const compCount = stats.count;

  // Compute the canonical broker total (BOV) — mirrors the share
  // report's `suggestedValue` resolution: explicit lump_sum > sum of
  // breakdown components > comp-derived stats.value_mid.
  const houseValue =
    opinion.house_sqft != null && opinion.house_ppsf != null
      ? opinion.house_sqft * opinion.house_ppsf
      : null;
  const breakdownImprovements =
    (houseValue ?? 0) + (opinion.additional_vertical ?? 0) || opinion.improvement_value || 0;
  const breakdownTotal =
    opinion.mode === 'breakdown'
      ? (opinion.land_value ?? 0) + breakdownImprovements
      : 0;
  const brokerTotal =
    opinion.total ??
    (breakdownTotal > 0 ? breakdownTotal : null) ??
    data.stats.value_mid ??
    null;

  // Suggested List Price — explicit broker override wins; otherwise
  // defaults to the BOV itself (no markup). Brokers who want a
  // listing premium set it explicitly in the workspace; brokers who
  // leave it blank are saying "list at the opinion of value." In
  // 'discuss' mode no number is shown — the hero falls back to the
  // "Let's Discuss" soft-invitation copy for both SLP and Expected
  // Sale.
  const suggestedListPrice =
    presentation === 'discuss'
      ? null
      : opinion.suggested_list_price ?? brokerTotal;

  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.sectionLabel}>Suggested List Price & Opinion of Value</Text>
      <View style={styles.goldRule} />
      <Text style={[styles.h1, { marginBottom: 4 }]}>Pricing Recommendation</Text>
      <Text style={[styles.bodyMuted, { marginBottom: 16 }]}>
        Derived from comparable sales analysis and the broker's professional judgment.
      </Text>

      {/* THE HERO — Suggested List Price is the headline, with the
          broker's Opinion of Value (BOV) carried as the supporting
          "Expected Sale" line. Mirrors the hierarchy on the client
          share report: the seller anchors on the aspirational list
          price first, the BOV lands as "with negotiation room baked
          in" rather than "this is what it's worth, sorry."

          In 'discuss' mode the SLP isn't shown — the hero falls
          back to the share report's soft-invitation copy. */}
      <View
        style={{
          backgroundColor: COLORS.ink,
          paddingHorizontal: 28,
          paddingVertical: 32,
          borderRadius: 4,
          marginBottom: 16,
        }}
      >
        {presentation === 'discuss' ? (
          <DiscussHero />
        ) : (
          <ConfirmedHero
            suggestedListPrice={suggestedListPrice}
            brokerTotal={brokerTotal}
            presentation={presentation}
            data={data}
          />
        )}

        {/* Subject context line under the hero */}
        <Text
          style={{
            fontSize: TYPE.small,
            color: COLORS.beige2,
            marginTop: 14,
          }}
        >
          {data.subject.name || 'Subject Property'}
          {data.subject.acres != null ? ` · ${fmtAcres(data.subject.acres)}` : ''}
          {data.subject.county && data.subject.state
            ? ` · ${data.subject.county}, ${data.subject.state}`
            : ''}
        </Text>
      </View>

      {/* Dynamic range indicator — where the broker's number lands
          relative to the comp range. Gives the seller honest context
          without scolding: "above the typical range" / "within the
          range" / "below the range". Brokers get cover to flag
          aggressive pricing in writing without having to say
          "your seller is unrealistic" out loud. */}
      {presentation !== 'discuss' ? (
        <RangeIndicator brokerTotal={brokerTotal} stats={stats} />
      ) : null}

      {/* Compact analysis tables — Total + Adjusted, matching the
          two $/Ac columns on the Comparable Sales table (Page 4).
          Same math (computeCmaAverages from cmaMath.ts) used by the
          workspace + share report. Positioned BELOW the hero so the
          number lands first; the analysis supports the headline. */}
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
        {(stats.total.n ?? 0) > 0 ? (
          <PpaBand
            label="Average Total $/Acre"
            band={stats.total}
            totals={stats.totals_total}
            compCount={compCount}
            accent={COLORS.olive}
          />
        ) : null}
        {(stats.adjusted.n ?? 0) > 0 ? (
          <PpaBand
            label="Average Adjusted $/Acre"
            band={stats.adjusted}
            totals={stats.totals_adjusted}
            compCount={compCount}
            accent={COLORS.slateBlue}
          />
        ) : null}
      </View>

      {/* Breakdown box — only shown in breakdown mode. New stacked
          layout shows the path (Land Value → Improvements →
          Broker Opinion of Value) with itemized improvement math
          when the broker entered it that way. */}
      {opinion.mode === 'breakdown' && presentation !== 'discuss' ? (
        <ValueBreakdown data={data} />
      ) : null}

      {/* Broker's valuation notes — prose rationale */}
      {opinion.valuation_notes && opinion.valuation_notes.trim().length > 0 ? (
        <View style={{ marginTop: 12 }}>
          <Text style={[styles.sectionLabel, { color: COLORS.ink4, marginBottom: 6 }]}>
            Broker's Rationale
          </Text>
          <Text style={[styles.body, { color: COLORS.ink2 }]}>
            {opinion.valuation_notes}
          </Text>
        </View>
      ) : null}

      {/* Pricing-thesis closer — Landstack's data-plus-judgment
          positioning in a single italic line above the footer. No
          label, no box — functions as the page's quiet closing
          signature rather than a marketing callout. Methodology
          page intentionally doesn't repeat it. */}
      <PricingPhilosophyLine />

      <PageFooter data={data} pageNum={5} />
    </Page>
  );
}

/**
 * Discuss mode — broker doesn't want to commit a number in writing.
 * Both the Suggested List Price and Expected Sale slots show
 * "Let's Discuss" so the client sees the framing without seeing a
 * placeholder dollar amount anywhere. valuation_notes (the broker's
 * free-text rationale) renders below the hero.
 */
function DiscussHero() {
  return (
    <View>
      <Text
        style={{
          fontSize: TYPE.micro,
          color: COLORS.gold,
          letterSpacing: 2,
          textTransform: 'uppercase',
          fontFamily: 'Helvetica-Bold',
          marginBottom: 10,
        }}
      >
        Suggested List Price
      </Text>
      <Text
        style={{
          fontFamily: DISPLAY_FONT,
          fontSize: 32,
          color: COLORS.cream,
          lineHeight: 1.1,
        }}
      >
        Let's Discuss
      </Text>

      {/* Divider rule */}
      <View
        style={{
          height: 1,
          backgroundColor: COLORS.gold,
          opacity: 0.4,
          marginVertical: 14,
          width: 80,
        }}
      />

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
        <Text
          style={{
            fontSize: TYPE.micro,
            color: COLORS.beige2,
            letterSpacing: 1.4,
            textTransform: 'uppercase',
            fontFamily: 'Helvetica-Bold',
          }}
        >
          Expected Sale
        </Text>
        <Text
          style={{
            fontSize: TYPE.h2,
            color: COLORS.cream,
            fontFamily: DISPLAY_FONT,
          }}
        >
          Let's Discuss
        </Text>
      </View>

      <Text style={{ fontSize: TYPE.small, color: COLORS.beige2, marginTop: 8, lineHeight: 1.5 }}>
        A formal opinion of value is best delivered in person, where we can walk through
        the comp set together and frame the numbers against your timing and goals.
      </Text>
    </View>
  );
}

/**
 * Confirmed (default) + Range mode — the Suggested List Price is the
 * headline; the broker's Opinion of Value (BOV) carries underneath as
 * "Expected Sale." Mirrors the share report's pricing hierarchy: the
 * aspirational number anchors first, the realistic number follows.
 */
function ConfirmedHero({
  suggestedListPrice,
  brokerTotal,
  presentation,
  data,
}: {
  suggestedListPrice: number | null;
  brokerTotal: number | null;
  presentation: 'confirmed' | 'range' | 'discuss';
  data: CmaPdfData;
}) {
  const opinion = data.opinion;

  // When the broker hasn't entered an explicit Suggested List Price,
  // the SLP defaults to the BOV — meaning both numbers are equal.
  // Showing "Expected Sale: $X" right under "Suggested List Price: $X"
  // would be the same number twice, so we suppress the Expected Sale
  // line in that case. Also handles range mode (where Expected Sale
  // is a low–high band and clearly distinct from the single SLP).
  const slpExplicit = opinion.suggested_list_price != null;
  const showExpectedSale =
    presentation === 'range' || (slpExplicit && suggestedListPrice !== brokerTotal);

  // Range mode treatment for the supporting BOV line — show
  // "Expected Sale: $low — $high" instead of a single number.
  let expectedSaleLine: React.ReactNode = null;
  if (presentation === 'range' && brokerTotal != null) {
    const low = opinion.range_low ?? brokerTotal * 0.95;
    const high = opinion.range_high ?? brokerTotal * 1.05;
    expectedSaleLine = (
      <Text>
        {fmtMoney(low)} <Text style={{ color: COLORS.gold }}>—</Text> {fmtMoney(high)}
      </Text>
    );
  } else if (brokerTotal != null) {
    expectedSaleLine = <Text>{fmtMoney(brokerTotal)}</Text>;
  } else {
    expectedSaleLine = <Text>—</Text>;
  }

  return (
    <View>
      <Text
        style={{
          fontSize: TYPE.micro,
          color: COLORS.gold,
          letterSpacing: 2,
          textTransform: 'uppercase',
          fontFamily: 'Helvetica-Bold',
          marginBottom: 10,
        }}
      >
        Suggested List Price
      </Text>
      <Text
        style={{
          fontFamily: DISPLAY_FONT,
          fontSize: 44,
          color: COLORS.cream,
          lineHeight: 1.1,
        }}
      >
        {suggestedListPrice != null ? fmtMoney(suggestedListPrice) : '—'}
      </Text>

      {showExpectedSale ? (
        <>
          {/* Divider rule */}
          <View
            style={{
              height: 1,
              backgroundColor: COLORS.gold,
              opacity: 0.4,
              marginVertical: 14,
              width: 80,
            }}
          />

          {/* Expected Sale (the BOV / OOV) — supporting detail */}
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
            <Text
              style={{
                fontSize: TYPE.micro,
                color: COLORS.beige2,
                letterSpacing: 1.4,
                textTransform: 'uppercase',
                fontFamily: 'Helvetica-Bold',
              }}
            >
              Expected Sale
            </Text>
            <Text
              style={{
                fontSize: TYPE.h2,
                color: COLORS.cream,
                fontFamily: DISPLAY_FONT,
              }}
            >
              {expectedSaleLine}
            </Text>
          </View>

          <Text style={{ fontSize: TYPE.small, color: COLORS.beige2, marginTop: 6, lineHeight: 1.5 }}>
            List price leaves negotiating room above the broker's opinion of value while
            staying defensible against the comp range.
          </Text>
        </>
      ) : (
        // SLP equals BOV (broker chose to list at the opinion of
        // value). Replace the "Expected Sale" block with a single
        // helper line so the hero card doesn't feel half-empty.
        <Text style={{ fontSize: TYPE.small, color: COLORS.beige2, marginTop: 14, lineHeight: 1.5 }}>
          The list price reflects the broker's opinion of value — supported by the
          comparable sales analysis below.
        </Text>
      )}
    </View>
  );
}

/**
 * Stacked vertical breakdown — the valuation walkthrough.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ LAND VALUE                              $4,119,440        │
 *   │ Implied $13,003/ac across 317± ac                         │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ IMPROVEMENTS                            $2,397,875        │
 *   │   House  4,500 sqft × $400/sqft         $1,800,000        │
 *   │   Additional vertical structures           $597,875        │
 *   ├══════════════════════════════════════════════════════════┤
 *   │ BROKER OPINION OF VALUE                 $6,517,315        │  ← gold
 *   └──────────────────────────────────────────────────────────┘
 *
 * Itemized improvements expand inline when the broker entered
 * house_sqft × house_ppsf or additional_vertical; otherwise the
 * Improvements line collapses to just the lump amount. Land Value
 * always shows the implied $/Ac when subject_acres is set —
 * lets the seller tie the land number back to the comp data.
 */
function ValueBreakdown({ data }: { data: CmaPdfData }) {
  const opinion = data.opinion;
  const subjectAcres = data.subject.acres ?? 0;

  // Improvements math
  const houseSqft = opinion.house_sqft;
  const housePpsf = opinion.house_ppsf;
  const houseValue =
    houseSqft != null && housePpsf != null && houseSqft > 0 && housePpsf > 0
      ? houseSqft * housePpsf
      : null;
  const additionalVertical = opinion.additional_vertical ?? null;
  const isItemized =
    houseValue != null || (additionalVertical != null && additionalVertical > 0);
  const totalImprovements =
    isItemized
      ? (houseValue ?? 0) + (additionalVertical ?? 0)
      : opinion.improvement_value;

  // Land math
  const landValue = opinion.land_value;
  const impliedLandPpa =
    landValue != null && subjectAcres > 0 ? landValue / subjectAcres : null;

  // Total (Broker Opinion of Value)
  const total =
    opinion.total ??
    (((landValue ?? 0) + (totalImprovements ?? 0)) || null);

  return (
    <View
      style={{
        marginTop: 6,
        marginBottom: 16,
        backgroundColor: '#fff',
        borderWidth: 1,
        borderColor: COLORS.beige2,
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {/* LAND VALUE row */}
      <BreakdownRow
        label="Land Value"
        amount={landValue}
        supportLine={
          impliedLandPpa != null
            ? `Implied ${fmtPpa(impliedLandPpa)} across ${fmtAcres(subjectAcres)}`
            : undefined
        }
      />

      {/* IMPROVEMENTS row — itemized or lump */}
      {totalImprovements != null && totalImprovements > 0 ? (
        <BreakdownRow
          label="Improvements"
          amount={totalImprovements}
          itemized={isItemized}
          subItems={
            isItemized
              ? [
                  ...(houseValue != null && houseSqft != null && housePpsf != null
                    ? [
                        {
                          label: 'House',
                          detail: `${formatNumber(houseSqft)} sqft × ${fmtMoney(housePpsf)}/sqft`,
                          amount: houseValue,
                        },
                      ]
                    : []),
                  ...(additionalVertical != null && additionalVertical > 0
                    ? [
                        {
                          label: 'Additional vertical structures',
                          detail: '',
                          amount: additionalVertical,
                        },
                      ]
                    : []),
                ]
              : undefined
          }
        />
      ) : null}

      {/* BROKER OPINION OF VALUE row — gold accent */}
      <BreakdownRow
        label="Broker Opinion of Value"
        amount={total}
        highlight
      />
    </View>
  );
}

/**
 * A single row inside the stacked breakdown. Two layout modes:
 *
 *   • Simple — one label, one $ amount, optional support text below.
 *   • Itemized — same header, then nested sub-items showing the
 *     math (e.g., "House  4,500 sqft × $400/sqft   $1,800,000").
 *
 * `highlight` toggles the gold-accent treatment used on the final
 * Broker Opinion of Value row.
 */
function BreakdownRow({
  label,
  amount,
  supportLine,
  subItems,
  itemized,
  highlight = false,
}: {
  label: string;
  amount: number | null;
  supportLine?: string;
  subItems?: { label: string; detail: string; amount: number }[];
  itemized?: boolean;
  highlight?: boolean;
}) {
  return (
    <View
      style={{
        paddingVertical: 9,
        paddingHorizontal: 16,
        backgroundColor: highlight ? COLORS.goldTint : '#fff',
        borderTopWidth: highlight ? 2 : 0.5,
        borderTopColor: highlight ? COLORS.gold : COLORS.beige,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
        <Text
          style={{
            fontSize: highlight ? TYPE.tiny : TYPE.micro,
            color: highlight ? COLORS.goldDark : COLORS.ink3,
            letterSpacing: 1.2,
            textTransform: 'uppercase',
            fontFamily: 'Helvetica-Bold',
          }}
        >
          {label}
        </Text>
        <Text
          style={{
            fontSize: highlight ? TYPE.h2 : TYPE.h3,
            color: highlight ? COLORS.goldDark : COLORS.ink,
            fontFamily: 'Helvetica-Bold',
          }}
        >
          {amount != null ? fmtMoney(amount) : '—'}
        </Text>
      </View>

      {/* Support line — e.g., "Implied $13,003/ac across 317± ac" */}
      {supportLine ? (
        <Text style={{ fontSize: TYPE.small, color: COLORS.ink3, marginTop: 2 }}>
          {supportLine}
        </Text>
      ) : null}

      {/* Itemized sub-items — improvements walkthrough. Each row
          mirrors the parent's label/amount layout so the right edge
          aligns column-for-column with the parent dollar amount.
          Label + detail combine into a single text run with the
          detail in muted ink, kept on one line per item. */}
      {itemized && subItems && subItems.length > 0 ? (
        <View style={{ marginTop: 4 }}>
          {subItems.map((item, i) => (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                paddingVertical: 2,
                paddingLeft: 14,
              }}
            >
              <Text style={{ fontSize: TYPE.small, color: COLORS.ink2, flex: 1, paddingRight: 8 }}>
                {item.label}
                {item.detail ? (
                  <Text style={{ color: COLORS.ink3 }}>  {item.detail}</Text>
                ) : null}
              </Text>
              <Text style={{ fontSize: TYPE.small, color: COLORS.ink2 }}>
                {fmtMoney(item.amount)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Format integer numbers with thousands separators — for sqft, etc. */
function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

/**
 * Dynamic range indicator — calm one-liner that places the broker's
 * Opinion of Value relative to the adjusted comp range. Gives the
 * broker honest framing for aggressive (or conservative) pricing
 * without scolding the seller.
 *
 * Five states based on (brokerTotal - rangeHigh) / rangeHigh:
 *   < 0 and within range  → calm gold tint  "Aligned with the comparable range"
 *   ≤ 10% above           → calm gold tint  "Modestly above the typical sale range"
 *   ≤ 20% above           → amber tint      "Above the typical sale range"
 *   > 20% above           → amber tint      "Significantly above the comparable range"
 *   below range           → slate-blue tint "Below the comparable range"
 */
function RangeIndicator({
  brokerTotal,
  stats,
}: {
  brokerTotal: number | null;
  stats: CmaPdfData['stats'];
}) {
  if (brokerTotal == null || brokerTotal <= 0) return null;

  // Use adjusted band when available (broker-considered view); fall
  // back to total. If neither has data, skip the indicator.
  const useAdj = (stats.adjusted.n ?? 0) > 0;
  const lowBand = useAdj ? stats.totals_adjusted.low : stats.totals_total.low;
  const highBand = useAdj ? stats.totals_adjusted.high : stats.totals_total.high;
  if (lowBand == null || highBand == null) return null;

  let message = '';
  // Widen to string so we can reassign across the indicator's
  // five states — the COLORS constants are typed as literal hexes.
  let bgColor: string = COLORS.goldTint;
  let borderColor: string = COLORS.gold;
  let textColor: string = COLORS.goldDark;

  // Subject is always the Broker Opinion of Value (Expected Sale).
  // Spell it out so the reader doesn't have to guess which of the
  // dollar figures on this page the percentage is comparing.
  if (brokerTotal < lowBand) {
    const pct = Math.round(((lowBand - brokerTotal) / lowBand) * 100);
    message = `The broker's Opinion of Value lands ${pct}% below the comparable sale range — competitively positioned for a strong outcome.`;
    bgColor = '#EEF2F8';
    borderColor = COLORS.slateBlue;
    textColor = '#2C4A75';
  } else if (brokerTotal <= highBand) {
    message = "The broker's Opinion of Value lands within the comparable sale range — well-supported by the data.";
    bgColor = COLORS.oliveTint;
    borderColor = COLORS.olive;
    textColor = '#475428';
  } else {
    const overshoot = (brokerTotal - highBand) / highBand;
    const pct = Math.round(overshoot * 100);
    if (overshoot <= 0.10) {
      message = `The broker's Opinion of Value lands ${pct}% above the comparable sale range — the broker's premium read.`;
    } else if (overshoot <= 0.20) {
      message = `The broker's Opinion of Value lands ${pct}% above the typical sale range — premium positioning. A longer marketing period is typical at this level.`;
      bgColor = '#FCF1E0';
      borderColor = '#E8B872';
      textColor = '#8A5A1A';
    } else {
      message = `The broker's Opinion of Value lands ${pct}% above the comparable sale range — aggressive positioning. Expect an extended marketing period.`;
      bgColor = '#FCF1E0';
      borderColor = '#E8B872';
      textColor = '#8A5A1A';
    }
  }

  return (
    <View
      style={{
        backgroundColor: bgColor,
        borderLeftWidth: 3,
        borderLeftColor: borderColor,
        paddingVertical: 8,
        paddingHorizontal: 12,
        marginBottom: 16,
      }}
    >
      <Text style={{ fontSize: TYPE.small, color: textColor, lineHeight: 1.4 }}>
        {message}
      </Text>
    </View>
  );
}

/**
 * Landstack's pricing-thesis closer. A single italic line above the
 * page footer — no label, no box, no header. Captures the data +
 * broker-judgment positioning in 13 words and lets the white space
 * around it do the work. Methodology page intentionally doesn't
 * repeat the thesis.
 */
function PricingPhilosophyLine() {
  return (
    <View style={{ marginTop: 20, alignItems: 'center' }}>
      <View
        style={{
          height: 1,
          backgroundColor: COLORS.gold,
          width: 48,
          marginBottom: 10,
        }}
      />
      <Text
        style={{
          fontFamily: DISPLAY_ITALIC,
          fontSize: TYPE.body,
          color: COLORS.ink2,
          textAlign: 'center',
          lineHeight: 1.5,
        }}
      >
        Comparable sales define the range; broker judgment finds the right price within it.
      </Text>
    </View>
  );
}

/**
 * Compact 3-row band of Low / Mid / High $/Acre values + corresponding
 * subject-property dollar totals. Renders one card per "view" of the
 * comp data (Total / Land-Only). Mirrors the share report's
 * "Per-acre comp detail" section, just tighter.
 */
function PpaBand({
  label,
  band,
  totals,
  compCount,
  accent,
}: {
  label: string;
  band: CmaPdfBand;
  totals: CmaPdfBand;
  compCount: number;
  accent: string;
}) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: '#fff',
        borderWidth: 1,
        borderColor: COLORS.beige2,
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          paddingHorizontal: 10,
          paddingVertical: 6,
          backgroundColor: COLORS.cream2,
          borderBottomWidth: 1,
          borderBottomColor: COLORS.beige2,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Text
          style={{
            fontSize: TYPE.micro,
            color: COLORS.ink2,
            letterSpacing: 1,
            textTransform: 'uppercase',
            fontFamily: 'Helvetica-Bold',
          }}
        >
          {label}
        </Text>
        <Text style={{ fontSize: TYPE.tiny, color: COLORS.ink3 }}>
          {band.n ?? 0} of {compCount}
        </Text>
      </View>

      <PpaRow label="Low" ppa={band.low} value={totals.low} accent={accent} bold={false} />
      <PpaRow label="Mid" ppa={band.mid} value={totals.mid} accent={accent} bold />
      <PpaRow label="High" ppa={band.high} value={totals.high} accent={accent} bold={false} />
    </View>
  );
}

function PpaRow({
  label,
  ppa,
  value,
  accent,
  bold,
}: {
  label: string;
  ppa: number | null;
  value: number | null;
  accent: string;
  bold: boolean;
}) {
  const textColor = bold ? accent : COLORS.ink;
  const fontFamily = bold ? 'Helvetica-Bold' : 'Helvetica';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderBottomWidth: 0.5,
        borderBottomColor: COLORS.beige,
      }}
    >
      <Text style={{ flex: 1, fontSize: TYPE.small, color: bold ? accent : COLORS.ink2, fontFamily }}>
        {label}
      </Text>
      <Text style={{ flex: 1.5, fontSize: TYPE.small, color: textColor, textAlign: 'right', fontFamily }}>
        {ppa != null ? fmtPpa(ppa) : '—'}
      </Text>
      <Text style={{ flex: 1.5, fontSize: TYPE.small, color: textColor, textAlign: 'right', fontFamily }}>
        {value != null ? fmtMoney(value) : '—'}
      </Text>
    </View>
  );
}

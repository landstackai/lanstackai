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
import { styles, COLORS, TYPE, DISPLAY_FONT, fmtMoney, fmtAcres, fmtPpa } from '../theme';
import type { CmaPdfData, CmaPdfBand } from '../types';
import { PageFooter } from './_chrome';

export function OpinionPage({ data }: { data: CmaPdfData }) {
  const opinion = data.opinion;
  const presentation = opinion.presentation || 'confirmed';
  const stats = data.stats;
  const compCount = stats.count;

  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.sectionLabel}>Market Analysis & Opinion of Value</Text>
      <View style={styles.goldRule} />
      <Text style={[styles.h1, { marginBottom: 4 }]}>Opinion of Value</Text>
      <Text style={[styles.bodyMuted, { marginBottom: 16 }]}>
        Derived from comparable sales analysis and the broker's professional judgment.
      </Text>

      {/* Compact analysis tables — same data the broker + client see
          on the workspace and digital share report (computeCmaAverages
          from cmaMath.ts). Total + Land-Only side by side. The
          "Adjusted" view stays workspace-only — it's a broker
          diagnostic, not a client-facing surface. */}
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
        {(stats.landOnly.n ?? 0) > 0 ? (
          <PpaBand
            label="Average Land-Only $/Acre"
            band={stats.landOnly}
            totals={stats.totals_landOnly}
            compCount={compCount}
            accent={COLORS.slateBlue}
          />
        ) : null}
      </View>

      {/* The hero reveal — varies by presentation mode. */}
      <View
        style={{
          backgroundColor: COLORS.ink,
          paddingHorizontal: 28,
          paddingVertical: 36,
          borderRadius: 4,
          marginBottom: 18,
        }}
      >
        <Text
          style={{
            fontSize: TYPE.micro,
            color: COLORS.gold,
            letterSpacing: 2,
            textTransform: 'uppercase',
            fontFamily: 'Helvetica-Bold',
            marginBottom: 12,
          }}
        >
          Opinion of Value
        </Text>

        <OpinionHero data={data} />

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

      {/* Suggested list price (if broker entered one), otherwise the
          calculated default (= total × 1.10). */}
      {opinion.suggested_list_price != null && presentation !== 'discuss' ? (
        <View
          style={{
            backgroundColor: COLORS.goldTint,
            borderLeftWidth: 2,
            borderLeftColor: COLORS.gold,
            paddingVertical: 12,
            paddingHorizontal: 14,
            marginBottom: 18,
          }}
        >
          <Text
            style={{
              fontSize: TYPE.micro,
              color: COLORS.goldDark,
              letterSpacing: 1.4,
              textTransform: 'uppercase',
              fontFamily: 'Helvetica-Bold',
              marginBottom: 4,
            }}
          >
            Suggested List Price
          </Text>
          <Text style={{ fontSize: TYPE.h2, color: COLORS.ink }}>
            {fmtMoney(opinion.suggested_list_price)}
          </Text>
          <Text style={{ fontSize: TYPE.small, color: COLORS.ink3, marginTop: 4 }}>
            Leaves negotiating room above the opinion of value while staying defensible vs. comps.
          </Text>
        </View>
      ) : null}

      {/* Breakdown box — only shown in breakdown mode */}
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

      <PageFooter data={data} pageNum={5} />
    </Page>
  );
}

function OpinionHero({ data }: { data: CmaPdfData }) {
  const opinion = data.opinion;
  const presentation = opinion.presentation || 'confirmed';

  // ── DISCUSS mode ──────────────────────────────────────────────────
  // Broker doesn't want to commit a number in writing — they want the
  // conversation to happen at the kitchen table. Show a placeholder
  // line and lean on valuation_notes (rendered below the hero).
  if (presentation === 'discuss') {
    return (
      <View>
        <Text
          style={{
            fontFamily: DISPLAY_FONT,
            fontSize: 28,
            color: COLORS.cream,
            lineHeight: 1.1,
          }}
        >
          Let's Discuss
        </Text>
        <Text style={{ fontSize: TYPE.body, color: COLORS.cream2, marginTop: 8, lineHeight: 1.5 }}>
          A formal opinion of value is best delivered in person, where we can walk through
          the comp set together and frame the numbers against your timing and goals.
        </Text>
      </View>
    );
  }

  // Compute the canonical "broker total" — the dollar amount the
  // broker stands behind. Resolution order:
  //   1. broker_opinion_value (explicit lump-sum total) — if set
  //   2. Breakdown sum (land_value + improvement_value family) — when
  //      mode === 'breakdown' and the broker entered land+improvement
  //      separately, this is the AUTHORITATIVE total. We were
  //      previously falling through to stats.value_mid and showing the
  //      comp median, which contradicted the breakdown cards below.
  //   3. Comp-derived stats.value_mid as last-resort fallback
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

  // ── RANGE mode ────────────────────────────────────────────────────
  // Broker wants to show a band. Prefer explicit range_low/range_high
  // if the broker entered them; fall back to ±5% around the broker
  // total for confirmed-with-comp-range scenarios.
  if (presentation === 'range') {
    const total = brokerTotal;
    const low = opinion.range_low ?? (total != null ? total * 0.95 : data.stats.value_low);
    const high = opinion.range_high ?? (total != null ? total * 1.05 : data.stats.value_high);

    return (
      <View>
        <Text
          style={{
            fontFamily: DISPLAY_FONT,
            fontSize: 30,
            color: COLORS.cream,
            lineHeight: 1.1,
          }}
        >
          {fmtMoney(low)} <Text style={{ color: COLORS.gold }}>—</Text> {fmtMoney(high)}
        </Text>
        <Text style={{ fontSize: TYPE.small, color: COLORS.cream2, marginTop: 8 }}>
          Range reflects the spread observed across the comp set.
        </Text>
      </View>
    );
  }

  // ── CONFIRMED mode (default) ──────────────────────────────────────
  // One headline number. Uses brokerTotal from above — which prefers
  // the broker's explicit opinion (lump-sum OR breakdown sum) over
  // any comp-derived fallback. Ensures the headline always agrees
  // with the breakdown cards below.
  return (
    <View>
      <Text
        style={{
          fontFamily: DISPLAY_FONT,
          fontSize: 44,
          color: COLORS.cream,
          lineHeight: 1.1,
        }}
      >
        {brokerTotal != null ? fmtMoney(brokerTotal) : '—'}
      </Text>
    </View>
  );
}

function ValueBreakdown({ data }: { data: CmaPdfData }) {
  const opinion = data.opinion;

  // Compute total improvement value (house + additional vertical)
  const houseValue =
    opinion.house_sqft != null && opinion.house_ppsf != null
      ? opinion.house_sqft * opinion.house_ppsf
      : null;
  const totalImprovements =
    (houseValue ?? 0) + (opinion.additional_vertical ?? 0) || opinion.improvement_value || null;

  return (
    <View
      style={{
        marginTop: 6,
        marginBottom: 12,
        flexDirection: 'row',
        gap: 12,
      }}
    >
      <BreakdownCard label="Land Value" amount={opinion.land_value} />
      <BreakdownCard label="Improvements" amount={totalImprovements} />
      <BreakdownCard
        label="Total"
        amount={opinion.total ?? (((opinion.land_value ?? 0) + (totalImprovements ?? 0)) || null)}
        highlight
      />
    </View>
  );
}

function BreakdownCard({
  label,
  amount,
  highlight = false,
}: {
  label: string;
  amount: number | null;
  highlight?: boolean;
}) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: highlight ? COLORS.goldTint : COLORS.cream2,
        borderWidth: 1,
        borderColor: highlight ? COLORS.gold : COLORS.beige2,
        paddingVertical: 10,
        paddingHorizontal: 12,
      }}
    >
      <Text style={{ fontSize: TYPE.tiny, color: COLORS.ink3, marginBottom: 4 }}>{label}</Text>
      <Text
        style={{
          fontSize: TYPE.h3,
          color: highlight ? COLORS.goldDark : COLORS.ink,
          fontFamily: 'Helvetica-Bold',
        }}
      >
        {amount != null ? fmtMoney(amount) : '—'}
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

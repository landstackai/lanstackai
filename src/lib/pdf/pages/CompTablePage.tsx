// Marketing CMA PDF — Page 4 (Comparable Sales).
//
// A clean, scannable table of every comp the broker included in the
// CMA. Models the Borgelt sales table but tuned for land-only sold
// comps (no Active listings in V1 per design discussion):
//
//   ┌────────────────────────────────────────────────────────────┐
//   │ COMPARABLE SALES                                           │
//   │ ──                                                         │
//   │                                                            │
//   │  #  Address                County  Acres  Sold     $/Ac    │
//   │  ── ────────────────────── ─────── ────── ──────── ─────── │
//   │  1  123 Ranch Rd           Llano   320±   $1.2M    $3,750  │
//   │  2  ...                                                    │
//   │                                                            │
//   │  Average $/Ac across N comps: $X,XXX                       │
//   └────────────────────────────────────────────────────────────┘
//
// Column choices reflect what a broker actually compares in a CMA
// review: county / acres / sold price / $/Ac. We omit deep details
// (water, road, MLD, etc.) because the broker can already see them
// in the workspace — the PDF is for the CLIENT meeting, where the
// goal is "here are five comparable sales, and here's the average."
//
// The page auto-paginates when there are too many comps for one
// page — react-pdf's <View> wrapping does the right thing inside a
// single <Page>, but very large CMAs (>15 comps) will flow off the
// bottom. We accept that trade for V1 — typical broker CMAs run
// 4-8 comps.

import React from 'react';
import { Page, View, Text } from '@react-pdf/renderer';
import { styles, COLORS, TYPE, fmtMoney, fmtAcres, fmtDate, fmtPpa } from '../theme';
import type { CmaPdfData, CmaPdfComp } from '../types';
import { PageFooter } from './_chrome';

export function CompTablePage({ data }: { data: CmaPdfData }) {
  const comps = data.comps;

  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.sectionLabel}>Comparable Sales</Text>
      <View style={styles.goldRule} />
      <Text style={[styles.h1, { marginBottom: 4 }]}>Sold Comparables</Text>
      <Text style={[styles.bodyMuted, { marginBottom: 16 }]}>
        {comps.length} comparable {comps.length === 1 ? 'sale' : 'sales'} selected for this analysis.
      </Text>

      {/* Table header */}
      <CompTableHeader />

      {/* Rows */}
      <View>
        {comps.map((comp, i) => (
          <CompTableRow key={comp.id} comp={comp} index={i + 1} striped={i % 2 === 1} />
        ))}
        {/* Inline AVERAGES row — caps the table off with a final
            summary line that aligns column-for-column with the rows
            above. Conventional CMA-table layout. The standalone
            footer summary below kept for the Range + Low/High that
            don't fit cleanly into a single row. */}
        <CompTableAveragesRow comps={comps} stats={data.stats} />
      </View>

      {/* Summary footer — comp count + the Total + Land-Only mid
          $/Ac, mirroring the headline numbers on the Opinion of Value
          page. Keeps this page focused on the rows themselves; the
          full Low/Mid/High break-down is on Page 5. */}
      <View
        style={{
          marginTop: 18,
          paddingTop: 12,
          borderTopWidth: 1,
          borderTopColor: COLORS.gold,
          flexDirection: 'row',
          justifyContent: 'space-between',
        }}
      >
        <View>
          <Text style={{ fontSize: TYPE.tiny, color: COLORS.ink3, marginBottom: 2 }}>
            COMP COUNT
          </Text>
          <Text style={{ fontSize: TYPE.h3, color: COLORS.ink }}>{data.stats.count}</Text>
        </View>
        <View>
          <Text style={{ fontSize: TYPE.tiny, color: COLORS.ink3, marginBottom: 2 }}>
            AVG TOTAL $/ACRE
          </Text>
          <Text style={{ fontSize: TYPE.h3, color: COLORS.ink }}>
            {data.stats.total.mid != null ? fmtPpa(data.stats.total.mid) : '—'}
          </Text>
        </View>
        <View>
          <Text style={{ fontSize: TYPE.tiny, color: COLORS.ink3, marginBottom: 2 }}>
            AVG ADJUSTED $/ACRE
          </Text>
          <Text style={{ fontSize: TYPE.h3, color: COLORS.ink }}>
            {data.stats.adjusted.mid != null ? fmtPpa(data.stats.adjusted.mid) : '—'}
          </Text>
        </View>
        <View>
          <Text style={{ fontSize: TYPE.tiny, color: COLORS.ink3, marginBottom: 2 }}>
            RANGE (ADJUSTED)
          </Text>
          <Text style={{ fontSize: TYPE.h3, color: COLORS.ink }}>
            {data.stats.adjusted.low != null && data.stats.adjusted.high != null
              ? `${fmtPpa(data.stats.adjusted.low)} – ${fmtPpa(data.stats.adjusted.high)}`
              : '—'}
          </Text>
        </View>
      </View>

      <PageFooter data={data} pageNum={4} />
    </Page>
  );
}

// Column widths sum to 100 — react-pdf flex respects relative
// proportions. Address is the elastic column. Two $/Acre columns:
// TOTAL (raw sale_price / acres) and ADJUSTED (improvements
// backed out per the broker's per-comp adjustment). Matches the
// workspace's Total + Adjusted views.
const COLS = {
  num: 3,
  address: 22,
  county: 10,
  acres: 9,
  sold: 13,
  date: 13,
  ppaTotal: 15,
  ppaAdj: 15,
};

function CompTableHeader() {
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: COLORS.cream2,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: COLORS.beige2,
        paddingVertical: 6,
        paddingHorizontal: 6,
      }}
    >
      <HeaderCell width={COLS.num} text="#" />
      <HeaderCell width={COLS.address} text="Address" />
      <HeaderCell width={COLS.county} text="County" />
      <HeaderCell width={COLS.acres} text="Acres" align="right" />
      <HeaderCell width={COLS.sold} text="Sold Price" align="right" />
      <HeaderCell width={COLS.date} text="Sale Date" align="right" />
      <HeaderCell width={COLS.ppaTotal} text="$/Ac Total" align="right" />
      <HeaderCell width={COLS.ppaAdj} text="$/Ac Adjusted" align="right" />
    </View>
  );
}

function HeaderCell({
  text,
  width,
  align = 'left',
}: {
  text: string;
  width: number;
  align?: 'left' | 'right';
}) {
  return (
    <Text
      style={{
        flex: width,
        fontSize: TYPE.tiny,
        color: COLORS.ink3,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        textAlign: align,
        fontFamily: 'Helvetica-Bold',
      }}
    >
      {text}
    </Text>
  );
}

function CompTableRow({
  comp,
  index,
  striped,
}: {
  comp: CmaPdfComp;
  index: number;
  striped: boolean;
}) {
  // Choose the best address surface for this comp:
  //   property_name > city, state (structured) > address > '—'
  const addressLine =
    comp.property_name?.trim() ||
    [comp.city, comp.state].filter(Boolean).join(', ').trim() ||
    comp.address?.trim() ||
    '—';

  // Per-comp $/Ac comes from the route's pre-computed values
  // (computed_total_ppa, computed_adjusted_ppa) — same precedence
  // as adjustedPpa() in cmaMath.ts, so the PDF row matches the
  // workspace exactly. Adjusted = (sale_price - effective_imp)/acres
  // where effective_imp resolves through the broker's per-comp
  // overrides before falling back to the comp's own improvement
  // fields.
  const totalPpa = comp.computed_total_ppa;
  const adjustedPpa = comp.computed_adjusted_ppa;
  const sold = comp.sale_price ?? null;

  return (
    <View
      style={{
        flexDirection: 'row',
        paddingVertical: 8,
        paddingHorizontal: 6,
        borderBottomWidth: 0.5,
        borderBottomColor: COLORS.beige,
        backgroundColor: striped ? COLORS.cream2 : 'transparent',
      }}
    >
      <Text style={{ flex: COLS.num, fontSize: TYPE.small, color: COLORS.gold, fontFamily: 'Helvetica-Bold' }}>
        {index}
      </Text>
      <Text style={{ flex: COLS.address, fontSize: TYPE.small, color: COLORS.ink, paddingRight: 6 }}>
        {addressLine}
      </Text>
      <Text style={{ flex: COLS.county, fontSize: TYPE.small, color: COLORS.ink2 }}>
        {comp.county || '—'}
      </Text>
      <Text style={{ flex: COLS.acres, fontSize: TYPE.small, color: COLORS.ink, textAlign: 'right' }}>
        {comp.acres != null ? fmtAcres(comp.acres) : '—'}
      </Text>
      <Text style={{ flex: COLS.sold, fontSize: TYPE.small, color: COLORS.ink, textAlign: 'right' }}>
        {sold != null ? fmtMoney(sold) : '—'}
      </Text>
      <Text style={{ flex: COLS.date, fontSize: TYPE.small, color: COLORS.ink2, textAlign: 'right' }}>
        {fmtDate(comp.sale_date)}
      </Text>
      <Text
        style={{
          flex: COLS.ppaTotal,
          fontSize: TYPE.small,
          color: COLORS.ink,
          textAlign: 'right',
        }}
      >
        {totalPpa != null ? fmtPpa(totalPpa) : '—'}
      </Text>
      <Text
        style={{
          flex: COLS.ppaAdj,
          fontSize: TYPE.small,
          color: COLORS.ink,
          textAlign: 'right',
          fontFamily: 'Helvetica-Bold',
        }}
      >
        {adjustedPpa != null ? fmtPpa(adjustedPpa) : '—'}
      </Text>
    </View>
  );
}

/**
 * Final row of the comp table — column-aligned averages line.
 *
 *   Acres column   → average acreage across comps
 *   Sold Price col → average sale_price across comps
 *   Sale Date col  → blank (no meaningful average)
 *   $/Ac Total     → stats.total.mid (from computeCmaAverages)
 *   $/Ac Adjusted  → stats.adjusted.mid (from computeCmaAverages)
 *
 * Styled with the goldTint background + a slightly heavier
 * top border so it visually caps off the comp rows.
 */
function CompTableAveragesRow({
  comps,
  stats,
}: {
  comps: CmaPdfComp[];
  stats: CmaPdfData['stats'];
}) {
  const acreVals = comps.map((c) => c.acres).filter((v): v is number => v != null && v > 0);
  const priceVals = comps.map((c) => c.sale_price).filter((v): v is number => v != null && v > 0);
  const avgAcres = acreVals.length ? acreVals.reduce((s, v) => s + v, 0) / acreVals.length : null;
  const avgPrice = priceVals.length ? priceVals.reduce((s, v) => s + v, 0) / priceVals.length : null;

  return (
    <View
      style={{
        flexDirection: 'row',
        paddingVertical: 9,
        paddingHorizontal: 6,
        backgroundColor: COLORS.goldTint,
        borderTopWidth: 2,
        borderTopColor: COLORS.gold,
        borderBottomWidth: 0.5,
        borderBottomColor: COLORS.beige2,
      }}
    >
      <Text
        style={{
          flex: COLS.num,
          fontSize: TYPE.small,
          color: COLORS.goldDark,
          fontFamily: 'Helvetica-Bold',
        }}
      >
        ⌀
      </Text>
      <Text
        style={{
          flex: COLS.address,
          fontSize: TYPE.small,
          color: COLORS.goldDark,
          fontFamily: 'Helvetica-Bold',
          paddingRight: 6,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        Average
      </Text>
      <Text style={{ flex: COLS.county, fontSize: TYPE.small, color: COLORS.ink3 }}>
        —
      </Text>
      <Text
        style={{
          flex: COLS.acres,
          fontSize: TYPE.small,
          color: COLORS.ink,
          textAlign: 'right',
          fontFamily: 'Helvetica-Bold',
        }}
      >
        {avgAcres != null ? fmtAcres(avgAcres) : '—'}
      </Text>
      <Text
        style={{
          flex: COLS.sold,
          fontSize: TYPE.small,
          color: COLORS.ink,
          textAlign: 'right',
          fontFamily: 'Helvetica-Bold',
        }}
      >
        {avgPrice != null ? fmtMoney(avgPrice) : '—'}
      </Text>
      <Text style={{ flex: COLS.date, fontSize: TYPE.small, color: COLORS.ink3, textAlign: 'right' }}>
        —
      </Text>
      <Text
        style={{
          flex: COLS.ppaTotal,
          fontSize: TYPE.small,
          color: COLORS.ink,
          textAlign: 'right',
          fontFamily: 'Helvetica-Bold',
        }}
      >
        {stats.total.mid != null ? fmtPpa(stats.total.mid) : '—'}
      </Text>
      <Text
        style={{
          flex: COLS.ppaAdj,
          fontSize: TYPE.small,
          color: COLORS.goldDark,
          textAlign: 'right',
          fontFamily: 'Helvetica-Bold',
        }}
      >
        {stats.adjusted.mid != null ? fmtPpa(stats.adjusted.mid) : '—'}
      </Text>
    </View>
  );
}

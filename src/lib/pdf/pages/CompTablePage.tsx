// Marketing CMA PDF — Page 3 (Comparable Sales).
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
  const subjectPpa = data.stats.median_ppa ?? data.stats.avg_ppa ?? null;

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
      </View>

      {/* Summary footer — average $/Ac across all comps. */}
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
            AVG $/ACRE
          </Text>
          <Text style={{ fontSize: TYPE.h3, color: COLORS.ink }}>
            {data.stats.avg_ppa != null ? fmtPpa(data.stats.avg_ppa) : '—'}
          </Text>
        </View>
        <View>
          <Text style={{ fontSize: TYPE.tiny, color: COLORS.ink3, marginBottom: 2 }}>
            MEDIAN $/ACRE
          </Text>
          <Text style={{ fontSize: TYPE.h3, color: COLORS.ink }}>
            {subjectPpa != null ? fmtPpa(subjectPpa) : '—'}
          </Text>
        </View>
        <View>
          <Text style={{ fontSize: TYPE.tiny, color: COLORS.ink3, marginBottom: 2 }}>
            RANGE
          </Text>
          <Text style={{ fontSize: TYPE.h3, color: COLORS.ink }}>
            {data.stats.min_ppa != null && data.stats.max_ppa != null
              ? `${fmtPpa(data.stats.min_ppa)} – ${fmtPpa(data.stats.max_ppa)}`
              : '—'}
          </Text>
        </View>
      </View>

      <PageFooter data={data} pageNum={3} />
    </Page>
  );
}

// Column widths sum to 100 — react-pdf flex respects relative
// proportions. Address is the elastic column.
const COLS = {
  num: 4,
  address: 26,
  county: 12,
  acres: 10,
  sold: 14,
  date: 16,
  ppa: 18,
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
      <HeaderCell width={COLS.ppa} text="$/Acre" align="right" />
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

  // $/Ac source: ppa_land_only first (per migration 027 — broker-
  // verified land-only price), then price_per_acre.
  const ppa = comp.ppa_land_only ?? comp.price_per_acre ?? null;
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
          flex: COLS.ppa,
          fontSize: TYPE.small,
          color: COLORS.ink,
          textAlign: 'right',
          fontFamily: 'Helvetica-Bold',
        }}
      >
        {ppa != null ? fmtPpa(ppa) : '—'}
      </Text>
    </View>
  );
}

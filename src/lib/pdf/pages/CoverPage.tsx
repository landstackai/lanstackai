// Marketing CMA PDF — Page 1 (Cover).
//
// Models the Borgelt CMA cover the broker shared as a reference:
//
//   ┌────────────────────────────┐
//   │   [hero aerial image]      │
//   │                            │
//   │   PROPERTY VALUATION       │
//   │                            │
//   │   Ranch Name               │  ← Instrument Serif, big
//   │   County, TX · 551± acres  │
//   │                            │
//   │   Prepared for the Owner   │
//   │   by [Broker Name]         │
//   │   [Brokerage]              │
//   │                            │
//   │   May 26, 2026             │
//   └────────────────────────────┘
//
// Hero image source order:
//   1. subject.cover_image_url (broker upload) — V2 feature, currently
//      always null until that upload UI ships
//   2. subject_aerial_url (Mapbox static of the boundary) — computed
//      by the PDF route from subject lat/lng + boundary_geojson
//   3. No image — render a gold accent band as a graceful fallback
//
// All "broker info" comes from the profiles row, not hardcoded. V1
// hardcoding lives in the cma_pdf_route's profile lookup defaults
// (so a broker who hasn't set full_name still gets a sensible cover).

import React from 'react';
import { Page, View, Text, Image } from '@react-pdf/renderer';
import { styles, COLORS, TYPE, PAGE, fmtAcres, fmtDate } from '../theme';
import type { CmaPdfData } from '../types';

export function CoverPage({ data }: { data: CmaPdfData }) {
  const heroUrl = data.subject.cover_image_url || data.subject_aerial_url;
  const broker = data.broker;
  const subjectAcres = data.subject.acres;
  const locationLine = [data.subject.county, data.subject.state]
    .filter(Boolean)
    .join(', ') || '—';

  return (
    <Page size="LETTER" style={[styles.page, { padding: 0 }]}>
      {/* Hero image fills the top 55% of the page. */}
      <View style={{ height: PAGE.height * 0.55, backgroundColor: COLORS.beige2 }}>
        {heroUrl ? (
          <Image src={heroUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          // No aerial available — render a calm gold gradient fallback
          // so the cover still feels intentional.
          <View
            style={{
              width: '100%',
              height: '100%',
              backgroundColor: COLORS.goldTint,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: TYPE.tiny, color: COLORS.ink4, letterSpacing: 1.4 }}>
              NO AERIAL AVAILABLE
            </Text>
          </View>
        )}
      </View>

      {/* Gold separator bar under the hero — visual signature. */}
      <View style={{ height: 6, backgroundColor: COLORS.gold }} />

      {/* Title block — generous whitespace, serif headline. */}
      <View style={{ flex: 1, paddingHorizontal: PAGE.margin, paddingTop: 36 }}>
        {/* Kicker */}
        <Text
          style={{
            fontSize: TYPE.micro,
            color: COLORS.goldDark,
            letterSpacing: 2,
            textTransform: 'uppercase',
            fontFamily: 'Helvetica-Bold',
            marginBottom: 14,
          }}
        >
          Comparative Market Analysis
        </Text>

        {/* Property name — the hero */}
        <Text style={[styles.hero, { marginBottom: 8 }]}>
          {data.subject.name || 'Subject Property'}
        </Text>

        {/* Subhead — location · acreage */}
        <Text style={{ fontSize: TYPE.h2, color: COLORS.ink2, marginBottom: 32 }}>
          {locationLine}
          {subjectAcres != null ? ` · ${fmtAcres(subjectAcres)}` : ''}
        </Text>

        {/* Broker block — anchored bottom-left */}
        <View style={{ marginTop: 'auto', marginBottom: 8 }}>
          <Text style={[styles.sectionLabel, { color: COLORS.ink4 }]}>Prepared by</Text>
          <Text style={{ fontSize: TYPE.h3, color: COLORS.ink, marginBottom: 2 }}>
            {broker.full_name || 'Your Land Broker'}
          </Text>
          {broker.brokerage_name ? (
            <Text style={{ fontSize: TYPE.body, color: COLORS.ink2 }}>{broker.brokerage_name}</Text>
          ) : null}
          {broker.email || broker.phone ? (
            <Text style={{ fontSize: TYPE.small, color: COLORS.ink3, marginTop: 4 }}>
              {[broker.email, broker.phone].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
        </View>

        {/* Generated date — small, bottom-right */}
        <View
          style={{
            position: 'absolute',
            right: PAGE.margin,
            bottom: 28,
          }}
        >
          <Text style={{ fontSize: TYPE.small, color: COLORS.ink3 }}>
            {fmtDate(data.generated_at)}
          </Text>
        </View>
      </View>
    </Page>
  );
}

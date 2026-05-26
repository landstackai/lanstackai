// Marketing CMA PDF — Page 2 (Subject Property Overview).
//
// Pairs the broker's polished prose narrative (drafted/edited via the
// workspace UI in PR #48) with a small fact box on the right rail:
//
//   ┌──────────────────────────────────────────────┐
//   │ SUBJECT PROPERTY                             │
//   │ ──                                           │
//   │                                              │
//   │  Ranch Name             ┌────────────────┐   │
//   │  county, tx · acres     │  FAST FACTS    │   │
//   │                         │  Acres ...     │   │
//   │  [Polished prose body]  │  County ...    │   │
//   │  [Polished prose body]  │  State  ...    │   │
//   │  [Polished prose body]  │  Address ...   │   │
//   │                         └────────────────┘   │
//   │                                              │
//   └──────────────────────────────────────────────┘
//
// When prose is empty (broker skipped the AI step), we still render
// the section title + fact box and a single line explaining the
// section was intentionally left brief.

import React from 'react';
import { Page, View, Text } from '@react-pdf/renderer';
import { styles, COLORS, TYPE, PAGE, fmtAcres } from '../theme';
import type { CmaPdfData } from '../types';
import { PageFooter } from './_chrome';

export function SubjectOverviewPage({ data }: { data: CmaPdfData }) {
  const prose = (data.subject.overview_prose || '').trim();
  const paragraphs = prose
    ? prose.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    : [];

  return (
    <Page size="LETTER" style={styles.page}>
      {/* Section header */}
      <Text style={styles.sectionLabel}>Subject Property</Text>
      <View style={styles.goldRule} />
      <Text style={[styles.h1, { marginBottom: 4 }]}>
        {data.subject.name || 'Subject Property'}
      </Text>
      <Text style={[styles.bodyMuted, { marginBottom: 24 }]}>
        {[data.subject.county, data.subject.state].filter(Boolean).join(', ')}
        {data.subject.acres != null ? ` · ${fmtAcres(data.subject.acres)}` : ''}
      </Text>

      {/* Two-column layout: prose on the left, fact box on the right. */}
      <View style={[styles.row, { gap: 24 }]}>
        {/* Prose column */}
        <View style={{ flex: 1.7 }}>
          {paragraphs.length > 0 ? (
            paragraphs.map((para, i) => (
              <Text
                key={i}
                style={[
                  styles.body,
                  {
                    marginBottom: 12,
                    textAlign: 'justify',
                  },
                ]}
              >
                {para}
              </Text>
            ))
          ) : (
            <Text style={[styles.bodyMuted, { fontStyle: 'italic' }]}>
              No narrative overview provided. Please refer to the comparable
              sales analysis and broker contact info on the following pages.
            </Text>
          )}
        </View>

        {/* Fact box — boxed list of structured facts */}
        <View
          style={{
            flex: 1,
            backgroundColor: COLORS.goldTint,
            borderLeftWidth: 2,
            borderLeftColor: COLORS.gold,
            paddingVertical: 14,
            paddingHorizontal: 14,
            alignSelf: 'flex-start',
          }}
        >
          <Text
            style={{
              fontSize: TYPE.micro,
              color: COLORS.goldDark,
              letterSpacing: 1.4,
              textTransform: 'uppercase',
              fontFamily: 'Helvetica-Bold',
              marginBottom: 10,
            }}
          >
            Fast Facts
          </Text>

          <FactRow label="Acreage" value={data.subject.acres != null ? fmtAcres(data.subject.acres) : '—'} />
          <FactRow label="County" value={data.subject.county || '—'} />
          <FactRow label="State" value={data.subject.state || '—'} />
          {data.subject.address ? <FactRow label="Address" value={data.subject.address} /> : null}
        </View>
      </View>

      <PageFooter data={data} pageNum={2} />
    </Page>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ marginBottom: 8 }}>
      <Text style={{ fontSize: TYPE.tiny, color: COLORS.ink3, marginBottom: 1 }}>{label}</Text>
      <Text style={{ fontSize: TYPE.body, color: COLORS.ink }}>{value}</Text>
    </View>
  );
}

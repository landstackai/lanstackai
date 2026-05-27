// Marketing CMA PDF — Page 6 (Methodology / Disclosures).
//
// The closing page. Explains in plain language how the analysis was
// constructed and what it is not. Modeled after the Borgelt
// methodology note but in the calm voice Landstack uses everywhere.
//
// Content is largely static — we substitute the broker name and
// brokerage so it feels personal, but the actual methodology language
// is the same for every CMA. Future variation can come from a
// brokerage settings table.

import React from 'react';
import { Page, View, Text } from '@react-pdf/renderer';
import { styles, COLORS, TYPE } from '../theme';
import type { CmaPdfData } from '../types';
import { PageFooter } from './_chrome';

export function MethodologyPage({ data }: { data: CmaPdfData }) {
  const brokerName = data.broker.full_name || 'Your land broker';
  const brokerageName = data.broker.brokerage_name || '';

  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.sectionLabel}>Methodology</Text>
      <View style={styles.goldRule} />
      <Text style={[styles.h1, { marginBottom: 24 }]}>How This Analysis Was Built</Text>

      <Section title="Selecting Comparable Sales">
        Comparable sales were chosen from public records and private broker networks for
        proximity, similarity of acreage, sale recency, and comparability of land character —
        improvements, water, road frontage, and use potential. Listings that are still
        active or pending have been excluded; only closed sales contribute to the analysis.
      </Section>

      <Section title="Adjusting for Improvements">
        Where comparable sales included material improvements (homes, barns, infrastructure),
        the improvement value has been estimated and removed, yielding a price-per-acre that
        reflects raw land value. This adjustment lets us compare apples to apples across a
        comp set that may include both improved and unimproved tracts.
      </Section>

      <Section title="Deriving the Opinion of Value">
        The opinion of value is built from the adjusted comp set, weighted by the broker's
        professional judgment of each comp's relevance to the subject. It is not a formal
        appraisal and should not be relied upon for financing, tax assessment, or estate
        purposes — those require a licensed appraiser.
      </Section>

      <Section title="What the Number Means">
        This is the price at which {brokerName} believes the property is most likely to
        sell within a reasonable marketing period, given current conditions and the subject's
        unique character. Markets shift; this opinion reflects the data available as of the
        report date on the cover.
      </Section>

      <View style={{ marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: COLORS.beige2 }}>
        <Text style={[styles.sectionLabel, { color: COLORS.ink4 }]}>Prepared by</Text>
        <Text style={{ fontSize: TYPE.h3, color: COLORS.ink, marginBottom: 2 }}>{brokerName}</Text>
        {brokerageName ? (
          <Text style={{ fontSize: TYPE.body, color: COLORS.ink2 }}>{brokerageName}</Text>
        ) : null}
        {data.broker.email || data.broker.phone ? (
          <Text style={{ fontSize: TYPE.small, color: COLORS.ink3, marginTop: 4 }}>
            {[data.broker.email, data.broker.phone].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>

      <PageFooter data={data} pageNum={6} />
    </Page>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={[styles.h3, { marginBottom: 4 }]}>{title}</Text>
      <Text style={[styles.body, { color: COLORS.ink2, textAlign: 'justify' }]}>{children}</Text>
    </View>
  );
}

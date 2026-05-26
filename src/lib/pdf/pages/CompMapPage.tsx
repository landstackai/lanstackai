// Marketing CMA PDF — Page 3 (Comparable Sales Map).
//
// Single-page annotated map showing:
//   - Subject property pin (warm brick red, matches the workspace)
//   - One numbered pin per comp (matches the row numbers on Page 4,
//     so the client can cross-reference)
//   - Compact legend on the side
//
// Image source: Mapbox Static Images API URL pre-built by the PDF
// route (see /api/cma/[id]/pdf). The route generates the URL once
// using mapboxStaticUrl-style construction with multiple pin markers,
// and passes the resolved URL string in as data.comp_map_url. The
// component just <Image>s it.
//
// Why pre-build server-side: react-pdf can't follow redirects
// gracefully and image fetches mid-render hurt cold-start latency.
// Plus the URL construction logic lives close to the data fetch.

import React from 'react';
import { Page, View, Text, Image } from '@react-pdf/renderer';
import { styles, COLORS, TYPE } from '../theme';
import type { CmaPdfData } from '../types';
import { PageFooter } from './_chrome';

export function CompMapPage({ data }: { data: CmaPdfData }) {
  const mapUrl = data.comp_map_url;

  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.sectionLabel}>Comparable Sales Map</Text>
      <View style={styles.goldRule} />
      <Text style={[styles.h1, { marginBottom: 4 }]}>Sales Location Map</Text>
      <Text style={[styles.bodyMuted, { marginBottom: 16 }]}>
        Subject property shown in red; comparable sales numbered to match the table on the following page.
      </Text>

      {/* Map image fills most of the page. */}
      <View
        style={{
          backgroundColor: COLORS.beige2,
          borderWidth: 1,
          borderColor: COLORS.beige2,
          height: 460,
          marginBottom: 16,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {mapUrl ? (
          <Image
            src={mapUrl}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : (
          <View style={{ alignItems: 'center' }}>
            <Text style={{ fontSize: TYPE.small, color: COLORS.ink3, marginBottom: 4 }}>
              Map unavailable
            </Text>
            <Text style={{ fontSize: TYPE.tiny, color: COLORS.ink4 }}>
              Mapbox token not configured or no comp coordinates set.
            </Text>
          </View>
        )}
      </View>

      {/* Legend — subject + comp pin descriptions */}
      <View style={[styles.row, { gap: 24, flexWrap: 'wrap' }]}>
        <LegendItem color={COLORS.brick} label={`Subject — ${data.subject.name || 'Property'}`} />
        <LegendItem color={COLORS.gold} label={`${data.comps.length} comparable ${data.comps.length === 1 ? 'sale' : 'sales'}`} />
      </View>

      <PageFooter data={data} pageNum={3} />
    </Page>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View
        style={{
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: color,
          borderWidth: 1.5,
          borderColor: '#fff',
        }}
      />
      <Text style={{ fontSize: TYPE.small, color: COLORS.ink2 }}>{label}</Text>
    </View>
  );
}

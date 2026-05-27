// Shared page chrome — the footer that appears on every interior page
// (everything except the cover, which renders its own treatment).
//
// Format:
//   [BROKERAGE NAME · BROKER NAME]                    [SUBJECT NAME · PAGE N]
//
// Kept intentionally small so it doesn't compete with the page content.

import React from 'react';
import { View, Text } from '@react-pdf/renderer';
import { styles, COLORS, TYPE } from '../theme';
import type { CmaPdfData } from '../types';

export function PageFooter({ data, pageNum }: { data: CmaPdfData; pageNum: number }) {
  const leftParts = [data.broker.brokerage_name, data.broker.full_name].filter(Boolean);
  const rightParts = [data.subject.name, `Page ${pageNum}`].filter(Boolean);

  return (
    <View style={styles.footer} fixed>
      <Text style={{ color: COLORS.ink4, fontSize: TYPE.tiny }}>
        {leftParts.join(' · ') || 'Landstack CMA'}
      </Text>
      <Text style={{ color: COLORS.ink4, fontSize: TYPE.tiny }}>
        {rightParts.join(' · ')}
      </Text>
    </View>
  );
}

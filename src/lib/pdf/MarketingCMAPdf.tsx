// Marketing CMA PDF — root Document.
//
// Composes the six page components into one renderable react-pdf
// <Document>. All page components consume the same CmaPdfData shape
// (see types.ts) which the PDF render route (/api/cma/[id]/pdf)
// builds up before invoking pdf(<MarketingCMAPdf data={...} />).
//
// Page order:
//   1. Cover                  — hero aerial + property title + broker block
//   2. Subject Overview       — broker's polished prose + fast facts
//   3. Comparable Sales Map   — annotated Mapbox static image
//                                (lands first so the reader sees WHERE
//                                 the comps are before reading the table)
//   4. Comparable Sales Table — every comp the broker selected
//   5. Opinion of Value       — the headline reveal (mode-aware)
//   6. Methodology            — how the analysis was built + disclaimers
//
// Future expansion (V2): brokerage branding insert (logo + accent color
// override) reads from a brokerages settings table and overrides the
// theme. For V1 the theme is hard-coded to the Borgelt-inspired palette.

import React from 'react';
import { Document } from '@react-pdf/renderer';
import { registerPdfFonts } from './theme';
import type { CmaPdfData } from './types';
import { CoverPage } from './pages/CoverPage';
import { SubjectOverviewPage } from './pages/SubjectOverviewPage';
import { CompTablePage } from './pages/CompTablePage';
import { CompMapPage } from './pages/CompMapPage';
import { OpinionPage } from './pages/OpinionPage';
import { MethodologyPage } from './pages/MethodologyPage';

export function MarketingCMAPdf({ data }: { data: CmaPdfData }) {
  // Font registration is idempotent — see theme.ts. We call here so
  // any direct render of <MarketingCMAPdf> (including future preview
  // surfaces) gets the fonts loaded.
  registerPdfFonts();

  return (
    <Document
      title={`CMA — ${data.subject.name || 'Subject Property'}`}
      author={data.broker.full_name || 'Landstack'}
      subject="Comparative Market Analysis"
      creator="Landstack"
      producer="Landstack"
    >
      <CoverPage data={data} />
      <SubjectOverviewPage data={data} />
      <CompMapPage data={data} />
      <CompTablePage data={data} />
      <OpinionPage data={data} />
      <MethodologyPage data={data} />
    </Document>
  );
}

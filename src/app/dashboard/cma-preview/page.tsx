'use client';

/**
 * CMA WORKSPACE PHASE 1 PREVIEW — STATIC MOCKUP
 * ─────────────────────────────────────────────────────────────────────
 * Demonstrates the proposed Phase 1 information-architecture reorder:
 *
 *   - Comps directly under the subject (currently: averages come first)
 *   - One $/Ac column (currently: three — Total / Land-Only / Adjusted)
 *   - Sticky top strip with the headline number always visible
 *   - Auto-derived averages BELOW the comps (they follow from comps)
 *   - Suggested List Price BELOW averages (broker judgment last)
 *   - Map as fixed left sidebar (stays visible while you scroll)
 *
 * This is a static mockup — no data loading, no save actions.
 * Real numbers from a realistic Gillespie-County 480-ac ranch comp set.
 *
 * Path: /dashboard/cma-preview
 */

import { useState } from 'react';
import { MapPin, Home, Sparkles, TrendingUp, Calendar, ChevronDown, Plus, FileText, Share2 } from 'lucide-react';

const SUBJECT = {
  name: 'Borgelt Ranch',
  county: 'Gillespie',
  state: 'TX',
  acres: 480,
  water: 'Pedernales tributary + 2 stock tanks',
  road: 'CR 2875, paved',
  notes: '90% improved pasture, 10% live oak motte. South-facing slope.',
};

const COMPS = [
  {
    id: '1',
    name: 'Crenwelge Tract',
    county: 'Gillespie',
    acres: 412,
    sale_date: 'Aug 2025',
    sale_price: 2_265_000,
    ppa_land: 5_498,
    water: 'Creek',
    relevance: 'high',
  },
  {
    id: '2',
    name: 'Schwartz Family Trust',
    county: 'Gillespie',
    acres: 560,
    sale_date: 'May 2025',
    sale_price: 2_800_000,
    ppa_land: 5_000,
    water: 'Stock tank',
    relevance: 'high',
  },
  {
    id: '3',
    name: 'Dare Hunting Ranch',
    county: 'Kerr',
    acres: 503,
    sale_date: 'Feb 2025',
    sale_price: 2_414_000,
    ppa_land: 4_800,
    water: 'Spring + 3 tanks',
    relevance: 'medium',
  },
  {
    id: '4',
    name: 'Faulkner Tract',
    county: 'Mason',
    acres: 445,
    sale_date: 'Nov 2024',
    sale_price: 2_002_500,
    ppa_land: 4_500,
    water: 'None',
    relevance: 'medium',
  },
  {
    id: '5',
    name: 'Caraway Partners',
    county: 'Gillespie',
    acres: 388,
    sale_date: 'Oct 2024',
    sale_price: 2_134_000,
    ppa_land: 5_500,
    water: 'Creek + tank',
    relevance: 'high',
  },
  {
    id: '6',
    name: 'Llano River Reserve',
    county: 'Llano',
    acres: 521,
    sale_date: 'Aug 2024',
    sale_price: 2_344_500,
    ppa_land: 4_500,
    water: 'River frontage',
    relevance: 'low',
  },
];

const AVG_PPA = Math.round(COMPS.reduce((s, c) => s + c.ppa_land, 0) / COMPS.length);
const MIN_PPA = Math.min(...COMPS.map((c) => c.ppa_land));
const MAX_PPA = Math.max(...COMPS.map((c) => c.ppa_land));
const SUGGESTED_PPA = 5_000;
const SUGGESTED_LIST = SUBJECT.acres * SUGGESTED_PPA;

const BREAKDOWN = [
  { label: 'Improved pasture', acres: 432, ppa: 5_200 },
  { label: 'Live oak motte', acres: 48, ppa: 3_800 },
];

const fmtCur = (n: number) =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const fmtPPA = (n: number) => `$${n.toLocaleString('en-US')}/ac`;

export default function CmaPreviewPage() {
  const [showOldOrder, setShowOldOrder] = useState(false);

  return (
    <div className="h-full bg-ink-deep text-cream-1 overflow-hidden flex flex-col">
      {/* ─── STICKY TOP STRIP — the headline is always visible ─────────── */}
      <div className="sticky top-0 z-30 bg-ink-deep/95 backdrop-blur-md border-b border-ink-line/70 px-6 py-3 flex items-center gap-6 shadow-lg shadow-black/30">
        <div className="flex items-center gap-2 min-w-0">
          <Home size={16} className="text-cream-3-text shrink-0" />
          <div className="flex flex-col leading-tight min-w-0">
            <span className="text-xs text-cream-3-text uppercase tracking-wider">CMA</span>
            <span className="text-sm font-semibold text-cream-1 truncate">{SUBJECT.name}</span>
          </div>
        </div>
        <div className="h-8 w-px bg-ink-line/70" />
        <div className="flex flex-col leading-tight">
          <span className="text-xs text-cream-3-text uppercase tracking-wider">Property</span>
          <span className="text-sm font-medium text-cream-1">
            {SUBJECT.acres}± ac · {SUBJECT.county}, {SUBJECT.state}
          </span>
        </div>
        <div className="h-8 w-px bg-ink-line/70" />
        <div className="flex flex-col leading-tight">
          <span className="text-xs text-cream-3-text uppercase tracking-wider">Suggested List</span>
          <span className="text-base font-bold text-olive-light">
            {fmtCur(SUGGESTED_LIST)} <span className="text-cream-2-text text-xs font-normal">· {fmtPPA(SUGGESTED_PPA)}</span>
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button className="text-xs font-semibold text-cream-2-text hover:text-cream-1 px-3 py-1.5 rounded-lg border border-ink-line/70 hover:border-olive-light/40 transition-colors flex items-center gap-1.5">
            <Share2 size={12} />
            Share with client
          </button>
          <button className="text-xs font-semibold text-cream-2-text hover:text-cream-1 px-3 py-1.5 rounded-lg border border-ink-line/70 hover:border-olive-light/40 transition-colors flex items-center gap-1.5">
            <FileText size={12} />
            Download PDF
          </button>
        </div>
      </div>

      {/* ─── PREVIEW BANNER — explains this is a mockup ────────────────── */}
      <div className="bg-amber-warm/15 border-b border-amber-warm/30 px-6 py-2 flex items-center gap-3 text-xs">
        <Sparkles size={12} className="text-amber-warm" />
        <span className="text-amber-warm font-semibold">Phase 1 Preview</span>
        <span className="text-cream-2-text">
          Static mockup of the proposed CMA workspace reorder. No save actions are wired up.
        </span>
        <button
          onClick={() => setShowOldOrder((v) => !v)}
          className="ml-auto text-amber-warm hover:text-amber-warm/80 underline font-medium"
        >
          {showOldOrder ? 'Hide "before" sketch' : 'Show "before" sketch'}
        </button>
      </div>

      {/* ─── MAIN SPLIT ────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Map sidebar (fixed) */}
        <div className="w-[42%] border-r border-ink-line/70 bg-ink-mid/40 relative overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(168,181,122,0.08)_0%,_transparent_60%)]" />
          <div className="absolute inset-0 flex flex-col items-center justify-center text-cream-3-text gap-3">
            <MapPin size={48} className="text-olive-light/40" />
            <div className="text-sm font-semibold">[Map sidebar]</div>
            <div className="text-xs text-cream-3-text/80 max-w-xs text-center">
              Subject pin (red) + 6 comp pins. Always visible while the right
              pane scrolls. In real workspace, fully interactive.
            </div>
          </div>
          <div className="absolute bottom-4 left-4 right-4 bg-ink-deep/90 backdrop-blur-md border border-ink-line/70 rounded-xl p-3 text-xs">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-[#C8503F]" />
              <span className="font-semibold text-cream-1">Subject</span>
              <span className="text-cream-3-text ml-auto">{SUBJECT.acres} ac</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-olive-light" />
              <span className="font-semibold text-cream-1">Comps</span>
              <span className="text-cream-3-text ml-auto">{COMPS.length} parcels</span>
            </div>
          </div>
        </div>

        {/* Scrolling content pane */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 py-6 space-y-6">

            {showOldOrder && (
              <div className="bg-ink-mid/40 border border-cream-3-text/30 rounded-2xl p-5 mb-4">
                <div className="text-xs font-semibold text-cream-3-text uppercase tracking-wider mb-3">
                  Before — current order
                </div>
                <ol className="text-sm text-cream-2-text space-y-1 list-decimal list-inside">
                  <li>Subject</li>
                  <li className="line-through opacity-60">
                    Big numbers card (BOV / OOV / Suggested List){' '}
                    <span className="not-line-through opacity-100 text-amber-warm">← answer comes first</span>
                  </li>
                  <li className="line-through opacity-60">Breakdown by use type</li>
                  <li className="line-through opacity-60">Comp table (the evidence)</li>
                </ol>
                <div className="text-xs text-cream-3-text mt-3 italic">
                  Reorder below: comps first, conclusion last. The numbers are what they are.
                </div>
              </div>
            )}

            {/* 1 — SUBJECT CARD */}
            <Section step={1} label="Subject">
              <div className="bg-ink-mid/60 border border-ink-line/70 rounded-2xl p-5">
                <div className="flex items-baseline justify-between gap-3 mb-3">
                  <div>
                    <div className="text-xl font-bold text-cream-1 leading-tight">{SUBJECT.name}</div>
                    <div className="text-sm text-cream-2-text">
                      {SUBJECT.acres}± ac · {SUBJECT.county} County, {SUBJECT.state}
                    </div>
                  </div>
                  <button className="text-xs font-medium text-olive-light hover:text-olive-light/80">
                    Edit subject →
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <Attr label="Water" value={SUBJECT.water} />
                  <Attr label="Road" value={SUBJECT.road} />
                  <Attr label="Cover" value={SUBJECT.notes} />
                </div>
              </div>
            </Section>

            {/* 2 — COMP TABLE (THE WORK) */}
            <Section step={2} label="Comps — the evidence" emphasized>
              <div className="bg-ink-mid/60 border border-olive-light/30 rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-ink-line/70 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-cream-1">
                      {COMPS.length} comparable sales
                    </span>
                    <span className="text-xs text-cream-3-text">· last 14 months</span>
                  </div>
                  <button className="text-xs font-semibold text-olive-light hover:text-olive-light/80 flex items-center gap-1">
                    <Plus size={12} />
                    Add comp
                  </button>
                </div>
                <table className="w-full text-xs">
                  <thead className="bg-ink-deep/40 text-cream-3-text uppercase tracking-wider">
                    <tr>
                      <th className="text-left px-5 py-2.5 font-semibold">Property</th>
                      <th className="text-left px-3 py-2.5 font-semibold">County</th>
                      <th className="text-right px-3 py-2.5 font-semibold">Acres</th>
                      <th className="text-left px-3 py-2.5 font-semibold">Sold</th>
                      <th className="text-right px-3 py-2.5 font-semibold">Price</th>
                      <th className="text-right px-5 py-2.5 font-semibold">$/Ac</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMPS.map((c, i) => (
                      <tr
                        key={c.id}
                        className={`border-t border-ink-line/40 hover:bg-ink-deep/30 transition-colors ${
                          i % 2 === 1 ? 'bg-ink-deep/15' : ''
                        }`}
                      >
                        <td className="px-5 py-3">
                          <div className="font-semibold text-cream-1">{c.name}</div>
                          <div className="text-cream-3-text text-[10px]">{c.water}</div>
                        </td>
                        <td className="px-3 py-3 text-cream-2-text">{c.county}</td>
                        <td className="px-3 py-3 text-right text-cream-1 font-medium">{c.acres}</td>
                        <td className="px-3 py-3 text-cream-2-text">{c.sale_date}</td>
                        <td className="px-3 py-3 text-right text-cream-1 font-medium">{fmtCur(c.sale_price)}</td>
                        <td className="px-5 py-3 text-right font-bold text-olive-light">{fmtPPA(c.ppa_land)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="px-5 py-2.5 border-t border-ink-line/70 text-[10px] text-cream-3-text bg-ink-deep/30">
                  $/Ac shown is <span className="text-cream-2-text font-semibold">land-only</span> — sale price minus improvements,
                  divided by acres. Single column, no Total / Adjusted variants.
                </div>
              </div>
            </Section>

            {/* 3 — AUTO-DERIVED AVERAGES (follows from comps) */}
            <Section step={3} label="What those comps say">
              <div className="bg-ink-mid/40 border border-ink-line/70 rounded-2xl p-5">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <MetricCell label="Low" value={fmtPPA(MIN_PPA)} sub="cheapest comp" />
                  <MetricCell label="Average" value={fmtPPA(AVG_PPA)} sub={`${COMPS.length} comps`} emphasized />
                  <MetricCell label="High" value={fmtPPA(MAX_PPA)} sub="most expensive" />
                </div>
                <div className="mt-4 pt-4 border-t border-ink-line/50 text-xs text-cream-2-text flex items-start gap-2">
                  <TrendingUp size={12} className="text-olive-light shrink-0 mt-0.5" />
                  <span>
                    Range is $1,000/ac wide — fairly tight for Gillespie/Kerr/Mason at this size band.
                    Two outliers (Llano River Reserve low, Caraway high) explained by water access.
                  </span>
                </div>
              </div>
            </Section>

            {/* 4 — SUGGESTED LIST PRICE (broker judgment) */}
            <Section step={4} label="Your recommendation">
              <div className="bg-gradient-to-br from-olive-light/10 to-olive-light/5 border border-olive-light/40 rounded-2xl p-6">
                <div className="text-xs font-semibold text-olive-light uppercase tracking-wider mb-2">
                  Suggested List Price
                </div>
                <div className="text-4xl font-bold text-cream-1 leading-none mb-1">
                  {fmtCur(SUGGESTED_LIST)}
                </div>
                <div className="text-sm text-cream-2-text mb-4">
                  {fmtPPA(SUGGESTED_PPA)} · {SUBJECT.acres}± ac
                </div>
                <div className="text-xs text-cream-2-text leading-relaxed">
                  Anchored at <span className="font-semibold text-cream-1">$5,000/ac</span> —
                  slightly above the comp average of {fmtPPA(AVG_PPA)} to reflect the Pedernales-tributary
                  frontage and paved-road access. The Crenwelge and Caraway comps (both Gillespie, both with
                  creek frontage) sold at ${COMPS[0].ppa_land.toLocaleString()}/ac and
                  ${COMPS[4].ppa_land.toLocaleString()}/ac respectively — Borgelt sits comfortably between them.
                </div>
                <button className="mt-4 text-xs font-semibold text-olive-light hover:text-olive-light/80">
                  Edit reasoning →
                </button>
              </div>
            </Section>

            {/* 5 — BREAKDOWN (composition) */}
            <Section step={5} label="Value composition">
              <div className="bg-ink-mid/40 border border-ink-line/70 rounded-2xl p-5">
                <div className="space-y-3">
                  {BREAKDOWN.map((b) => {
                    const pct = (b.acres / SUBJECT.acres) * 100;
                    return (
                      <div key={b.label}>
                        <div className="flex items-baseline justify-between text-xs mb-1">
                          <span className="text-cream-1 font-medium">{b.label}</span>
                          <span className="text-cream-2-text">
                            {b.acres} ac · {fmtPPA(b.ppa)} ·{' '}
                            <span className="text-cream-1 font-semibold">{fmtCur(b.acres * b.ppa)}</span>
                          </span>
                        </div>
                        <div className="h-1.5 bg-ink-line/60 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-olive-light/60 rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 pt-4 border-t border-ink-line/50 flex items-center justify-between text-xs">
                  <span className="text-cream-3-text">Composition total</span>
                  <span className="text-cream-1 font-semibold">
                    {fmtCur(BREAKDOWN.reduce((s, b) => s + b.acres * b.ppa, 0))}
                  </span>
                </div>
              </div>
            </Section>

            {/* Empty-state demonstration */}
            <Section step={6} label="What an empty CMA looks like">
              <div className="bg-ink-mid/30 border border-dashed border-ink-line rounded-2xl p-10 text-center">
                <Plus size={32} className="text-cream-3-text/60 mx-auto mb-3" />
                <div className="text-base font-semibold text-cream-1 mb-1">Add your first comp</div>
                <div className="text-xs text-cream-3-text max-w-md mx-auto">
                  Comps tell the story — the averages and the recommendation flow from them.
                  Start by selecting parcels on the map or importing from a listing URL.
                </div>
                <button className="mt-4 text-xs font-semibold text-olive-light hover:text-olive-light/80 border border-olive-light/40 rounded-lg px-4 py-2">
                  Start with the map
                </button>
              </div>
            </Section>

            <div className="h-12" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  step,
  label,
  emphasized,
  children,
}: {
  step: number;
  label: string;
  emphasized?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2 px-1">
        <span
          className={`text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center ${
            emphasized
              ? 'bg-olive-light/25 text-olive-light border border-olive-light/40'
              : 'bg-ink-line/60 text-cream-3-text'
          }`}
        >
          {step}
        </span>
        <span
          className={`text-[11px] font-semibold uppercase tracking-wider ${
            emphasized ? 'text-olive-light' : 'text-cream-3-text'
          }`}
        >
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function Attr({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-cream-3-text mb-0.5">{label}</div>
      <div className="text-cream-1 leading-tight">{value}</div>
    </div>
  );
}

function MetricCell({
  label,
  value,
  sub,
  emphasized,
}: {
  label: string;
  value: string;
  sub: string;
  emphasized?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-3 ${
        emphasized ? 'bg-olive-light/10 border border-olive-light/40' : 'bg-ink-deep/30'
      }`}
    >
      <div className="text-[10px] uppercase tracking-wider text-cream-3-text mb-1">{label}</div>
      <div
        className={`text-lg font-bold leading-none ${
          emphasized ? 'text-olive-light' : 'text-cream-1'
        }`}
      >
        {value}
      </div>
      <div className="text-[10px] text-cream-3-text mt-1">{sub}</div>
    </div>
  );
}

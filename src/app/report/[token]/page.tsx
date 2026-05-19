'use client';

import { useState, useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { CMA, Comp } from '@/types';
import { formatPPA, formatAcres, formatCurrency, formatDate } from '@/lib/utils';
import { MapPin, ThumbsUp, ThumbsDown, HelpCircle, Layers, ArrowUpDown, ChevronDown, ExternalLink, Printer, MessageCircle, X } from 'lucide-react';
import { FeatureChip, isStrongFeature } from '@/components/comp/FeatureChip';
import mapboxgl from 'mapbox-gl';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

interface ClientReportProps {
  params: { token: string };
}

export default function ClientReport({ params }: ClientReportProps) {
  const [cma, setCMA] = useState<CMA | null>(null);
  const [comps, setComps] = useState<Comp[]>([]);
  const [selectedComp, setSelectedComp] = useState<Comp | null>(null);
  const [loading, setLoading] = useState(true);
  const [reactions, setReactions] = useState<Record<string, 'relevant' | 'question' | 'not_comparable'>>({});
  // Broker name + brokerage for branding the report header.
  const [broker, setBroker] = useState<{ full_name: string | null; brokerage_name: string | null } | null>(null);
  // Feedback modal state for the "Reply to broker" CTA.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackName, setFeedbackName] = useState('');
  const [feedbackEmail, setFeedbackEmail] = useState('');
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [hoveredCompId, setHoveredCompId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'default' | 'closest' | 'recent' | 'ppa'>('closest');
  const [showMethodology, setShowMethodology] = useState(false);
  const [expandedCompIds, setExpandedCompIds] = useState<Set<string>>(new Set());
  const [expandedDescriptionIds, setExpandedDescriptionIds] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpandedCompIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleDescription = (id: string) => {
    setExpandedDescriptionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  // Pin DOM elements keyed by comp id — used by the hover-highlight effect
  // to update styling without rebuilding markers.
  const markerElsRef = useRef<globalThis.Map<string, HTMLDivElement>>(new globalThis.Map());
  const supabase = createClient();

  useEffect(() => {
    const fetchReport = async () => {
      const { data: cmaData } = await supabase
        .from('cmas')
        .select('*')
        .eq('share_token', params.token)
        .single();

      if (!cmaData) {
        setLoading(false);
        return;
      }

      setCMA(cmaData as CMA);

      // Pull broker name + brokerage for branding. Migration 009 grants
      // anon SELECT on (id, full_name, brokerage_name) only; phone/email
      // stay private. Fails silently if migration not yet applied.
      if (cmaData.created_by) {
        const { data: prof } = await supabase
          .from('profiles')
          .select('full_name,brokerage_name')
          .eq('id', cmaData.created_by)
          .maybeSingle();
        if (prof) setBroker(prof as any);
      }

      if (cmaData.selected_comp_ids?.length > 0) {
        const { data: compsData } = await supabase
          .from('comps')
          .select('*')
          .in('id', cmaData.selected_comp_ids);

        if (compsData) setComps(compsData as Comp[]);
      }

      // Track view
      await supabase
        .from('cmas')
        .update({ share_views: (cmaData.share_views || 0) + 1 })
        .eq('id', cmaData.id);

      setLoading(false);
    };

    fetchReport();
  }, [params.token, supabase]);

  // Initialize the map once, then refresh markers when comps change
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  useEffect(() => {
    if (!mapContainer.current || map.current || loading) return;
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: [-99.5, 30.2],
      zoom: 6,
    });
    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

    // Mark the map ready once Mapbox finishes loading its style.
    // The marker-drawing effect waits on this flag so pins/boundary
    // are applied even if the data arrived before the map existed.
    map.current.once('load', () => setMapReady(true));

    // Safari sometimes initializes the map before the flex container has its
    // final height, leaving the canvas at 0px. Force a resize once layout
    // settles, and again whenever the container itself resizes.
    const m = map.current;
    const kick = () => m.resize();
    requestAnimationFrame(kick);
    setTimeout(kick, 200);
    const ro = new ResizeObserver(kick);
    ro.observe(mapContainer.current);
    return () => ro.disconnect();
  }, [loading]);

  // Place subject pin + comp markers when data is ready, fit bounds.
  // Depends on mapReady so it re-runs after the map's style finishes loading.
  useEffect(() => {
    if (!map.current || !cma || !mapReady) return;
    const apply = () => {
      if (!map.current) return;
      // Clear existing markers
      markersRef.current.forEach(m => m.remove());
      markersRef.current = [];
      markerElsRef.current.clear();

      const points: [number, number][] = [];

      // Subject pin (yellow)
      const subjLat = (cma as any).subject_latitude;
      const subjLng = (cma as any).subject_longitude;
      if (subjLat != null && subjLng != null) {
        const sEl = document.createElement('div');
        sEl.style.cssText = `
          background:#facc15;border:3px solid #0b0f14;border-radius:50%;
          width:18px;height:18px;
          box-shadow:0 0 0 3px #facc15aa, 0 4px 14px rgba(0,0,0,.6);
        `;
        sEl.title = cma.subject_name || 'Subject';
        const sm = new mapboxgl.Marker({ element: sEl }).setLngLat([subjLng, subjLat]).addTo(map.current);
        markersRef.current.push(sm);
        points.push([subjLng, subjLat]);
      }

      // Subject boundary if stored
      const subjBoundary = (cma as any).subject_boundary_geojson;
      const existingSrc = map.current.getSource('subj-boundary');
      if (subjBoundary) {
        if (existingSrc) {
          (existingSrc as mapboxgl.GeoJSONSource).setData({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: subjBoundary }],
          });
        } else {
          map.current.addSource('subj-boundary', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: subjBoundary }] },
          });
          map.current.addLayer({ id: 'subj-fill', type: 'fill', source: 'subj-boundary', paint: { 'fill-color': '#facc15', 'fill-opacity': 0.15 } });
          map.current.addLayer({ id: 'subj-line', type: 'line', source: 'subj-boundary', paint: { 'line-color': '#facc15', 'line-width': 2.5 } });
        }
      }

      // Comp pins
      comps.forEach((comp) => {
        if (comp.latitude == null || comp.longitude == null) return;
        const el = document.createElement('div');
        el.dataset.compId = comp.id;
        el.style.cssText = `
          background:#FFFFFF;border:2px solid #6B7B3F;border-radius:20px;
          padding:4px 8px;font-family:'DM Mono',monospace;font-size:11px;
          font-weight:700;color:#5C6B33;cursor:pointer;white-space:nowrap;
          box-shadow:0 2px 8px rgba(31,31,28,.18);
          transition:border-color .15s, box-shadow .15s, color .15s;
        `;
        el.textContent = `$${Math.round((comp.ppa_land_only || comp.price_per_acre || 0) / 1000)}k`;

        // Hover preview popup — exact mirror of the collapsed comp card in
        // the share report's Comparable Sales list (header + 4-col grid).
        // Same content visible at-a-glance whether hovering a pin OR scanning
        // the right panel. Click still opens the full expanded card.
        const totalPpa = comp.price_per_acre || 0;
        const adjustedPpa = comp.ppa_land_only || 0;
        const hasAdjustment = adjustedPpa > 0 && totalPpa > 0 && Math.abs(totalPpa - adjustedPpa) > 1;
        const isImproved = !!(comp as any).has_improvements;
        const isStrongIrrigation = (comp as any).irrigation === 'Strong';
        const isAgentVerified = (comp as any).improvement_source === 'agent_verified';
        const propertyName = (comp.property_name || `${comp.county} County`).replace(/</g, '&lt;');
        // Light-theme popup — same treatment as the dashboard map popup.
        // Ink text on white, slate-blue status badges, amber-800 ADJ.
        const bluePill = (label: string) =>
          `<span style="font-size:9px;font-weight:700;padding:1px 5px;background:rgba(74,111,165,0.10);color:#3A5A8A;border:1px solid rgba(74,111,165,0.22);border-radius:3px;letter-spacing:0.05em;">${label}</span>`;
        const improvedBadge = isImproved ? bluePill('IMPROVED') : '';
        const irrigationBadge = isStrongIrrigation ? bluePill('IRRIGATION') : '';
        const adjBadge = hasAdjustment
          ? `<span style="font-size:9px;color:#92400E;font-family:'DM Mono',monospace;font-weight:700;">ADJ</span>`
          : '';
        const agentBadge = isAgentVerified
          ? `<span style="font-size:9px;font-weight:700;padding:1px 5px;background:rgba(74,111,165,0.12);color:#3A5A8A;border:1px solid rgba(74,111,165,0.28);border-radius:3px;letter-spacing:0.05em;">Agent-Verified</span>`
          : '';
        const adjustedColor = hasAdjustment ? '#92400E' : 'rgba(146,64,14,0.45)';
        const adjustedValue = hasAdjustment ? formatPPA(adjustedPpa) : '—';
        const popupHtml = `
          <div style="padding:10px 12px;font-family:'Syne',sans-serif;">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
              <span style="font-weight:700;font-size:12px;color:#1F1F1C;letter-spacing:-0.01em;">${propertyName}</span>
              ${improvedBadge}
              ${irrigationBadge}
              ${adjBadge}
              ${agentBadge}
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,auto);column-gap:16px;row-gap:2px;font-family:'DM Mono',monospace;font-size:10px;white-space:nowrap;">
              <div style="color:#9C9A8F;">Acres</div>
              <div style="color:#9C9A8F;">Total</div>
              <div style="color:#9C9A8F;">Total $/Ac</div>
              <div style="color:#9C9A8F;">Adjusted $/Ac</div>
              <div style="color:#1F1F1C;font-weight:700;">${formatAcres(comp.acres)}</div>
              <div style="color:#1F1F1C;font-weight:700;">${formatCurrency(comp.sale_price)}</div>
              <div style="color:#5C6B33;font-weight:700;">${totalPpa > 0 ? formatPPA(totalPpa) : '—'}</div>
              <div style="color:${adjustedColor};font-weight:700;">${adjustedValue}</div>
            </div>
          </div>
        `;
        const popup = new mapboxgl.Popup({
          closeButton: false,
          closeOnClick: false,
          anchor: 'bottom',
          offset: 18,
          className: 'comp-hover-popup',
          // Mapbox defaults this to 240px which squashes the 4-col grid. Let
          // the popup size to its content via the inner div's natural width.
          maxWidth: 'none',
        })
          .setLngLat([comp.longitude, comp.latitude])
          .setHTML(popupHtml);

        el.addEventListener('mouseenter', () => {
          setHoveredCompId(comp.id);
          if (map.current) popup.addTo(map.current);
        });
        el.addEventListener('mouseleave', () => {
          setHoveredCompId((prev) => (prev === comp.id ? null : prev));
          popup.remove();
        });
        el.addEventListener('click', () => {
          popup.remove();
          setSelectedComp(comp);
          if (map.current) map.current.flyTo({ center: [comp.longitude!, comp.latitude!], zoom: 12, duration: 800 });
        });
        const m = new mapboxgl.Marker({ element: el }).setLngLat([comp.longitude, comp.latitude]).addTo(map.current!);
        markersRef.current.push(m);
        markerElsRef.current.set(comp.id, el);
        points.push([comp.longitude, comp.latitude]);
      });

      // Fit to all points
      if (points.length === 1) {
        map.current.flyTo({ center: points[0], zoom: 12, duration: 800 });
      } else if (points.length > 1) {
        let minLng = points[0][0], maxLng = points[0][0], minLat = points[0][1], maxLat = points[0][1];
        for (const [lng, lat] of points) {
          if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
        }
        map.current.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 60, duration: 800, maxZoom: 12 });
      }
    };

    if (map.current.isStyleLoaded()) apply();
    else map.current.once('load', apply);
  }, [cma, comps, mapReady]);

  // Imperative hover highlight on pins. Matches the CMA workspace color
  // scheme: blue-400 ring + border on hover (instead of sage).
  useEffect(() => {
    markerElsRef.current.forEach((el, id) => {
      const isHovered = id === hoveredCompId;
      if (isHovered) {
        el.style.boxShadow = '0 0 0 5px #60a5fa55, 0 6px 18px rgba(0,0,0,.7)';
        el.style.borderColor = '#60a5fa';
        el.style.color = '#60a5fa';
        el.style.zIndex = '10';
      } else {
        el.style.boxShadow = '0 2px 8px rgba(0,0,0,.5)';
        el.style.borderColor = '#34d399';
        el.style.color = '#34d399';
        el.style.zIndex = '1';
      }
    });
  }, [hoveredCompId]);

  const handleReaction = (compId: string, reaction: 'relevant' | 'question' | 'not_comparable') => {
    setReactions(prev => ({ ...prev, [compId]: reaction }));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-olive border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!cma) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center text-center p-4">
        <div>
          <div className="text-4xl mb-4">🔒</div>
          <h1 className="text-xl font-bold mb-2">Report Not Found</h1>
          <p className="text-ink-2 text-sm">This link may have expired or been revoked.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-cream flex flex-col overflow-hidden">
      {/* Header — brokerage branding takes the lead, landstack.ai retreats to footer */}
      <div className="bg-white border-b border-beige px-4 py-3 flex items-center justify-between flex-shrink-0 print:bg-white print:text-black print:border-slate-300">
        <div className="flex items-center gap-2 min-w-0">
          {broker?.brokerage_name ? (
            <div className="min-w-0">
              <p className="font-bold text-sm text-ink truncate print:text-black">{broker.brokerage_name}</p>
              {broker.full_name && (
                <p className="text-[10px] text-ink-2 truncate print:text-slate-700">{broker.full_name}</p>
              )}
            </div>
          ) : (
            <>
              <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-olive to-olive-2 flex items-center justify-center">
                <Layers size={12} className="text-white" />
              </div>
              <span className="font-bold text-sm">landstack<span className="text-olive-2">.ai</span></span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <p className="text-xs text-ink font-bold print:text-black">Comparative Market Analysis</p>
            <p className="text-[10px] text-ink-3 font-mono print:text-slate-700">
              {cma.client_name ? `Prepared for ${cma.client_name} · ` : ''}
              {(cma as any).created_at ? new Date((cma as any).created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : ''}
            </p>
          </div>
          {/* Print / Save PDF — hidden when printing */}
          <button
            onClick={() => window.print()}
            title="Print or Save as PDF"
            className="print:hidden p-2 rounded-lg text-ink-2 hover:text-ink hover:bg-cream-2 border border-beige hover:border-beige-2 transition-colors"
          >
            <Printer size={14} />
          </button>
        </div>
      </div>

      {/* Split layout */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden print:report-stack">
        {/* Map - left on desktop, top on mobile. Hidden in print (interactive).
            Taller on mobile so the map feels primary, not an afterthought. */}
        <div className="h-72 md:h-auto md:flex-1 relative min-h-0 print:hide">
          <div ref={mapContainer} className="absolute inset-0 w-full h-full" />
        </div>

        {/* Report - right on desktop, bottom on mobile.
            Restructured as a top-down presentation:
              Section 1: The Verdict (sticky hero)
              Section 2: The Range (visual bar)
              Section 3: The Evidence (sortable comp cards + map sync)
              Section 4: Broker's Read (editorial)
              Section 5: Fine Print (methodology + disclosure + footer) */}
        <div className="w-full md:w-[28rem] bg-white border-l border-beige flex flex-col overflow-y-auto print:full-width">
          {(() => {
            // === Shared computation (used across sections) ===
            const subjAcres = Number(cma.subject_acres) || 0;
            const adjMap: Record<string, { improvement_value?: number | null; improvement_source?: 'appraiser' | 'agent_verified' | 'broker_estimate' | null; broker_note?: string | null }> = (cma as any).comp_adjustments || {};

            const allInPpa = (c: Comp): number => {
              const acres = Number(c.acres) || 0;
              if (acres <= 0) return 0;
              const total = Number(c.sale_price) || 0;
              return total > 0 ? total / acres : (c.price_per_acre || 0);
            };
            const landOnlyPpa = (c: Comp): number | null => {
              const acres = Number(c.acres) || 0;
              if (acres <= 0) return null;
              const total = Number(c.sale_price) || 0;
              if (total <= 0) return null;
              const adj = adjMap[c.id] || {};
              const imp =
                adj.improvement_value != null
                  ? Number(adj.improvement_value)
                  : (c as any).improvement_value != null
                  ? Number((c as any).improvement_value)
                  : null;
              const adjusted = total - (imp ?? 0);
              return adjusted > 0 ? adjusted / acres : null;
            };

            const allIn = comps.map(allInPpa).filter(v => v > 0);
            const landOnly = comps.map(c => landOnlyPpa(c)).filter((v): v is number => v != null && v > 0);
            const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
            const aLow = allIn.length ? Math.min(...allIn) : 0;
            const aMid = avg(allIn);
            const aHigh = allIn.length ? Math.max(...allIn) : 0;
            const lLow = landOnly.length ? Math.min(...landOnly) : 0;
            const lMid = avg(landOnly);
            const lHigh = landOnly.length ? Math.max(...landOnly) : 0;

            const hasAnyAdjustedComp = comps.some((c) => {
              const adj = adjMap[c.id] || {};
              return (adj.improvement_value != null) || ((c as any).improvement_value != null);
            });
            const brokerOpinion = (cma as any).broker_opinion_value;
            const usingBrokerOpinion = brokerOpinion != null && Number(brokerOpinion) > 0;
            const usingLandOnly = hasAnyAdjustedComp && landOnly.length > 0;

            // Active range = land-only when adjustments exist, else all-in.
            const rngLow = usingLandOnly ? lLow : aLow;
            const rngMid = usingLandOnly ? lMid : aMid;
            const rngHigh = usingLandOnly ? lHigh : aHigh;

            const computedPpa = usingLandOnly ? lMid : aMid;
            const suggestedValue = usingBrokerOpinion
              ? Number(brokerOpinion)
              : computedPpa * subjAcres;
            const suggestedPpa = subjAcres > 0 ? suggestedValue / subjAcres : computedPpa;

            // Marker position on the range bar (0–100%).
            const markerPct =
              rngHigh > rngLow
                ? Math.max(0, Math.min(100, ((suggestedPpa - rngLow) / (rngHigh - rngLow)) * 100))
                : 50;

            // === Sorted comps for Section 3 ===
            const subjLat = (cma as any).subject_latitude;
            const subjLng = (cma as any).subject_longitude;
            const haversineMi = (lat1: number, lng1: number, lat2: number, lng2: number) => {
              const R = 3958.8;
              const toRad = (x: number) => (x * Math.PI) / 180;
              const dLat = toRad(lat2 - lat1);
              const dLng = toRad(lng2 - lng1);
              const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
              return 2 * R * Math.asin(Math.sqrt(a));
            };
            const distFor = (c: Comp): number | null => {
              if (subjLat == null || subjLng == null || c.latitude == null || c.longitude == null) return null;
              return haversineMi(subjLat, subjLng, c.latitude, c.longitude);
            };
            const sortedComps = [...comps].sort((a, b) => {
              if (sortBy === 'ppa') return (allInPpa(b) || 0) - (allInPpa(a) || 0);
              if (sortBy === 'recent') {
                const da = (a as any).sale_date ? new Date((a as any).sale_date).getTime() : 0;
                const db = (b as any).sale_date ? new Date((b as any).sale_date).getTime() : 0;
                return db - da;
              }
              if (sortBy === 'closest') {
                const da = distFor(a) ?? Infinity;
                const db = distFor(b) ?? Infinity;
                return da - db;
              }
              return 0;
            });

            const anyBrokerEstimate = comps.some((c) => {
              const adj = adjMap[c.id] || {};
              const src = adj.improvement_source ?? (c as any).improvement_source ?? null;
              return src === 'broker_estimate';
            });

            return (
              <>
                {/* ============ SECTION 1 — YOUR PROPERTY (mirrors broker SUBJECT card) ============ */}
                <div className="p-4 border-b border-beige">
                  <div className="bg-yellow-400/10 border border-yellow-400/30 rounded-xl p-3 space-y-1">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-yellow-400 ring-2 ring-yellow-400/40" />
                      <p className="text-[10px] font-bold text-yellow-700 uppercase tracking-wider">Your Property</p>
                    </div>
                    <p className="text-sm font-bold text-ink">{cma.subject_name}</p>
                    <p className="text-xs text-ink-2 font-mono flex items-center gap-1">
                      <MapPin size={10} className="text-ink-3" />
                      {cma.subject_county}, {cma.subject_state} · {formatAcres(subjAcres)}
                    </p>
                  </div>
                </div>

                {/* ============ SECTION 2 — TOTAL PRICE PER ACRE (mirrors broker All-In) ============ */}
                {allIn.length > 0 && (
                  <div className="px-4 pb-4 space-y-2">
                    <div className="bg-cream border border-beige rounded-xl overflow-hidden">
                      <div className="px-3 py-2 border-b border-beige bg-cream-2 flex items-center justify-between">
                        <p className="text-[10px] font-bold text-ink-2 uppercase tracking-wider">Average Total Price Per Acre</p>
                        <p className="text-[9px] text-ink-3 font-mono">{allIn.length} of {comps.length} comps</p>
                      </div>
                      <table className="w-full text-xs">
                        <tbody className="font-mono">
                          <tr>
                            <td className="px-3 py-1.5 text-ink-2">Low</td>
                            <td className="text-right px-3 py-1.5 text-ink">{formatPPA(aLow)}</td>
                            <td className="text-right px-3 py-1.5 text-ink">{formatCurrency(aLow * subjAcres)}</td>
                          </tr>
                          <tr className="bg-olive-tint border-t border-beige">
                            <td className="px-3 py-2 text-olive-2 font-bold">Mid</td>
                            <td className="text-right px-3 py-2 text-olive-2 font-bold">{formatPPA(aMid)}</td>
                            <td className="text-right px-3 py-2 text-olive-2 font-bold">{formatCurrency(aMid * subjAcres)}</td>
                          </tr>
                          <tr className="border-t border-beige">
                            <td className="px-3 py-1.5 text-ink-2">High</td>
                            <td className="text-right px-3 py-1.5 text-ink">{formatPPA(aHigh)}</td>
                            <td className="text-right px-3 py-1.5 text-ink">{formatCurrency(aHigh * subjAcres)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[10px] text-ink-3 leading-relaxed px-1">
                      Average sale price per acre across the comparable sales below.
                    </p>
                  </div>
                )}

                {/* ============ SECTION 3 — ADJUSTED PRICE PER ACRE (LAND ONLY) ============ */}
                {landOnly.length > 0 && hasAnyAdjustedComp && (
                  <div className="px-4 pb-4 space-y-2">
                    <div className="bg-cream border border-amber-400/30 rounded-xl overflow-hidden">
                      <div className="px-3 py-2 border-b border-amber-400/20 bg-amber-50 flex items-center justify-between">
                        <p className="text-[10px] font-bold text-amber-700 uppercase tracking-wider">Average Adjusted Price Per Acre (Land Only)</p>
                        <p className="text-[9px] text-ink-2 font-mono">{landOnly.length} of {comps.length} comps</p>
                      </div>
                      <table className="w-full text-xs">
                        <tbody className="font-mono">
                          <tr>
                            <td className="px-3 py-1.5 text-ink-2">Low</td>
                            <td className="text-right px-3 py-1.5 text-ink">{formatPPA(lLow)}</td>
                            <td className="text-right px-3 py-1.5 text-ink">{formatCurrency(lLow * subjAcres)}</td>
                          </tr>
                          <tr className="bg-amber-50 border-t border-amber-400/15">
                            <td className="px-3 py-2 text-amber-700 font-bold">Mid</td>
                            <td className="text-right px-3 py-2 text-amber-700 font-bold">{formatPPA(lMid)}</td>
                            <td className="text-right px-3 py-2 text-amber-700 font-bold">{formatCurrency(lMid * subjAcres)}</td>
                          </tr>
                          <tr className="border-t border-amber-400/15">
                            <td className="px-3 py-1.5 text-ink-2">High</td>
                            <td className="text-right px-3 py-1.5 text-ink">{formatPPA(lHigh)}</td>
                            <td className="text-right px-3 py-1.5 text-ink">{formatCurrency(lHigh * subjAcres)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[10px] text-ink-3 leading-relaxed px-1">
                      $/acre with structures (houses, barns) subtracted — a fairer comparison for raw land.
                    </p>
                  </div>
                )}

                {/* ============ SECTION 4 — BROKER'S RECOMMENDED VALUE (the headline) ============ */}
                {suggestedValue > 0 && (
                  <div className="mx-4 mb-4 p-4 rounded-2xl bg-gradient-to-br from-olive/15 via-olive/5 to-transparent border border-olive-border">
                    <p className="text-[10px] font-bold text-olive-2 uppercase tracking-[0.18em] mb-2">
                      {usingBrokerOpinion ? "Broker's Opinion of Value" : 'Recommended Value'}
                    </p>
                    <p className="text-3xl font-bold text-ink font-mono leading-none">
                      {formatCurrency(suggestedValue)}
                    </p>
                    <p className="text-[11px] text-ink-2 font-mono mt-1.5">
                      {formatPPA(suggestedPpa)} × {formatAcres(subjAcres)}
                    </p>

                    {/* Range bar */}
                    {rngHigh > rngLow && (
                      <div className="mt-4">
                        <div className="relative mb-2">
                          <div className="h-1.5 rounded-full bg-cream border border-beige overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-beige-2 via-olive/40 to-beige-2" />
                          </div>
                          <div
                            className="absolute -top-1.5 w-4 h-4 rounded-full bg-olive border-2 border-white shadow-lg shadow-olive/40 -translate-x-1/2"
                            style={{ left: `${markerPct}%` }}
                            title={`Recommended ${formatPPA(suggestedPpa)}`}
                          />
                        </div>
                        <div className="flex justify-between text-[9px] font-mono">
                          <div>
                            <p className="text-ink-3 uppercase tracking-wider">Low</p>
                            <p className="text-ink-2">{formatCurrency(rngLow * subjAcres)}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-ink-3 uppercase tracking-wider">High</p>
                            <p className="text-ink-2">{formatCurrency(rngHigh * subjAcres)}</p>
                          </div>
                        </div>
                      </div>
                    )}

                    <p className="text-[11px] text-ink-2 leading-relaxed mt-4">
                      {usingBrokerOpinion
                        ? `Broker's professional opinion of value, supported by the ${comps.length} comparable ${comps.length === 1 ? 'sale' : 'sales'} below.`
                        : usingLandOnly
                        ? `Based on the land-only average across ${landOnly.length} of ${comps.length} comparable sales.`
                        : `Based on the average across ${allIn.length} comparable ${allIn.length === 1 ? 'sale' : 'sales'}.`}
                    </p>
                  </div>
                )}

                {/* ============ SECTION 5 — COMPARABLE SALES (mirrors broker comp list) ============ */}
                <div className="flex-1 px-4 pb-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[10px] font-bold text-ink-2 uppercase tracking-wider">
                      Comparable Sales <span className="text-ink-3">({comps.length})</span>
                    </p>
                    <div className="relative">
                      <ArrowUpDown size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                        className="appearance-none bg-cream border border-beige rounded-lg pl-6 pr-6 py-1 text-[10px] font-bold text-ink-2 cursor-pointer hover:border-blue-400/40 transition-colors"
                      >
                        <option value="default">Most relevant</option>
                        <option value="closest">Closest</option>
                        <option value="recent">Most recent</option>
                        <option value="ppa">Highest Total $/Ac</option>
                      </select>
                      <ChevronDown size={10} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
                    </div>
                  </div>

                  <div className="space-y-2">
                    {sortedComps.map((comp) => {
                      const adj = adjMap[comp.id] || {};
                      const effSrc: 'appraiser' | 'agent_verified' | 'broker_estimate' | null =
                        adj.improvement_source ?? (comp as any).improvement_source ?? null;
                      const isBrokerEstimated = effSrc === 'broker_estimate';
                      // ADJ badge: this CMA has an improvement-value adjustment for this comp
                      // (mirrors the broker workspace's amber ADJ tag).
                      const isAdjusted = adj.improvement_value != null;
                      const isHovered = hoveredCompId === comp.id;
                      const allIn = allInPpa(comp);
                      const land = landOnlyPpa(comp);
                      const dist = distFor(comp);
                      const myReaction = reactions[comp.id];
                      return (
                        <div
                          key={comp.id}
                          onMouseEnter={() => setHoveredCompId(comp.id)}
                          onMouseLeave={() => setHoveredCompId((prev) => (prev === comp.id ? null : prev))}
                          onClick={() => {
                            setSelectedComp(comp);
                            if (comp.latitude && comp.longitude && map.current) {
                              map.current.flyTo({ center: [comp.longitude, comp.latitude], zoom: 12 });
                            }
                            // Auto-expand on card click. Chevron remains the
                            // explicit collapse handle, so clicking the card
                            // again is a no-op (doesn't surprise-collapse).
                            setExpandedCompIds((prev) => {
                              if (prev.has(comp.id)) return prev;
                              const next = new Set(prev);
                              next.add(comp.id);
                              return next;
                            });
                          }}
                          className={`bg-cream border rounded-xl overflow-hidden transition-colors cursor-pointer ${
                            isHovered
                              ? 'border-blue-400 ring-2 ring-blue-400/30'
                              : selectedComp?.id === comp.id
                              ? 'border-blue-400'
                              : 'border-beige'
                          }`}
                        >
                          <div className="px-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-bold text-ink truncate flex-1 flex items-center gap-1.5">
                                <span className="truncate">{comp.property_name || `${comp.county} County`}</span>
                                {(comp as any).has_improvements && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 bg-purple-400/10 text-purple-600 rounded flex-shrink-0">
                                    IMPROVED
                                  </span>
                                )}
                                {(comp as any).irrigation === 'Strong' && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 bg-purple-400/10 text-purple-600 rounded flex-shrink-0">
                                    IRRIGATION
                                  </span>
                                )}
                                {isAdjusted && (
                                  <span className="text-[9px] text-amber-600 font-mono flex-shrink-0">ADJ</span>
                                )}
                                {effSrc === 'agent_verified' && (
                                  <span
                                    className="text-[9px] font-bold px-1.5 py-0.5 bg-olive-tint border border-olive-border text-olive-2 rounded flex-shrink-0"
                                    title="An agent involved in this transaction verified the improvement value."
                                  >
                                    Agent-Verified
                                  </span>
                                )}
                                {isBrokerEstimated && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-50 border border-amber-400/30 text-amber-700 font-bold flex-shrink-0">
                                    Broker-est
                                  </span>
                                )}
                              </p>
                              <div className="flex items-center gap-2 flex-shrink-0">
                                {dist != null && (
                                  <p className="text-[10px] text-ink-3 font-mono">{dist.toFixed(1)} mi</p>
                                )}
                                <button
                                  onClick={(e) => { e.stopPropagation(); toggleExpanded(comp.id); }}
                                  className="p-0.5 rounded text-ink-3 hover:text-ink hover:bg-cream-2 transition-colors"
                                  title={expandedCompIds.has(comp.id) ? 'Hide details' : 'Show details'}
                                >
                                  <ChevronDown
                                    size={14}
                                    className={`transition-transform ${expandedCompIds.has(comp.id) ? 'rotate-180' : ''}`}
                                  />
                                </button>
                              </div>
                            </div>
                            {/* 4-column grid (matches CMA workspace) */}
                            <div className="grid grid-cols-4 gap-2 mt-2 text-[10px] font-mono">
                              <div>
                                <p className="text-ink-3 text-[9px] uppercase">Acres</p>
                                <p className="text-ink font-bold">{formatAcres(comp.acres)}</p>
                              </div>
                              <div>
                                <p className="text-ink-3 text-[9px] uppercase">Total</p>
                                <p className="text-ink font-bold">{formatCurrency(comp.sale_price)}</p>
                              </div>
                              <div>
                                <p className="text-ink-3 text-[9px] uppercase">Total $/Ac</p>
                                <p className="text-olive font-bold">{allIn > 0 ? formatPPA(allIn) : '—'}</p>
                              </div>
                              <div>
                                <p className="text-ink-3 text-[9px] uppercase">Adjusted $/Ac</p>
                                <p className={`font-bold ${land != null ? 'text-amber-700' : 'text-ink-3'}`}>
                                  {land != null ? formatPPA(land) : '—'}
                                </p>
                              </div>
                            </div>
                          </div>

                          {/* Expanded details — broker note → key facts → description → photos → fly-to.
                              Order matches the broker's CMA workspace expanded view, with the
                              per-comp note pulled to the top so the client reads it first. */}
                          {expandedCompIds.has(comp.id) && (
                            <div className="border-t border-beige bg-cream-2 px-3 py-2.5 space-y-1.5 text-[11px]">
                              {/* Per-comp broker note (if set). Quoted, blue-accented to mirror
                                  the overall Broker's Analysis section. */}
                              {adj.broker_note && adj.broker_note.trim().length > 0 && (
                                <div className="pb-2 border-b border-beige/60">
                                  <p className="text-[10px] font-bold text-blue-700 uppercase tracking-wider mb-1">
                                    Broker's Note
                                  </p>
                                  <p className="text-[12px] text-ink leading-relaxed italic border-l-2 border-blue-400/40 pl-3 whitespace-pre-wrap">
                                    {adj.broker_note}
                                  </p>
                                </div>
                              )}
                              {/* Key facts — Sale date · Address · Improvements (+notes).
                                  Same order as broker workspace + standalone Comp Detail. */}
                              {(comp as any).sale_date && (
                                <div className="flex justify-between">
                                  <span className="text-ink-3">Sale date</span>
                                  <span className="text-ink-2 font-mono">{(comp as any).sale_date}</span>
                                </div>
                              )}
                              {(comp as any).address && (
                                <div className="flex justify-between gap-2">
                                  <span className="text-ink-3 flex-shrink-0">Address</span>
                                  <span className="text-ink-2 text-right truncate">{(comp as any).address}</span>
                                </div>
                              )}
                              {(comp as any).has_improvements && (comp as any).improvements_value != null && (
                                <div className="flex justify-between">
                                  <span className="text-ink-3">Improvements</span>
                                  <span className="text-blue-700">{formatCurrency((comp as any).improvements_value)} ECV</span>
                                </div>
                              )}
                              {(comp as any).improvements_notes && (
                                <div className="pt-1">
                                  <p className="text-ink-3 mb-0.5">Improvements notes</p>
                                  <p className="text-ink-2 leading-relaxed">{(comp as any).improvements_notes}</p>
                                </div>
                              )}

                              {/* Land-character chips — below key facts so the
                                  order reads facts → character → narrative
                                  across every comp surface. */}
                              {(() => {
                                const irrigationVal = (comp as any).irrigation as string | null;
                                return (
                                  <div className="grid grid-cols-2 gap-2 pt-1">
                                    <FeatureChip
                                      label="Water"
                                      value={(comp as any).water}
                                      strong={isStrongFeature('water', (comp as any).water)}
                                    />
                                    <FeatureChip
                                      label="Road"
                                      value={(comp as any).road_frontage}
                                      strong={isStrongFeature('road', (comp as any).road_frontage)}
                                    />
                                    <FeatureChip
                                      label="Dev"
                                      value={(comp as any).dev_potential}
                                      strong={isStrongFeature('dev', (comp as any).dev_potential)}
                                    />
                                    <FeatureChip
                                      label="Irrigation"
                                      value={irrigationVal}
                                      strong={isStrongFeature('irrigation', irrigationVal)}
                                    />
                                  </div>
                                );
                              })()}

                              {/* Description with sentence-aware Read more (mirrors broker) */}
                              {(comp as any).description && (() => {
                                const desc: string = (comp as any).description;
                                const sentences = desc
                                  .split(/(?<=[.!?])\s+(?=[A-Z])/)
                                  .map((s: string) => s.trim())
                                  .filter(Boolean);
                                const previewLen = 220;
                                const isExpanded = expandedDescriptionIds.has(comp.id);
                                const previewBySentences = sentences.slice(0, 3).join(' ');
                                const preview =
                                  previewBySentences.length > 0 && previewBySentences.length < desc.length - 10
                                    ? previewBySentences
                                    : desc.length > previewLen
                                    ? desc.slice(0, previewLen) + '…'
                                    : desc;
                                const hasMore = preview !== desc && desc.length > preview.length;
                                return (
                                  <div className="pt-1.5 border-t border-beige/60">
                                    <p className="text-[10px] font-bold text-ink-3 uppercase tracking-wider mb-1">Description</p>
                                    <p className="text-[11px] text-ink-2 leading-relaxed whitespace-pre-wrap">
                                      {isExpanded ? desc : preview}
                                    </p>
                                    {hasMore && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleDescription(comp.id);
                                        }}
                                        className="mt-1 flex items-center gap-1 text-[10px] font-bold text-olive-2 hover:text-olive transition-colors"
                                      >
                                        {isExpanded ? 'Show less' : 'Read more'}
                                      </button>
                                    )}
                                  </div>
                                );
                              })()}

                              {/* === Listing & Photos — prominent block, the client's primary engagement === */}
                              {(() => {
                                const links: any[] = (comp as any).source_links || [];
                                const single = (comp as any).source_url;
                                const all =
                                  links.length > 0
                                    ? links
                                    : single
                                    ? [{ url: single }]
                                    : [];
                                if (all.length === 0) return null;

                                // Detect listing-source brand from URL so the badge is meaningful to the client.
                                const detectSource = (url: string): { name: string; cta: string } => {
                                  if (/zillow\.com/i.test(url)) return { name: 'Zillow', cta: 'View on Zillow' };
                                  if (/realtor\.com/i.test(url)) return { name: 'Realtor.com', cta: 'View on Realtor.com' };
                                  if (/landsofamerica\.com|landsconnector/i.test(url)) return { name: 'Lands of America', cta: 'View on Lands of America' };
                                  if (/landwatch\.com/i.test(url)) return { name: 'LandWatch', cta: 'View on LandWatch' };
                                  if (/land\.com/i.test(url)) return { name: 'Land.com', cta: 'View on Land.com' };
                                  if (/redfin\.com/i.test(url)) return { name: 'Redfin', cta: 'View on Redfin' };
                                  return { name: 'Listing', cta: 'View Listing' };
                                };

                                // Thumbnail strategy: stored thumbnail_url first, otherwise
                                // mShots — a free, no-API-key page-screenshot service.
                                const thumbFor = (lnk: any): string => {
                                  if (lnk.thumbnail_url) return lnk.thumbnail_url;
                                  return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(lnk.url)}?w=320&h=200`;
                                };

                                return (
                                  <div className="pt-2 border-t border-beige/60 space-y-2">
                                    <p className="text-[10px] font-bold text-blue-700 uppercase tracking-wider">
                                      Listing & Photos
                                    </p>
                                    {all.map((lnk: any, i: number) => {
                                      const src = detectSource(lnk.url);
                                      return (
                                        <a
                                          key={lnk.id || i}
                                          href={lnk.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          onClick={(e) => e.stopPropagation()}
                                          className="block rounded-lg bg-cream hover:bg-cream-2 border border-beige hover:border-blue-400/50 transition-colors group overflow-hidden"
                                        >
                                          <div className="flex items-stretch gap-3">
                                            {/* Bigger thumbnail — 96×72 so photos are visible */}
                                            <div className="w-24 h-[72px] flex-shrink-0 bg-cream-2 relative overflow-hidden">
                                              <img
                                                src={thumbFor(lnk)}
                                                alt=""
                                                loading="lazy"
                                                referrerPolicy="no-referrer"
                                                onError={(e) => {
                                                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                                                }}
                                                className="w-full h-full object-cover"
                                              />
                                            </div>
                                            <div className="flex-1 min-w-0 py-2 pr-3 flex flex-col justify-center">
                                              <div className="flex items-center gap-1.5 mb-1">
                                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-400/10 text-blue-700 border border-blue-400/20 font-bold uppercase tracking-wider flex-shrink-0">
                                                  {src.name}
                                                </span>
                                                {lnk.broker_verified && (
                                                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-olive-tint text-olive-2 border border-olive-border font-bold flex-shrink-0">
                                                    ✓ Verified
                                                  </span>
                                                )}
                                              </div>
                                              <p className="text-[12px] text-ink group-hover:text-ink font-bold flex items-center gap-1.5">
                                                {src.cta}
                                                <ExternalLink size={11} className="text-ink-3 group-hover:text-slate-blue-2 flex-shrink-0" />
                                              </p>
                                              <p className="text-[10px] text-ink-3 mt-0.5 truncate">
                                                {lnk.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}
                                                {lnk.url.length > 50 ? '…' : ''}
                                              </p>
                                            </div>
                                          </div>
                                        </a>
                                      );
                                    })}
                                  </div>
                                );
                              })()}

                              {/* Fly-to button — mirrors broker workspace */}
                              {comp.latitude != null && comp.longitude != null && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    map.current?.flyTo({ center: [comp.longitude!, comp.latitude!], zoom: 14, duration: 800 });
                                  }}
                                  className="text-[10px] text-slate-blue-2 hover:text-slate-blue-2 font-bold pt-1"
                                >
                                  View on map →
                                </button>
                              )}
                            </div>
                          )}

                          {/* Compact icon-only reactions */}
                          <div className="flex items-center gap-1 px-3 py-1.5 border-t border-beige bg-cream-2">
                            <span className="text-[9px] text-ink-3 uppercase tracking-wider mr-auto">Your take</span>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleReaction(comp.id, 'relevant'); }}
                              title="Relevant"
                              className={`p-1.5 rounded-md transition-colors ${
                                myReaction === 'relevant'
                                  ? 'bg-olive-tint text-olive-2'
                                  : 'text-ink-3 hover:text-olive-2 hover:bg-olive-tint'
                              }`}
                            >
                              <ThumbsUp size={12} />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleReaction(comp.id, 'question'); }}
                              title="I have a question"
                              className={`p-1.5 rounded-md transition-colors ${
                                myReaction === 'question'
                                  ? 'bg-amber-50 text-amber-700'
                                  : 'text-ink-3 hover:text-amber-700 hover:bg-amber-50'
                              }`}
                            >
                              <HelpCircle size={12} />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleReaction(comp.id, 'not_comparable'); }}
                              title="Not comparable"
                              className={`p-1.5 rounded-md transition-colors ${
                                myReaction === 'not_comparable'
                                  ? 'bg-red-400/20 text-red-600'
                                  : 'text-ink-3 hover:text-red-600 hover:bg-red-400/10'
                              }`}
                            >
                              <ThumbsDown size={12} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ============ SECTION 6 — BROKER'S ANALYSIS ============ */}
                {cma.broker_notes && (
                  <div className="px-5 py-5 border-t border-beige bg-cream/30">
                    <p className="text-[9px] font-bold text-blue-700 uppercase tracking-[0.18em] mb-3">
                      Broker's Analysis
                    </p>
                    <p className="text-sm text-ink leading-relaxed italic border-l-2 border-blue-400/40 pl-4">
                      {cma.broker_notes}
                    </p>
                  </div>
                )}

                {/* ============ REPLY TO BROKER CTA ============ */}
                {/* Doesn't expose the broker's email — feedback POSTs to a server
                    endpoint that stores the message; broker reads it in their
                    dashboard. Hidden in print (no point on paper). */}
                <div className="px-5 py-5 border-t border-beige print:hide">
                  <button
                    onClick={() => {
                      setFeedbackOpen(true);
                      setFeedbackSent(false);
                    }}
                    className="w-full py-3 bg-olive-tint hover:bg-olive-tint border border-olive-border hover:border-olive rounded-xl text-olive-2 font-bold text-sm transition-colors flex items-center justify-center gap-2"
                  >
                    <MessageCircle size={14} />
                    Have questions? Reply to {broker?.full_name || 'your broker'}
                  </button>
                </div>

                {/* ============ SECTION 7 — FINE PRINT ============ */}
                <div className="px-4 py-4 border-t border-beige space-y-3">
                  {/* Methodology (collapsible) */}
                  <button
                    onClick={() => setShowMethodology((v) => !v)}
                    className="flex items-center justify-between w-full text-left text-[10px] font-bold text-ink-2 uppercase tracking-wider hover:text-ink transition-colors"
                  >
                    <span>How this value was calculated</span>
                    <ChevronDown size={12} className={`transition-transform ${showMethodology ? 'rotate-180' : ''}`} />
                  </button>
                  {showMethodology && (
                    <div className="text-[11px] text-ink-2 leading-relaxed space-y-2 pl-1">
                      <p>
                        We collect recent comparable sales near the subject property. For each, we calculate
                        <span className="text-olive font-bold"> all-in $/acre</span> (sale price ÷ acres).
                      </p>
                      {usingLandOnly && (
                        <p>
                          When a comp has improvements (a house, barn, etc.), we subtract the improvement value
                          to get a <span className="text-amber-700 font-bold">land-only $/acre</span> — a fairer
                          comparison for raw land.
                        </p>
                      )}
                      <p>
                        {usingBrokerOpinion
                          ? `The recommended value reflects the broker's professional opinion, supported by the comparable sales above.`
                          : usingLandOnly
                          ? `The recommended value uses the land-only average across ${landOnly.length} of ${comps.length} comparable sales.`
                          : `The recommended value uses the all-in average across ${allIn.length} of ${comps.length} comparable sales.`}
                      </p>
                    </div>
                  )}

                  {/* Disclosure */}
                  {anyBrokerEstimate && (
                    <div className="border border-amber-400/20 bg-amber-50 rounded-lg p-3">
                      <p className="text-[10px] text-amber-700 leading-relaxed">
                        <span className="font-bold uppercase tracking-wider mr-1">Disclosure:</span>
                        Improvement deductions marked <span className="font-bold">Broker-est</span> are
                        based on broker judgment and have not been verified by a licensed appraiser.
                        Land-only values are for comparative purposes only.
                      </p>
                    </div>
                  )}

                  {/* Footer */}
                  <p className="text-[10px] text-center text-ink-3 pt-2">
                    Powered by <span className="text-olive-2 font-bold">landstack.ai</span>
                  </p>
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* Reply-to-broker feedback modal. POSTs to /api/share/[token]/feedback,
          which inserts into share_feedback. Email integration is intentionally
          deferred — for now the broker sees messages in their dashboard. */}
      {feedbackOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4 print:hidden">
          <div className="w-full max-w-md bg-white border border-beige rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-beige flex items-center justify-between">
              <div>
                <p className="font-bold text-ink text-sm">
                  {feedbackSent ? 'Message sent' : `Reply to ${broker?.full_name || 'your broker'}`}
                </p>
                {!feedbackSent && (
                  <p className="text-[11px] text-ink-3 mt-0.5">Your broker will see this in their dashboard.</p>
                )}
              </div>
              <button
                onClick={() => setFeedbackOpen(false)}
                className="text-ink-3 hover:text-ink"
              >
                <X size={16} />
              </button>
            </div>
            {feedbackSent ? (
              <div className="px-5 py-6 text-center space-y-2">
                <div className="text-3xl">✓</div>
                <p className="text-sm text-ink-2">Thanks — your broker has been notified.</p>
                <button
                  onClick={() => setFeedbackOpen(false)}
                  className="mt-3 px-4 py-2 bg-olive-tint hover:bg-olive-tint border border-olive-border rounded-lg text-sm font-bold text-olive-2"
                >
                  Close
                </button>
              </div>
            ) : (
              <div className="px-5 py-4 space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-[10px] font-bold text-ink-3 uppercase tracking-wider mb-1">Your name</p>
                    <input
                      type="text"
                      value={feedbackName}
                      onChange={(e) => setFeedbackName(e.target.value)}
                      placeholder="Optional"
                      className="w-full bg-cream border border-beige focus:border-olive rounded-lg px-3 py-2 text-sm text-ink outline-none"
                    />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-ink-3 uppercase tracking-wider mb-1">Your email</p>
                    <input
                      type="email"
                      value={feedbackEmail}
                      onChange={(e) => setFeedbackEmail(e.target.value)}
                      placeholder="So broker can reply"
                      className="w-full bg-cream border border-beige focus:border-olive rounded-lg px-3 py-2 text-sm text-ink outline-none"
                    />
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-bold text-ink-3 uppercase tracking-wider mb-1">Message</p>
                  <textarea
                    value={feedbackMessage}
                    onChange={(e) => setFeedbackMessage(e.target.value)}
                    rows={5}
                    placeholder="What would you like to ask your broker about this report?"
                    className="w-full bg-cream border border-beige focus:border-olive rounded-lg px-3 py-2 text-sm text-ink outline-none resize-none"
                  />
                </div>
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    onClick={() => setFeedbackOpen(false)}
                    className="px-4 py-2 text-xs font-bold text-ink-2 hover:text-ink transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={feedbackSending || feedbackMessage.trim().length === 0}
                    onClick={async () => {
                      setFeedbackSending(true);
                      try {
                        const res = await fetch(`/api/share/${params.token}/feedback`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            client_name: feedbackName.trim() || null,
                            client_email: feedbackEmail.trim() || null,
                            message: feedbackMessage.trim(),
                          }),
                        });
                        if (!res.ok) {
                          const data = await res.json().catch(() => ({}));
                          throw new Error(data.error || 'Failed to send');
                        }
                        setFeedbackSent(true);
                        setFeedbackName('');
                        setFeedbackEmail('');
                        setFeedbackMessage('');
                      } catch (e: any) {
                        alert(e?.message || 'Failed to send. Please try again.');
                      } finally {
                        setFeedbackSending(false);
                      }
                    }}
                    className="px-4 py-2 bg-olive hover:bg-olive-2 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold transition-colors"
                  >
                    {feedbackSending ? 'Sending…' : 'Send to broker'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

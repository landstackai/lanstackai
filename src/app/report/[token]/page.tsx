'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { CMA, Comp } from '@/types';
import { formatPPA, formatAcres, formatCurrency, formatDate } from '@/lib/utils';
import { computeCmaAverages, subjectTotals } from '@/lib/utils/cmaMath';
import { properCase } from '@/lib/utils/properCase';
import { MapPin, ThumbsUp, ThumbsDown, HelpCircle, Layers, ArrowUpDown, ChevronDown, ExternalLink, Printer, MessageCircle, X, Download, Loader2 } from 'lucide-react';
import { FeatureChip, isStrongFeature } from '@/components/comp/FeatureChip';
import mapboxgl from 'mapbox-gl';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

// Brand palette — kept in sync with the broker map (src/app/dashboard/map/page.tsx)
// so a client opening the share report sees the same pin visual language they
// would on the live map. Status color rings let the client distinguish Sold /
// Active / Pending at a glance, same as the broker's view.
const STATUS_COLORS: Record<string, string> = {
  Sold: '#A8B57A',      // olive-light — primary "land transaction" color
  Active: '#7B9FCE',    // slate-blue-light — on-market listings
  Pending: '#E8B872',   // amber-warm — under contract
  Withdrawn: '#75716A', // cream-3-text — muted "off-market"
};

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

  // Sorted-order lookup so map pin numbers stay in lockstep with the panel's
  // comp cards. Both surfaces show "#1 = first card in current sort" — click
  // sort dropdown and both re-number together. The panel still sorts its own
  // list inside the render (existing logic at ~line 691); this memo only
  // exists so the map-init effect can look up each pin's number without
  // duplicating the sort logic.
  const compOrder = useMemo(() => {
    if (!comps.length) return new Map<string, number>();
    const subjLat = (cma as any)?.subject_latitude;
    const subjLng = (cma as any)?.subject_longitude;
    const dist = (c: Comp): number => {
      if (subjLat == null || subjLng == null || c.latitude == null || c.longitude == null) return Infinity;
      const R = 3958.7613;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(c.latitude - subjLat);
      const dLng = toRad(c.longitude - subjLng);
      const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(subjLat)) * Math.cos(toRad(c.latitude)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };
    const ppa = (c: Comp): number => {
      const total = Number(c.sale_price) || 0;
      const acres = Number(c.acres) || 0;
      return acres > 0 ? total / acres : (c.price_per_acre || 0);
    };
    const sorted = [...comps].sort((a, b) => {
      if (sortBy === 'ppa') return ppa(b) - ppa(a);
      if (sortBy === 'recent') {
        const da = (a as any).sale_date ? new Date((a as any).sale_date).getTime() : 0;
        const db = (b as any).sale_date ? new Date((b as any).sale_date).getTime() : 0;
        return db - da;
      }
      if (sortBy === 'closest') return dist(a) - dist(b);
      return 0;
    });
    return new Map(sorted.map((c, i) => [c.id, i + 1]));
  }, [comps, sortBy, cma]);
  const [showMethodology, setShowMethodology] = useState(false);
  const [expandedCompIds, setExpandedCompIds] = useState<Set<string>>(new Set());
  const [expandedDescriptionIds, setExpandedDescriptionIds] = useState<Set<string>>(new Set());
  // Per-acre detail panel — collapsed by default. Clients see the
  // Suggested List Price + Expected Sale first; the comp $/Ac averages
  // sit one click away for anyone who wants to verify the math. Reduces
  // first-glance noise from ~20 dollar amounts on the panel to ~5.
  const [perAcreDetailOpen, setPerAcreDetailOpen] = useState(false);

  // Marketing PDF download — the client can grab the six-page
  // printable CMA from the share report. Hits the public share PDF
  // route (/api/share/[token]/pdf) which generates the same PDF the
  // broker gets, minus the broker's email/phone (anon profiles RLS
  // only exposes name + brokerage). ~5-15s on serverless cold start,
  // hence the explicit spinner state.
  const [pdfDownloading, setPdfDownloading] = useState(false);

  // Download the marketing PDF. Public share route returns the same
  // six-page CMA the broker gets (minus broker email/phone). Triggers
  // the file save via an anchor element so the browser preserves the
  // server-set filename ("Landstack CMA - <Subject> - <Date>.pdf").
  const downloadMarketingPdf = async () => {
    setPdfDownloading(true);
    try {
      const res = await fetch(`/api/share/${params.token}/pdf`);
      if (!res.ok) {
        let detail = '';
        try {
          const err = await res.json();
          detail = err?.detail || err?.error || '';
        } catch {}
        alert(detail || 'PDF download failed. Please try again.');
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const match = cd.match(/filename="([^"]+)"/);
      const filename = match?.[1] || `Landstack CMA - ${Date.now()}.pdf`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(e?.message || 'PDF download failed. Please try again.');
    } finally {
      setPdfDownloading(false);
    }
  };

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

      // Subject pin — warm brick red, matches the dashboard map's subject
      // marker. Real-estate convention: red = "the one we're evaluating."
      // Subtle pulse halo keyframe defined in globals.css (subjectPulse).
      const subjLat = (cma as any).subject_latitude;
      const subjLng = (cma as any).subject_longitude;
      if (subjLat != null && subjLng != null) {
        const sEl = document.createElement('div');
        sEl.style.cssText = `
          background:#C8503F;
          border:3px solid #F5F1E8;
          border-radius:50%;
          width:20px;height:20px;
          box-shadow:0 0 0 4px rgba(200,80,63,0.35), 0 6px 18px rgba(0,0,0,.5);
          animation:subjectPulse 2.4s ease-in-out infinite;
        `;
        sEl.title = properCase(cma.subject_name) || 'Subject';
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
          map.current.addLayer({ id: 'subj-fill', type: 'fill', source: 'subj-boundary', paint: { 'fill-color': '#C8503F', 'fill-opacity': 0.15 } });
          map.current.addLayer({ id: 'subj-line', type: 'line', source: 'subj-boundary', paint: { 'line-color': '#C8503F', 'line-width': 2.5 } });
        }
      }

      // Comp boundaries — same red-line treatment used on the broker
      // workspace map. Previously missing on the report, so clients saw
      // just floating pins with no property outlines. Now the client sees
      // the actual parcel shape for each comp, matching what the broker
      // sees. Fill + halo + line for depth on satellite backgrounds.
      const compBoundaryFeatures = comps
        .filter((c) => (c as any).boundary_geojson)
        .map((c) => ({
          type: 'Feature' as const,
          properties: { comp_id: c.id },
          geometry: (c as any).boundary_geojson,
        }));
      const existingCompBoundarySrc = map.current.getSource('comp-boundaries');
      const compFC = { type: 'FeatureCollection' as const, features: compBoundaryFeatures };
      if (existingCompBoundarySrc) {
        (existingCompBoundarySrc as mapboxgl.GeoJSONSource).setData(compFC as any);
      } else {
        map.current.addSource('comp-boundaries', { type: 'geojson', data: compFC as any });
        map.current.addLayer({
          id: 'comp-boundary-fill',
          type: 'fill',
          source: 'comp-boundaries',
          paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.14 },
        });
        map.current.addLayer({
          id: 'comp-boundary-halo',
          type: 'line',
          source: 'comp-boundaries',
          paint: { 'line-color': '#ef4444', 'line-width': 5, 'line-opacity': 0.28, 'line-blur': 1.2 },
        });
        map.current.addLayer({
          id: 'comp-boundary-line',
          type: 'line',
          source: 'comp-boundaries',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-opacity': 1 },
        });
      }

      // Comp pins — match the broker map's pin treatment exactly so
      // clients see the same visual language as the live dashboard:
      //   - Warm dark base (#1A1815)
      //   - Cream-1 number text (reads on ANY satellite color, key for
      //     mixed terrain)
      //   - Status-colored ring (Sold = olive, Active = slate-blue,
      //     Pending = amber, Withdrawn = muted gray) so the client can
      //     spot transaction type at a glance, same as the broker can
      //   - Same padding + radius + shadow so two surfaces feel like
      //     one app
      // Label uses Total $/Ac (sale_price / acres) to match the pin
      // label convention on the broker map — Adjusted $/Ac was a known
      // source of inconsistency that PR #27 resolved across surfaces.
      comps.forEach((comp) => {
        if (comp.latitude == null || comp.longitude == null) return;
        const el = document.createElement('div');
        el.dataset.compId = comp.id;
        const statusColor = STATUS_COLORS[(comp as any).status] || '#A8B57A';
        el.dataset.statusColor = statusColor; // read by hover-effect useEffect
        el.style.cssText = `
          background:#1A1815;
          border:1.5px solid ${statusColor};
          border-radius:20px;
          padding:4px 9px;font-family:'DM Mono',monospace;font-size:11px;
          font-weight:700;color:#F5F1E8;white-space:nowrap;cursor:pointer;
          box-shadow:0 2px 10px rgba(0,0,0,.4);
          transition:border-color .15s, box-shadow .15s;
        `;
        // Match the broker map's Total $/Ac label convention (PR #27).
        // Falls back to ppa_land_only only if total isn't populated.
        const totalForLabel = (comp as any).price_per_acre || comp.ppa_land_only || 0;
        const priceLabel = `$${Math.round(totalForLabel / 1000)}k`;

        // Pin number matches the comp's row number in the sortable panel.
        // When client sorts by Closest / Recent / $/Ac, both surfaces
        // re-number together — #3 on map = #3 in panel = same property.
        // compOrder is the useMemo that computes the sort order at
        // component level so this effect and the JSX both agree.
        const compNumber = compOrder.get(comp.id) ?? 0;
        if (compNumber > 0) {
          el.innerHTML = `
            <span style="
              position:absolute; top:-7px; left:-7px;
              min-width:18px; height:18px; padding:0 4px;
              border-radius:9px; background:#A8B57A;
              border:1.5px solid #1A1815; color:#1A1815;
              font-family:'DM Mono',monospace; font-size:10px; font-weight:700;
              display:flex; align-items:center; justify-content:center;
              line-height:1; box-shadow:0 1px 4px rgba(0,0,0,0.4); z-index:2;
            ">${compNumber}</span>
            <span>${priceLabel}</span>
          `;
        } else {
          el.textContent = priceLabel;
        }

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
        // Branded warm dark popup — matches the dashboard map popup.
        // Floats over satellite map with frosted blur for legibility.
        const bluePill = (label: string) =>
          `<span style="font-size:9px;font-weight:600;padding:1px 5px;background:rgba(123,159,206,0.15);color:#7B9FCE;border:1px solid rgba(123,159,206,0.35);border-radius:3px;letter-spacing:0.05em;">${label}</span>`;
        const improvedBadge = isImproved ? bluePill('IMPROVED') : '';
        const irrigationBadge = isStrongIrrigation ? bluePill('IRRIGATION') : '';
        const adjBadge = hasAdjustment
          ? `<span style="font-size:9px;color:#E8B872;font-family:'DM Mono',monospace;font-weight:700;">ADJ</span>`
          : '';
        const agentBadge = isAgentVerified
          ? `<span style="font-size:9px;font-weight:600;padding:1px 5px;background:rgba(123,159,206,0.18);color:#7B9FCE;border:1px solid rgba(123,159,206,0.40);border-radius:3px;letter-spacing:0.05em;">Agent-Verified</span>`
          : '';
        const adjustedColor = hasAdjustment ? '#E8B872' : 'rgba(232,184,114,0.45)';
        const adjustedValue = hasAdjustment ? formatPPA(adjustedPpa) : '—';
        const popupHtml = `
          <div style="padding:10px 12px;font-family:'Syne',sans-serif;">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
              <span style="font-weight:600;font-size:12px;color:#F5F1E8;letter-spacing:-0.01em;">${propertyName}</span>
              ${improvedBadge}
              ${irrigationBadge}
              ${adjBadge}
              ${agentBadge}
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,auto);column-gap:16px;row-gap:2px;font-family:'DM Mono',monospace;font-size:10px;white-space:nowrap;">
              <div style="color:#A8A296;">Acres</div>
              <div style="color:#A8A296;">Total</div>
              <div style="color:#A8A296;">Total $/Ac</div>
              <div style="color:#A8A296;">Adjusted $/Ac</div>
              <div style="color:#F5F1E8;font-weight:700;">${formatAcres(comp.acres)}</div>
              <div style="color:#F5F1E8;font-weight:700;">${formatCurrency(comp.sale_price)}</div>
              <div style="color:#A8B57A;font-weight:700;">${totalPpa > 0 ? formatPPA(totalPpa) : '—'}</div>
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
    // compOrder in deps: when sortBy changes, pins re-render with new
    // numbers so they stay aligned with the panel's row order.
  }, [cma, comps, mapReady, compOrder]);

  // Imperative hover highlight on pins. Mirrors the broker map's
  // treatment exactly so a client viewing the share link sees the same
  // visual language: olive glow on hover, status-colored ring at rest,
  // cream-1 text always. Each pin carries its base status color in
  // dataset.statusColor (set at marker creation) so we don't have to
  // re-resolve from the comp lookup on every hover tick.
  useEffect(() => {
    markerElsRef.current.forEach((el, id) => {
      const baseColor = el.dataset.statusColor || '#A8B57A';
      const isHovered = id === hoveredCompId;
      if (isHovered) {
        el.style.boxShadow = '0 0 0 4px rgba(168,181,122,0.40), 0 8px 22px rgba(0,0,0,.55)';
        el.style.borderColor = '#C4CE96';
        el.style.color = '#F5F1E8';
        el.style.zIndex = '10';
      } else {
        el.style.boxShadow = '0 2px 10px rgba(0,0,0,.4)';
        el.style.borderColor = baseColor;
        el.style.color = '#F5F1E8';
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
            // Per-comp Adjusted $/Ac. Resolution order (most-
            // authoritative wins) — MUST match the workspace's
            // effectiveImprovement helper or the two surfaces will
            // disagree (root cause of the bug a client saw in a
            // meeting):
            //   1. CMA draft override (adj.improvement_value)
            //   2. c.improvement_value (singular, broker-saved
            //      provenanced override)
            //   3. c.improvements_value (plural, populated by import
            //      extraction from appraisal/MLS) — this fallback was
            //      missing on the report before PR #37, which made
            //      imported MLS comps show Adjusted = Total even when
            //      the DB had a populated improvements_value and the
            //      map popup correctly showed the discount.
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
                  : (c as any).improvements_value != null && Number((c as any).improvements_value) > 0
                  ? Number((c as any).improvements_value)
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

            // Shared cmaMath helper for the three-card display below.
            // Same canonical definitions as the workspace + list view.
            // The legacy bindings above (allIn/landOnly/aMid/lMid) still
            // feed downstream logic — slider math, BOV computed values,
            // the broker's-read PPA recommendation — so we keep them.
            const sharedAverages = computeCmaAverages(
              comps as any,
              (cma as any).comp_adjustments
            );
            const sharedSubjectTotals = subjectTotals(sharedAverages, subjAcres);

            // Whether ANY comp in this CMA has an improvement signal to
            // back out (broker override, provenanced singular field, OR
            // appraisal-extracted plural field). Drives the value-range
            // slider's "use land-only range" decision. The plural-field
            // fallback was missing before PR #37, which silently caused
            // MLS-imported CMAs to render the all-in range even when
            // they had populated improvements_value.
            const hasAnyAdjustedComp = comps.some((c) => {
              const adj = adjMap[c.id] || {};
              return (
                adj.improvement_value != null
                || (c as any).improvement_value != null
                || ((c as any).improvements_value != null && Number((c as any).improvements_value) > 0)
              );
            });
            // Broker's Opinion of Value — supports two modes:
            //   'lump_sum'  → one number (broker_opinion_value is the total)
            //   'breakdown' → land + improvement (broker_opinion_land_value
            //                  + broker_opinion_improvement_value); total =
            //                  sum of the two
            // When mode is NULL, infer from which columns are populated.
            const brokerOpinion = (cma as any).broker_opinion_value;
            const brokerLandValue = (cma as any).broker_opinion_land_value;
            const brokerImprovementValue = (cma as any).broker_opinion_improvement_value;
            const brokerMode = (cma as any).broker_opinion_mode as 'lump_sum' | 'breakdown' | null | undefined;

            const landNum = brokerLandValue != null ? Number(brokerLandValue) : NaN;
            const impNum = brokerImprovementValue != null ? Number(brokerImprovementValue) : NaN;
            const lumpNum = brokerOpinion != null ? Number(brokerOpinion) : NaN;

            // Resolve mode: explicit > inferred from data presence
            const isBreakdown =
              brokerMode === 'breakdown'
              || (brokerMode == null && Number.isFinite(landNum) && landNum > 0);
            const isLumpSum =
              brokerMode === 'lump_sum'
              || (brokerMode == null && !isBreakdown && Number.isFinite(lumpNum) && lumpNum > 0);
            const usingBrokerOpinion = isBreakdown || isLumpSum;

            const usingLandOnly = hasAnyAdjustedComp && landOnly.length > 0;

            // Active range = land-only when adjustments exist, else all-in.
            //
            // Broker override (migration 035): if the broker explicitly set
            // opinion_range_low_total / opinion_range_high_total on the CMA
            // (via the Range-mode input pair in the workspace), those values
            // win — both for display in Range mode and for the per-acre
            // derivation (total ÷ subject acres). NULL on either column
            // falls back to the comp-derived range. Self-healing on missing
            // migration: column reads as undefined, treated as null.
            const compRngLow = usingLandOnly ? lLow : aLow;
            const compRngMid = usingLandOnly ? lMid : aMid;
            const compRngHigh = usingLandOnly ? lHigh : aHigh;
            const brokerRangeLowTotal = Number((cma as any).opinion_range_low_total) || 0;
            const brokerRangeHighTotal = Number((cma as any).opinion_range_high_total) || 0;
            const rngLow = brokerRangeLowTotal > 0 && subjAcres > 0
              ? brokerRangeLowTotal / subjAcres
              : compRngLow;
            const rngHigh = brokerRangeHighTotal > 0 && subjAcres > 0
              ? brokerRangeHighTotal / subjAcres
              : compRngHigh;
            const rngMid = (rngLow + rngHigh) / 2 || compRngMid;

            // Compute the total broker opinion + components
            const opinionLand = Number.isFinite(landNum) && landNum > 0 ? landNum : 0;
            const opinionImprovement = Number.isFinite(impNum) && impNum > 0 ? impNum : 0;
            const opinionLumpSum = Number.isFinite(lumpNum) && lumpNum > 0 ? lumpNum : 0;
            const opinionBreakdownTotal = opinionLand + opinionImprovement;

            // Optional house itemization under Improvement Value. When the
            // broker filled in House SQFT × $/SQFT (and/or additional vertical),
            // the share report shows the itemization beneath the Improvement
            // Value line. Otherwise just the lump improvement.
            const houseSqftRaw = (cma as any).broker_opinion_house_sqft;
            const housePpsfRaw = (cma as any).broker_opinion_house_ppsf;
            const addlVertRaw = (cma as any).broker_opinion_additional_vertical;
            const houseSqftN = houseSqftRaw != null ? Number(houseSqftRaw) : NaN;
            const housePpsfN = housePpsfRaw != null ? Number(housePpsfRaw) : NaN;
            const addlVertN = addlVertRaw != null ? Number(addlVertRaw) : NaN;
            const houseSqftVal = Number.isFinite(houseSqftN) && houseSqftN > 0 ? houseSqftN : 0;
            const housePpsfVal = Number.isFinite(housePpsfN) && housePpsfN > 0 ? housePpsfN : 0;
            const additionalVerticalVal = Number.isFinite(addlVertN) && addlVertN > 0 ? addlVertN : 0;
            const houseValue = (houseSqftVal > 0 && housePpsfVal > 0) ? houseSqftVal * housePpsfVal : 0;
            const hasHouseItemization = houseValue > 0 || additionalVerticalVal > 0;

            const computedPpa = usingLandOnly ? lMid : aMid;
            // BOV (Opinion of Value) — broker's professional estimate of
            // current market value. Either lump sum or breakdown total.
            const opinionOfValue = isBreakdown
              ? opinionBreakdownTotal
              : isLumpSum
              ? opinionLumpSum
              : 0;
            // Suggested List Price — broker's override saved on the CMA.
            // Stored in cmas.suggested_list_price (migration 030); the
            // workspace card defaults this to OOV × cushion but only writes
            // the column if the broker explicitly typed a value.
            const suggestedListRaw = (cma as any).suggested_list_price;
            const suggestedListPrice = Number(suggestedListRaw) > 0 ? Number(suggestedListRaw) : 0;

            // Headline value: which number leads the report?
            //   Both OOV + List filled → List price headlines, OOV is supporting
            //   Only List filled       → List price headlines
            //   Only OOV filled        → OOV headlines (legacy behavior)
            //   Neither filled         → comp-derived fallback (legacy behavior)
            const headlineKind: 'list' | 'opinion' | 'computed' =
              suggestedListPrice > 0 ? 'list'
              : opinionOfValue > 0   ? 'opinion'
              : 'computed';
            const suggestedValue =
              headlineKind === 'list'     ? suggestedListPrice
              : headlineKind === 'opinion' ? opinionOfValue
              : computedPpa * subjAcres;
            const suggestedPpa = subjAcres > 0 ? suggestedValue / subjAcres : computedPpa;
            // Supporting OOV line — shown UNDER the headline when the
            // headline is the Suggested List Price AND OOV exists. Defends
            // the cushion: "list at $5.13M · opinion of value $4.67M".
            const supportingOpinionOfValue = headlineKind === 'list' && opinionOfValue > 0 ? opinionOfValue : 0;

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
                {/* ============ SECTION 1 — STICKY SUBJECT + HEADLINE PRICE ============
                    Sticky at the top of the scrolling report so the
                    seller / buyer never loses sight of WHICH PROPERTY
                    and WHAT NUMBER they're reading about, no matter how
                    far they scroll into the comps. The headline number
                    on the right shifts based on what's filled out:
                      • Discuss mode → "Let's discuss"
                      • Range mode   → "$X–$Y"
                      • Otherwise    → Opinion of Value (suggested $)
                    Falls back to subject-only display if no valuation
                    is set yet (showPrice gate). */}
                <div className="sticky top-0 z-20 bg-cream border-b border-beige p-4">
                  <div className="bg-white border border-beige rounded-xl p-3">
                    {(() => {
                      // Inline presentation flags so this section can show
                      // the appropriate headline price without depending on
                      // Section 4's later computation. Duplicates the logic
                      // at line ~774 — kept local to avoid hoisting state
                      // that might affect Section 4's existing render.
                      const presentation = ((cma as any).opinion_presentation as 'confirmed' | 'range' | 'discuss' | null) || 'confirmed';
                      const isDiscuss = presentation === 'discuss';
                      const isRange = presentation === 'range';
                      const rangeLowDollar = rngLow * subjAcres;
                      const rangeHighDollar = rngHigh * subjAcres;
                      const showPrice =
                        isDiscuss
                        || (isRange && rngHigh > rngLow && subjAcres > 0)
                        || suggestedValue > 0;

                      return (
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-1 min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: '#C8503F', boxShadow: '0 0 0 3px rgba(200,80,63,0.20)' }} />
                              <p className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: '#C8503F' }}>Your Property</p>
                            </div>
                            {/* Subject name pretty-printed so the report doesn't
                                look like a CAD parcel printout when the source
                                record is ALL CAPS ("CARAWAY PARTNERS LTD"). */}
                            <p className="text-sm font-semibold text-ink truncate">{properCase(cma.subject_name)}</p>
                            <p className="text-xs text-ink-2 font-mono tabular-nums flex items-center gap-1">
                              <MapPin size={10} className="text-ink-3 flex-shrink-0" />
                              <span className="truncate">{properCase(cma.subject_county)}, {cma.subject_state} · {formatAcres(subjAcres)}</span>
                            </p>
                          </div>
                          {showPrice && (
                            <div className="text-right flex-shrink-0 max-w-[10rem]">
                              <p className="text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                                {isDiscuss
                                  ? 'Valuation'
                                  : isRange
                                  ? 'Range'
                                  : headlineKind === 'list'
                                  ? 'Suggested List'
                                  : 'Opinion of Value'}
                              </p>
                              {isDiscuss ? (
                                <p className="text-sm font-semibold text-ink italic font-mono leading-tight mt-0.5">
                                  Let&apos;s discuss
                                </p>
                              ) : isRange ? (
                                <>
                                  <p className="text-sm font-semibold text-olive-2 font-mono tabular-nums leading-tight mt-0.5 whitespace-nowrap">
                                    {formatCurrency(rangeLowDollar)}–{formatCurrency(rangeHighDollar)}
                                  </p>
                                  {subjAcres > 0 && (
                                    <p className="text-[10px] text-ink-3 font-mono tabular-nums whitespace-nowrap">
                                      {formatPPA(rngLow)}–{formatPPA(rngHigh)}
                                    </p>
                                  )}
                                </>
                              ) : (
                                <>
                                  <p className="text-base font-bold text-olive-2 font-mono tabular-nums leading-tight mt-0.5 whitespace-nowrap">
                                    {formatCurrency(suggestedValue)}
                                  </p>
                                  {subjAcres > 0 && (
                                    <p className="text-[10px] text-ink-3 font-mono tabular-nums whitespace-nowrap">
                                      {formatPPA(suggestedPpa)}
                                    </p>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Download Marketing PDF — moved OUT of the sticky strip
                    so the sticky region stays compact. The button still
                    sits right under the subject card on initial scroll,
                    so the client encounters it immediately. Gold accent
                    matches the PDF's brand palette so the visual
                    handshake feels intentional when they open the file. */}
                <div className="p-4 border-b border-beige">
                  <button
                    onClick={downloadMarketingPdf}
                    disabled={pdfDownloading}
                    className="w-full py-2.5 px-3 border rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{
                      borderColor: 'rgba(182,138,53,0.45)',
                      backgroundColor: 'rgba(182,138,53,0.12)',
                      color: '#8C6A29',
                    }}
                  >
                    {pdfDownloading ? (
                      <>
                        <Loader2 size={13} className="animate-spin" />
                        Building PDF…
                      </>
                    ) : (
                      <>
                        <Download size={13} />
                        Download Marketing PDF
                      </>
                    )}
                  </button>
                </div>

                {/* Per-acre average cards moved BELOW the Suggested List
                    Price + Expected Sale (Section 4) and now sit inside
                    a collapsible "Per-acre detail" panel. Rationale: the
                    client's first scroll should land on THE ANSWER
                    ($X.XM list, $Y.YM expected), not on three rows of
                    Low/Mid/High that mean nothing in isolation. The
                    averages don't disappear — they're one click below.
                    See SECTION 2b further down for the new placement. */}

                {/* ============ SECTION 4 — SUGGESTED LIST PRICE + BOV ============
                    Headline of the report — leads with the broker's
                    SUGGESTED LIST PRICE (BOV × 1.10 default, or broker
                    override). The BOV becomes the supporting "expected
                    sale" detail underneath. Three render modes preserved:
                      1. Breakdown — Land + Improvement itemization
                      2. Lump Sum — single number
                      3. Computed — falls back to CMA averages when
                         broker hasn't set an opinion
                    The list price framing prevents sticker shock: the
                    seller anchors on the aspirational number first, the
                    expected sale lands as "with negotiation room baked
                    in" rather than "this is what it's worth, sorry." */}
                {suggestedValue > 0 && (() => {
                  // suggested_list_price column is still in the DB and
                  // the broker workspace still exposes the input — it's
                  // just no longer surfaced as the report's headline.
                  // Future "Listing Strategy" section may re-surface it
                  // as separate broker guidance below the Opinion of
                  // Value, distinct from the valuation itself.

                  // Indicator math: when the broker's Opinion of Value
                  // sits OUTSIDE the comp range, surface that fact
                  // explicitly with a percentage delta. Honest framing
                  // — the broker is calling the subject above or below
                  // what the comp set supports, and the client deserves
                  // to see that explicit positioning instead of math
                  // that looks artificially aligned.
                  const rangeLowDollar = rngLow * subjAcres;
                  const rangeHighDollar = rngHigh * subjAcres;
                  const aboveRange = rangeHighDollar > 0 && suggestedValue > rangeHighDollar;
                  const belowRange = rangeLowDollar > 0 && suggestedValue < rangeLowDollar;
                  const deltaPct = aboveRange
                    ? Math.round(((suggestedValue - rangeHighDollar) / rangeHighDollar) * 100)
                    : belowRange
                      ? Math.round(((rangeLowDollar - suggestedValue) / rangeLowDollar) * 100)
                      : 0;

                  // Presentation mode — broker chose how the BOV lands
                  // on this report. NULL or 'confirmed' = current (hard
                  // number) behavior. 'range' = comp range only, no
                  // point estimate. 'discuss' = "Let's discuss" soft
                  // invitation, no number. See migration 031.
                  const presentation = ((cma as any).opinion_presentation as 'confirmed' | 'range' | 'discuss' | null) || 'confirmed';
                  const valuationNotes: string = (typeof (cma as any).valuation_notes === 'string' ? (cma as any).valuation_notes : '').trim();
                  const isDiscussMode = presentation === 'discuss';
                  const isRangeMode = presentation === 'range';

                  return (
                    <>
                  {/* OPINION OF VALUE — the headline of the report.
                      Industry-standard term for commercial/land BOVs.
                      The "Suggested List Price" hero is deprecated; the
                      suggested_list_price DB column stays put for a
                      possible future "Listing Strategy" section that
                      sits separately, but it's no longer the
                      attention-grabbing top-of-fold number. Brokers
                      lead with their professional opinion of value;
                      list-price strategy is a separate conversation. */}
                  <div className="mx-4 mb-4 p-5 rounded-2xl bg-white border border-beige shadow-sm">
                    {/* Headline label adapts to what's filled out:
                          • Suggested List Price entered  → "Suggested List Price"
                          • Only OOV entered              → "Opinion of Value"
                          • Range / Discuss mode          → "Valuation" / "Range" (existing)
                        The label tells the client EXACTLY what number
                        they're looking at, so the cushion / negotiation
                        room isn't a hidden assumption. */}
                    <p className="text-[10px] font-medium text-ink-2 uppercase tracking-[0.18em] mb-2">
                      {isDiscussMode
                        ? 'Valuation'
                        : isRangeMode
                        ? 'Range'
                        : headlineKind === 'list'
                        ? 'Suggested List Price'
                        : 'Opinion of Value'}
                    </p>

                    {isDiscussMode ? (
                      // "Let's Discuss" mode — no point estimate, no
                      // breakdown. Client sees a soft invitation +
                      // broker's contact handoff. Comp data still
                      // visible below (averages + comp list). The
                      // seller arrives at the meeting with comp
                      // evidence but no anchor to react to.
                      <>
                        <p className="text-2xl font-semibold text-ink italic font-mono leading-none">
                          Let&apos;s discuss
                        </p>
                        <p className="text-[11px] text-ink-2 leading-relaxed mt-3">
                          Final value depends on factors worth talking through together — listing strategy, market timing, and how this property compares feature-for-feature against the comp set.
                          {broker?.full_name && (
                            <> Reach out to <span className="font-semibold text-ink">{broker.full_name}</span> to discuss.</>
                          )}
                        </p>
                      </>
                    ) : isRangeMode ? (
                      // Range mode — shows the comp-derived range as a
                      // band rather than a point estimate. Useful when
                      // the broker has confidence in a band but the
                      // final number depends on listing strategy or
                      // market conditions.
                      <>
                        {rngHigh > rngLow ? (
                          <p className="text-2xl font-semibold text-olive-2 font-mono tabular-nums leading-tight">
                            {formatCurrency(rangeLowDollar)} – {formatCurrency(rangeHighDollar)}
                          </p>
                        ) : (
                          <p className="text-2xl font-semibold text-ink italic font-mono leading-none">
                            Range pending
                          </p>
                        )}
                        <p className="text-[11px] text-ink-2 font-mono tabular-nums mt-1.5">
                          {formatPPA(rngLow)} – {formatPPA(rngHigh)} × {formatAcres(subjAcres)}
                        </p>
                      </>
                    ) : isBreakdown ? (
                      // Itemized: Land Value + Improvement Value = Total.
                      // When house itemization is present (SQFT × $/SQFT and/or
                      // additional vertical), show the breakdown nested under
                      // Improvement Value so the client sees how it was derived.
                      <div className="space-y-2.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <div>
                            <p className="text-[12px] font-medium text-ink">Land Value</p>
                            {subjAcres > 0 && opinionLand > 0 && (
                              <p className="text-[10px] text-ink-3 font-mono tabular-nums mt-0.5">
                                {formatPPA(opinionLand / subjAcres)} · {formatAcres(subjAcres)}
                              </p>
                            )}
                          </div>
                          <p className="text-base font-semibold text-ink font-mono tabular-nums">
                            {formatCurrency(opinionLand)}
                          </p>
                        </div>
                        {opinionImprovement > 0 && (
                          <div className="space-y-1.5">
                            <div className="flex items-baseline justify-between gap-3">
                              <p className="text-[12px] font-medium text-ink">Improvement Value</p>
                              <p className="text-base font-semibold text-ink font-mono tabular-nums">
                                {formatCurrency(opinionImprovement)}
                              </p>
                            </div>
                            {hasHouseItemization && (
                              // Nested itemization under Improvement Value.
                              // Indented with a left bar so the client visually
                              // groups these rows under their parent total.
                              <div className="ml-3 pl-3 border-l-2 border-beige space-y-1">
                                {houseValue > 0 && (
                                  <div className="flex items-baseline justify-between gap-3">
                                    <p className="text-[11px] text-ink-2">
                                      House <span className="text-ink-3 font-mono tabular-nums">· {houseSqftVal.toLocaleString()} sqft × ${housePpsfVal.toLocaleString()}/sqft</span>
                                    </p>
                                    <p className="text-[11px] font-mono tabular-nums text-ink-2">
                                      {formatCurrency(houseValue)}
                                    </p>
                                  </div>
                                )}
                                {additionalVerticalVal > 0 && (
                                  <div className="flex items-baseline justify-between gap-3">
                                    <p className="text-[11px] text-ink-2">Additional vertical improvements</p>
                                    <p className="text-[11px] font-mono tabular-nums text-ink-2">
                                      {formatCurrency(additionalVerticalVal)}
                                    </p>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        <div className="border-t border-beige pt-2.5 flex items-baseline justify-between gap-3">
                          <p className="text-[12px] font-semibold text-ink-2 uppercase tracking-[0.06em]">Total</p>
                          <p className="text-2xl font-semibold text-olive-2 font-mono tabular-nums leading-none">
                            {formatCurrency(suggestedValue)}
                          </p>
                        </div>
                      </div>
                    ) : (
                      // Single number — Suggested List Price OR Opinion of
                      // Value OR comp-derived (in that priority order). When
                      // the headline is the List Price AND the broker also
                      // entered an OOV, the OOV appears as a supporting line
                      // below — "list at $5.13M · opinion of value $4.67M" —
                      // so the negotiation cushion is visible, not hidden.
                      <>
                        <p className="text-3xl font-semibold text-olive-2 font-mono tabular-nums leading-none">
                          {formatCurrency(suggestedValue)}
                        </p>
                        <p className="text-[11px] text-ink-2 font-mono tabular-nums mt-1.5">
                          {formatPPA(suggestedPpa)} × {formatAcres(subjAcres)}
                        </p>
                        {supportingOpinionOfValue > 0 && (
                          <p className="text-[11px] text-ink-2 mt-2 leading-relaxed">
                            <span className="text-ink-3">Opinion of Value:</span>{' '}
                            <span className="font-mono font-semibold text-ink tabular-nums">{formatCurrency(supportingOpinionOfValue)}</span>
                            {subjAcres > 0 && (
                              <> <span className="text-ink-3">·</span> <span className="font-mono tabular-nums">{formatPPA(supportingOpinionOfValue / subjAcres)}</span></>
                            )}
                          </p>
                        )}
                      </>
                    )}

                    {/* Compact supporting line — the two numbers that
                        defend the Opinion of Value most directly.
                        Visible on first glance (no expansion required)
                        per broker feedback that these are critical
                        signals, not buried-in-detail metrics. Falls
                        back gracefully when either avg has no data. */}
                    {(sharedAverages.total.n > 0 || sharedAverages.landOnly.n > 0) && (
                      <p className="text-[11px] text-ink-2 mt-3 leading-relaxed">
                        Based on <span className="font-semibold text-ink">{comps.length} comparable {comps.length === 1 ? 'sale' : 'sales'}</span>
                        {sharedAverages.total.mid != null && (
                          <>
                            {' '}· avg sale{' '}
                            <span className="font-mono font-semibold text-olive-2">{formatPPA(sharedAverages.total.mid)}</span>
                          </>
                        )}
                        {sharedAverages.landOnly.mid != null && (
                          <>
                            {' '}· avg land-only{' '}
                            <span className="font-mono font-semibold text-slate-blue-2">{formatPPA(sharedAverages.landOnly.mid)}</span>
                          </>
                        )}
                      </p>
                    )}

                    {/* Above/below range indicator — fires only when the
                        Opinion of Value sits OUTSIDE the comp range
                        (high or low). Skipped in 'discuss' and 'range'
                        presentation modes because there's no point
                        estimate to position relative to the range.
                        When notes are also set, the chain becomes
                        [indicator → notes] for a complete "above range
                        + here's why" narrative. */}
                    {!isDiscussMode && !isRangeMode && (aboveRange || belowRange) && deltaPct > 0 && (
                      <div className={`mt-2 px-3 py-2 rounded-lg border text-[11px] leading-relaxed ${
                        aboveRange
                          ? 'bg-amber-50/60 border-amber-200 text-amber-800'
                          : 'bg-slate-blue/5 border-slate-blue/20 text-slate-blue-2'
                      }`}>
                        <span className="font-semibold">
                          {aboveRange ? '↑' : '↓'} {deltaPct}% {aboveRange ? 'above' : 'below'} {aboveRange ? 'highest' : 'lowest'} comp
                        </span>
                        <span className="text-ink-2">
                          {' '}— {aboveRange
                            ? 'subject carries features the comp set lacks (improvements, water, frontage).'
                            : 'subject has limitations the comp set doesn\'t share (access, encumbrances, condition).'}
                        </span>
                      </div>
                    )}

                    {/* Valuation Notes — broker's WHY paragraph. Renders
                        below the headline + indicators, above the
                        slider. Critical in 'discuss' mode (where it's
                        often the broker's only verbal commitment) and
                        useful in any mode to add context. */}
                    {valuationNotes && (
                      <div className="mt-4 px-4 py-3 rounded-xl bg-cream-2/40 border-l-4 border-olive-border/60">
                        <p className="text-[10px] uppercase tracking-wider text-olive-2 font-bold mb-1">
                          {broker?.full_name ? `${broker.full_name.split(' ')[0]}'s Read` : "Broker's Read"}
                        </p>
                        <p className="text-[12px] text-ink leading-relaxed whitespace-pre-wrap">
                          {valuationNotes}
                        </p>
                      </div>
                    )}

                    {/* Range bar — point estimate marker only makes
                        sense in 'confirmed' mode. In 'range' mode the
                        Low/High band is already the headline; in
                        'discuss' mode there's no point estimate to
                        place on the slider. Skipped for both. */}
                    {!isDiscussMode && !isRangeMode && rngHigh > rngLow && (
                      <div className="mt-4">
                        <div className="relative mb-2">
                          <div className="h-1.5 rounded-full bg-cream border border-beige overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-beige-2 via-olive/40 to-beige-2" />
                          </div>
                          <div
                            className="absolute -top-1.5 w-4 h-4 rounded-full bg-olive border-2 border-white shadow-md -translate-x-1/2"
                            style={{ left: `${markerPct}%` }}
                            title={`Recommended ${formatPPA(suggestedPpa)}`}
                          />
                        </div>
                        <div className="flex justify-between text-[9px] font-mono">
                          <div>
                            <p className="text-ink-3 uppercase tracking-wider">Low</p>
                            <p className="text-ink-2 tabular-nums">{formatCurrency(rngLow * subjAcres)}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-ink-3 uppercase tracking-wider">High</p>
                            <p className="text-ink-2 tabular-nums">{formatCurrency(rngHigh * subjAcres)}</p>
                          </div>
                        </div>
                      </div>
                    )}

                    <p className="text-[11px] text-ink-2 leading-relaxed mt-4">
                      {isDiscussMode
                        ? `Comp data below supports the conversation. ${comps.length} comparable ${comps.length === 1 ? 'sale' : 'sales'} included.`
                        : isRangeMode
                        ? `Range derived from ${comps.length} comparable ${comps.length === 1 ? 'sale' : 'sales'} — final value depends on listing strategy and market timing.`
                        : isBreakdown
                        ? `Land valued at ${formatPPA(opinionLand / Math.max(subjAcres, 1))} based on the ${comps.length} comparable ${comps.length === 1 ? 'sale' : 'sales'} below${opinionImprovement > 0 ? `; improvements valued separately at ${formatCurrency(opinionImprovement)}` : ''}.`
                        : isLumpSum
                        ? `Broker's professional opinion of value, supported by the ${comps.length} comparable ${comps.length === 1 ? 'sale' : 'sales'} below.`
                        : usingLandOnly
                        ? `Based on the land-only average across ${landOnly.length} of ${comps.length} comparable sales.`
                        : `Based on the average across ${allIn.length} comparable ${allIn.length === 1 ? 'sale' : 'sales'}.`}
                    </p>
                  </div>
                    </>
                  );
                })()}

                {/* ============ SECTION 4b — PER-ACRE DETAIL (collapsed) ============
                    The two $/Ac averages used to sit above the Suggested
                    List Price hero — that created sticker shock on first
                    glance because clients saw 18+ dollar amounts before
                    the actual answer. Now collapsed by default; clients
                    expand if they want to verify the math. The broker
                    workspace still shows all three average cards (incl.
                    Adjusted) open by default for diagnostic use. */}
                {(sharedAverages.total.n > 0 || sharedAverages.landOnly.n > 0) && (
                  <div className="px-4 pb-4">
                    <button
                      onClick={() => setPerAcreDetailOpen((v) => !v)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-cream hover:bg-cream-2 border border-beige hover:border-beige-2 rounded-xl transition-colors text-left"
                      aria-expanded={perAcreDetailOpen}
                    >
                      <div>
                        <p className="text-[11px] font-semibold text-ink">Per-acre comp detail</p>
                        <p className="text-[10px] text-ink-3">
                          Low / Mid / High $/Ac across the comparable sales
                        </p>
                      </div>
                      <ChevronDown
                        size={14}
                        className={`text-ink-3 transition-transform flex-shrink-0 ${perAcreDetailOpen ? 'rotate-180' : ''}`}
                      />
                    </button>

                    {perAcreDetailOpen && (
                      <div className="mt-2 space-y-2">
                        {sharedAverages.total.n > 0 && (
                          <div className="bg-white border border-beige rounded-xl overflow-hidden">
                            <div className="px-3 py-2 border-b border-beige flex items-center justify-between">
                              <p className="text-[10px] font-medium text-ink-2 uppercase tracking-[0.08em]">Average Total Price Per Acre</p>
                              <p className="text-[9px] text-ink-3 font-mono">{sharedAverages.total.n} of {comps.length} comps</p>
                            </div>
                            <table className="w-full text-xs">
                              <tbody className="font-mono">
                                <tr>
                                  <td className="px-3 py-1.5 text-ink-2">Low</td>
                                  <td className="text-right px-3 py-1.5 text-ink tabular-nums">{sharedAverages.total.low != null ? formatPPA(sharedAverages.total.low) : '—'}</td>
                                  <td className="text-right px-3 py-1.5 text-ink tabular-nums">{sharedSubjectTotals.total.low != null ? formatCurrency(sharedSubjectTotals.total.low) : '—'}</td>
                                </tr>
                                <tr className="border-t border-beige/60">
                                  <td className="px-3 py-2 text-olive-2 font-semibold">Mid</td>
                                  <td className="text-right px-3 py-2 text-olive-2 font-semibold tabular-nums">{sharedAverages.total.mid != null ? formatPPA(sharedAverages.total.mid) : '—'}</td>
                                  <td className="text-right px-3 py-2 text-olive-2 font-semibold tabular-nums">{sharedSubjectTotals.total.mid != null ? formatCurrency(sharedSubjectTotals.total.mid) : '—'}</td>
                                </tr>
                                <tr className="border-t border-beige/60">
                                  <td className="px-3 py-1.5 text-ink-2">High</td>
                                  <td className="text-right px-3 py-1.5 text-ink tabular-nums">{sharedAverages.total.high != null ? formatPPA(sharedAverages.total.high) : '—'}</td>
                                  <td className="text-right px-3 py-1.5 text-ink tabular-nums">{sharedSubjectTotals.total.high != null ? formatCurrency(sharedSubjectTotals.total.high) : '—'}</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        )}

                        {sharedAverages.landOnly.n > 0 && (
                          <div className="bg-white border border-beige rounded-xl overflow-hidden">
                            <div className="px-3 py-2 border-b border-beige flex items-center justify-between">
                              <p className="text-[10px] font-medium text-ink-2 uppercase tracking-[0.08em]">
                                Average Land-Only Price Per Acre
                              </p>
                              <p className="text-[9px] text-ink-3 font-mono">{sharedAverages.landOnly.n} of {comps.length} comps</p>
                            </div>
                            <table className="w-full text-xs">
                              <tbody className="font-mono">
                                <tr>
                                  <td className="px-3 py-1.5 text-ink-2">Low</td>
                                  <td className="text-right px-3 py-1.5 text-ink tabular-nums">{sharedAverages.landOnly.low != null ? formatPPA(sharedAverages.landOnly.low) : '—'}</td>
                                  <td className="text-right px-3 py-1.5 text-ink tabular-nums">{sharedSubjectTotals.landOnly.low != null ? formatCurrency(sharedSubjectTotals.landOnly.low) : '—'}</td>
                                </tr>
                                <tr className="border-t border-beige/60">
                                  <td className="px-3 py-2 text-slate-blue-2 font-semibold">Mid</td>
                                  <td className="text-right px-3 py-2 text-slate-blue-2 font-semibold tabular-nums">{sharedAverages.landOnly.mid != null ? formatPPA(sharedAverages.landOnly.mid) : '—'}</td>
                                  <td className="text-right px-3 py-2 text-slate-blue-2 font-semibold tabular-nums">{sharedSubjectTotals.landOnly.mid != null ? formatCurrency(sharedSubjectTotals.landOnly.mid) : '—'}</td>
                                </tr>
                                <tr className="border-t border-beige/60">
                                  <td className="px-3 py-1.5 text-ink-2">High</td>
                                  <td className="text-right px-3 py-1.5 text-ink tabular-nums">{sharedAverages.landOnly.high != null ? formatPPA(sharedAverages.landOnly.high) : '—'}</td>
                                  <td className="text-right px-3 py-1.5 text-ink tabular-nums">{sharedSubjectTotals.landOnly.high != null ? formatCurrency(sharedSubjectTotals.landOnly.high) : '—'}</td>
                                </tr>
                              </tbody>
                            </table>
                            <p className="text-[10px] text-ink-3 leading-relaxed px-3 py-2 border-t border-beige/60">
                              $/acre with improvements (houses, barns) backed out — what raw dirt is trading for.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
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
                            {(() => {
                              // Listing link — surface on the COLLAPSED card so
                              // clients can click straight to the listing without
                              // having to expand each comp. Prefers source_links[0]
                              // (multi-link case) over source_url (legacy single
                              // string). Null when neither exists; the cell omits.
                              const listingLinks: any[] = (comp as any).source_links || [];
                              const listingUrl: string | null =
                                listingLinks.length > 0
                                  ? listingLinks[0]?.url
                                  : (comp as any).source_url || null;
                              return (
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-xs font-bold text-ink truncate flex-1 flex items-center gap-1.5">
                                    {/* Property name doubles as the listing link
                                        when one exists. Clients reach for it first
                                        ("can I see this property?") — make it a
                                        target. When no link, render as a plain
                                        span so it doesn't look misleadingly
                                        clickable. */}
                                    {listingUrl ? (
                                      <a
                                        href={listingUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        className="truncate text-ink hover:text-slate-blue-2 hover:underline decoration-slate-blue-2/40 underline-offset-2 transition-colors"
                                        title="Open the listing in a new tab"
                                      >
                                        {properCase(comp.property_name) || `${properCase(comp.county)} County`}
                                      </a>
                                    ) : (
                                      <span className="truncate">{properCase(comp.property_name) || `${properCase(comp.county)} County`}</span>
                                    )}
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
                                    {/* Sale date — most-asked client question
                                        ("when did that one sell?"). Surfaced on
                                        the collapsed card so they don't have to
                                        expand each comp to find it. Compact
                                        "Sold Mon YYYY" format. Sales >24 months
                                        old get a small amber pill so the client
                                        sees the recency context without doing
                                        math — TX land moved hard in 2022, a
                                        $5K/ac comp from 2021 vs $10K/ac in
                                        2024 is market shift, not noise. */}
                                    {(comp as any).sale_date && (() => {
                                      const d = new Date((comp as any).sale_date);
                                      if (Number.isNaN(d.getTime())) return null;
                                      const label = `Sold ${d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
                                      const monthsAgo =
                                        (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
                                      const isOld = monthsAgo >= 24;
                                      return (
                                        <span className="flex items-center gap-1.5 flex-shrink-0">
                                          <span className="text-[10px] text-ink-2 font-mono">{label}</span>
                                          {isOld && (
                                            <span
                                              className="text-[8px] uppercase tracking-wide px-1 py-px rounded bg-amber-50 border border-amber-300 text-amber-700"
                                              title="More than two years old — market may have shifted since this sale"
                                            >
                                              2+ yr
                                            </span>
                                          )}
                                        </span>
                                      );
                                    })()}
                                    {dist != null && (
                                      <p className="text-[10px] text-ink-3 font-mono">{dist.toFixed(1)} mi</p>
                                    )}
                                    {/* Secondary listing affordance — an explicit
                                        external-link icon. Some clients won't
                                        notice the underlined property name;
                                        the icon signals "click here, opens a
                                        new tab" universally. */}
                                    {listingUrl && (
                                      <a
                                        href={listingUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        className="p-0.5 rounded text-ink-3 hover:text-slate-blue-2 hover:bg-slate-blue/10 transition-colors"
                                        title="Open listing in a new tab"
                                      >
                                        <ExternalLink size={13} />
                                      </a>
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
                              );
                            })()}
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

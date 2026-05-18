'use client';

// ─────────────────────────────────────────────────────────────────────────
// /dashboard/review/[compId]
//
// Per-comp editing workspace. Brokers land here from the import flow's
// "Needs review" button (or the vault's clock badge). Goal: give the
// broker a focused workspace to verify or fix one comp's location +
// boundary, separate from the database-overview map.
//
// Build stages (per docs/DESIGN_DECISIONS.md §5 + §7):
//   STAGE A (THIS COMMIT) — page route + side panel + floating aerial +
//                           map rendering of current boundary + Mark
//                           verified button. No editing tools yet.
//   STAGE B  — Reselect parcels mode (click to toggle parcels in/out
//              of the cluster, save merges selected polygons)
//   STAGE C  — Draw new boundary mode (freehand polygon via Mapbox Draw)
//   STAGE D  — Tier 1 georeferenced aerial overlay (auto-align bbox)
//   STAGE E  — Tier 2 drag-to-align aerial corners
//
// Stage A intentionally ships viewable but not editable. Lets brokers
// land here and SEE the comp's current state with its source aerial as
// reference — fixing the boundary is the next stage.
// ─────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
// @ts-expect-error — turf v6.5 .d.ts not exposed via package "exports"
import * as turf from '@turf/turf';
import { ArrowLeft, Check, AlertTriangle, MapPinOff, Clock, ImageOff } from 'lucide-react';
import { formatPPA, formatAcres, formatCurrency } from '@/lib/utils';
import toast from 'react-hot-toast';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

// Single satellite style — same as the main map page uses by default
const MAPBOX_STYLE = 'mapbox://styles/mapbox/satellite-streets-v12';

type Comp = {
  id: string;
  property_name: string | null;
  county: string | null;
  state: string | null;
  acres: number | null;
  sale_price: number | null;
  sale_date: string | null;
  improvements_value: number | null;
  ppa_land_only: number | null;
  price_per_acre: number | null;
  grantor: string | null;
  grantee: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  parcel_id: string | null;
  boundary_geojson: any;
  aerial_image: string | null;
  needs_extraction_review: boolean | null;
  needs_location_review: boolean | null;
  source_type: string | null;
  source_url: string | null;
  confidence: string | null;
};

export default function ReviewPage() {
  const params = useParams<{ compId: string }>();
  const router = useRouter();
  const supabase = createClient();

  const [comp, setComp] = useState<Comp | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Aerial panel collapses to a small toggle button after verification —
  // see DESIGN_DECISIONS §5 (aerial as verification tool, not permanent UI).
  const [aerialCollapsed, setAerialCollapsed] = useState(false);

  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  // ── Fetch the comp by id ────────────────────────────────────────────
  useEffect(() => {
    const compId = params?.compId;
    if (!compId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('comps')
        .select(
          'id, property_name, county, state, acres, sale_price, sale_date, ' +
          'improvements_value, ppa_land_only, price_per_acre, grantor, grantee, ' +
          'address, latitude, longitude, parcel_id, boundary_geojson, aerial_image, ' +
          'needs_extraction_review, needs_location_review, source_type, source_url, confidence'
        )
        .eq('id', compId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setLoadError(error.message);
        return;
      }
      if (!data) {
        setLoadError('Comp not found. It may have been deleted.');
        return;
      }
      const compData = data as unknown as Comp;
      setComp(compData);
      // Default the aerial panel to expanded when the comp needs review,
      // collapsed when it's already verified. Broker can toggle either way.
      setAerialCollapsed(!compData.needs_location_review);
    })();
    return () => { cancelled = true; };
  }, [params?.compId, supabase]);

  // ── Initialize the Mapbox map once the container mounts ─────────────
  useEffect(() => {
    if (!mapContainer.current || map.current) return;
    if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN) {
      console.warn('[review] NEXT_PUBLIC_MAPBOX_TOKEN not set — map will not render');
      return;
    }

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAPBOX_STYLE,
      // Default to a TX-wide view; we'll fit to the comp's geometry below
      // once the comp loads and the map's 'load' event has fired.
      center: [-99.5, 30.2],
      zoom: 6,
    });
    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.current.addControl(new mapboxgl.ScaleControl(), 'bottom-right');
    map.current.once('load', () => setMapLoaded(true));

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // ── Render the boundary + auto-fit when both map and comp are ready ─
  useEffect(() => {
    if (!mapLoaded || !comp || !map.current) return;
    const m = map.current;

    // Remove any prior boundary layer/source (safe to call when missing)
    if (m.getLayer('comp-boundary-fill')) m.removeLayer('comp-boundary-fill');
    if (m.getLayer('comp-boundary-line')) m.removeLayer('comp-boundary-line');
    if (m.getSource('comp-boundary')) m.removeSource('comp-boundary');

    const boundary = comp.boundary_geojson;
    if (boundary && (boundary.type === 'Polygon' || boundary.type === 'MultiPolygon')) {
      m.addSource('comp-boundary', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: boundary,
        } as any,
      });
      m.addLayer({
        id: 'comp-boundary-fill',
        type: 'fill',
        source: 'comp-boundary',
        paint: {
          'fill-color': '#facc15',
          'fill-opacity': 0.18,
        },
      });
      m.addLayer({
        id: 'comp-boundary-line',
        type: 'line',
        source: 'comp-boundary',
        paint: {
          'line-color': '#facc15',
          'line-width': 2.5,
        },
      });

      // Fit map to the boundary
      try {
        const feature: any = { type: 'Feature', properties: {}, geometry: boundary };
        const bbox = turf.bbox(feature);
        m.fitBounds(bbox as any, { padding: 80, duration: 800, maxZoom: 16 });
      } catch (e) {
        console.warn('[review] failed to fit bounds, falling back to centroid:', e);
        if (comp.latitude != null && comp.longitude != null) {
          m.flyTo({ center: [comp.longitude, comp.latitude], zoom: 14, duration: 800 });
        }
      }
    } else if (comp.latitude != null && comp.longitude != null) {
      // No boundary geometry but we do have a pin — center on it.
      m.flyTo({ center: [comp.longitude, comp.latitude], zoom: 14, duration: 800 });
    }
    // No boundary AND no lat/lng: map stays at the wide TX view. Side
    // panel will surface this state with the red MapPinOff badge.
  }, [mapLoaded, comp]);

  // ── Mark verified handler ───────────────────────────────────────────
  // Clears needs_location_review = false. The gray clock badge in the
  // vault clears as a side effect (the badge is driven by that column).
  const handleMarkVerified = useCallback(async () => {
    if (!comp || saving) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('comps')
        .update({ needs_location_review: false })
        .eq('id', comp.id);
      if (error) {
        toast.error(`Save failed: ${error.message}`);
      } else {
        toast.success('Marked verified');
        setComp({ ...comp, needs_location_review: false });
        setAerialCollapsed(true); // Hide the verification tool now that it's done
      }
    } finally {
      setSaving(false);
    }
  }, [comp, saving, supabase]);

  // ── Loading / error states ──────────────────────────────────────────
  if (loadError) {
    return (
      <div className="min-h-screen bg-night flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card border border-border rounded-xl p-6 text-center">
          <p className="text-red-400 font-bold mb-2">Couldn't load this comp</p>
          <p className="text-sm text-slate-400 mb-4">{loadError}</p>
          <button
            onClick={() => router.push('/dashboard/vault')}
            className="px-4 py-2 bg-sage text-black rounded-lg text-sm font-bold"
          >
            Back to vault
          </button>
        </div>
      </div>
    );
  }
  if (!comp) {
    return (
      <div className="min-h-screen bg-night flex items-center justify-center">
        <div className="text-slate-400 text-sm">Loading comp…</div>
      </div>
    );
  }

  // ── Computed display values ─────────────────────────────────────────
  const label = comp.property_name || `${comp.county || 'Comp'} ${comp.acres || ''} ac`;
  const hasPin = comp.latitude != null && comp.longitude != null;
  const ppa = comp.ppa_land_only ?? comp.price_per_acre;

  return (
    <div className="fixed inset-0 bg-night flex">
      {/* MAP (fills the screen behind the side panel + overlays) */}
      <div ref={mapContainer} className="absolute inset-0" />

      {/* Top bar: back link + comp label */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-night/90 backdrop-blur border border-border rounded-lg px-3 py-2 max-w-[60%]">
        <button
          onClick={() => router.push('/dashboard/vault')}
          className="text-slate-400 hover:text-white flex items-center gap-1 text-xs"
          title="Back to vault"
        >
          <ArrowLeft size={14} />
          Vault
        </button>
        <span className="text-slate-600">·</span>
        <span className="text-sm font-bold text-white truncate">{label}</span>
        {comp.needs_location_review && (
          <span className="ml-1 inline-flex items-center gap-1 text-[10px] text-slate-400 bg-slate-500/20 border border-slate-500/30 rounded px-1.5 py-0.5">
            <Clock size={10} />
            Needs review
          </span>
        )}
      </div>

      {/* SIDE PANEL (right-side, fixed width). Holds comp metadata,
          status badges, and the Mark verified action. Editing tools
          (Reselect / Draw) go here in Stages B and C. */}
      <aside className="absolute top-0 right-0 bottom-0 w-[320px] bg-night/95 backdrop-blur border-l border-border z-10 overflow-y-auto">
        <div className="p-4 space-y-4">
          <div>
            <h1 className="text-base font-bold text-white">{label}</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              {comp.county}{comp.state ? `, ${comp.state}` : ''}
            </p>
          </div>

          {/* Status badges — same set as the vault list uses */}
          <div className="flex flex-wrap gap-1.5">
            {!hasPin && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
                <MapPinOff size={11} />
                No location
              </span>
            )}
            {comp.needs_extraction_review && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
                <AlertTriangle size={11} />
                Math issue
              </span>
            )}
            {comp.needs_location_review && hasPin && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-300 bg-slate-500/10 border border-slate-500/30 rounded px-2 py-1">
                <Clock size={11} />
                Needs review
              </span>
            )}
            {!comp.needs_location_review && !comp.needs_extraction_review && hasPin && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-2 py-1">
                <Check size={11} />
                Verified
              </span>
            )}
            {comp.source_type === 'listing_url' && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-sky-300 bg-sky-500/10 border border-sky-500/30 rounded px-2 py-1">
                From listing
              </span>
            )}
          </div>

          {/* Headline metrics */}
          <div className="border-t border-border pt-3 space-y-2 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Acres" value={comp.acres != null ? formatAcres(comp.acres) : '—'} />
              <Stat label="Sale price" value={comp.sale_price != null ? formatCurrency(comp.sale_price) : '—'} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="$/acre" value={ppa != null ? formatPPA(ppa) : '—'} />
              <Stat label="Sale date" value={comp.sale_date || '—'} />
            </div>
          </div>

          {/* Transaction parties */}
          {(comp.grantor || comp.grantee) && (
            <div className="border-t border-border pt-3 space-y-1.5 text-xs">
              {comp.grantee && (
                <KeyValue k="Grantee" v={comp.grantee} />
              )}
              {comp.grantor && (
                <KeyValue k="Grantor" v={comp.grantor} />
              )}
            </div>
          )}

          {/* Source */}
          {(comp.source_type || comp.source_url) && (
            <div className="border-t border-border pt-3 text-xs">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Source</div>
              <div className="text-slate-300">
                {comp.source_type === 'listing_url' ? 'Listing URL' : 'PDF appraisal'}
              </div>
              {comp.source_url && (
                <a
                  href={comp.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sage hover:underline break-all text-[11px]"
                >
                  {comp.source_url}
                </a>
              )}
            </div>
          )}

          {/* Pin coordinates (debug useful) */}
          {hasPin && (
            <div className="border-t border-border pt-3 text-xs">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Pin</div>
              <div className="font-mono text-slate-300 text-[11px]">
                {comp.latitude?.toFixed(5)}, {comp.longitude?.toFixed(5)}
              </div>
              {comp.parcel_id && (
                <div className="text-[10px] text-slate-500 mt-0.5">
                  Parcel id(s): {comp.parcel_id}
                </div>
              )}
            </div>
          )}

          {/* Action row. Stages B and C will add Reselect / Draw buttons
              alongside Mark verified. For Stage A, just the verify button. */}
          <div className="border-t border-border pt-3 space-y-2">
            <button
              onClick={handleMarkVerified}
              disabled={saving || !comp.needs_location_review}
              title={
                !comp.needs_location_review
                  ? 'This comp is already verified'
                  : 'Mark this comp as visually verified — clears the gray clock badge'
              }
              className="w-full py-2 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check size={12} />
              {comp.needs_location_review ? 'Mark verified' : 'Verified'}
            </button>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              Editing tools (reselect parcels, draw boundary) are
              coming in the next builds.
            </p>
          </div>
        </div>
      </aside>

      {/* FLOATING AERIAL PANEL — bottom-left corner, shows the source
          aerial extracted at import time. Collapses to a toggle button
          once the comp is verified (the panel is a verification tool;
          once verification is done it's reference-only). */}
      {comp.aerial_image ? (
        <div className="absolute bottom-3 left-3 z-10">
          {aerialCollapsed ? (
            <button
              onClick={() => setAerialCollapsed(false)}
              className="bg-night/90 backdrop-blur border border-border rounded-lg px-3 py-2 text-xs text-slate-300 hover:text-white flex items-center gap-1.5"
              title="Show source aerial"
            >
              <span>📸</span>
              Show aerial
            </button>
          ) : (
            <div className="bg-night/95 backdrop-blur border border-border rounded-lg p-2 shadow-xl">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  Source aerial
                </span>
                <button
                  onClick={() => setAerialCollapsed(true)}
                  className="text-slate-500 hover:text-white text-[10px]"
                  title="Hide"
                >
                  ✕
                </button>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={comp.aerial_image}
                alt="Source aerial"
                className="w-[220px] h-[160px] object-cover rounded border border-border bg-night"
              />
            </div>
          )}
        </div>
      ) : (
        // No saved aerial — show a compact informational chip so the
        // broker knows why the panel isn't here. Common for legacy
        // comps imported before aerial persistence shipped, and for
        // multi-comp PDFs / listing-sourced comps where we don't
        // attribute an aerial.
        <div className="absolute bottom-3 left-3 z-10 bg-night/80 backdrop-blur border border-border rounded-lg px-3 py-2 text-[10px] text-slate-500 flex items-center gap-1.5">
          <ImageOff size={11} />
          No source aerial available
        </div>
      )}
    </div>
  );
}

// ── Small presentational helpers ──────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-bold text-white font-mono">{value}</div>
    </div>
  );
}

function KeyValue({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{k}</div>
      <div className="text-sm text-slate-200">{v}</div>
    </div>
  );
}

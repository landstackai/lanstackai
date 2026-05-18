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
import MapboxDraw from '@mapbox/mapbox-gl-draw';
// Mapbox CSS is loaded globally in src/app/layout.tsx via a <link> tag
// from Mapbox's CDN. No local import needed (and the local import was
// failing on some builds — known Next.js + node_modules CSS interaction
// quirk). MapboxDraw CSS is also loaded globally there.
// @ts-expect-error — turf v6.5 .d.ts not exposed via package "exports"
import * as turf from '@turf/turf';
import { ArrowLeft, Check, AlertTriangle, MapPinOff, Clock, ImageOff, PanelRightClose, PanelRightOpen, Edit3, X, Save, Loader2, Pencil, Search, ChevronDown, ChevronRight, Maximize2 } from 'lucide-react';
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
  description: string | null;
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
  // Full-screen aerial modal — click the floating thumbnail to study the
  // source aerial at full size against the map. Closes on backdrop click,
  // X button, or Escape key.
  const [aerialExpanded, setAerialExpanded] = useState(false);
  // Side panel collapsible — broker can hide to maximize map area, or
  // to make the page usable on narrow viewports / mobile. Default open
  // on first render; toggled via the button on the panel edge.
  const [panelOpen, setPanelOpen] = useState(true);
  // Description collapse — appraisal descriptions run 300-500+ words and
  // would dominate the side panel if always expanded. Default collapsed
  // to a 1-line preview; broker clicks to read in full.
  const [descriptionOpen, setDescriptionOpen] = useState(false);

  // Editing mode for the workspace.
  //   'view'     — read-only (Stage A behavior)
  //   'reselect' — parcel-selection mode (Stage B): broker clicks TxGIO
  //                parcels to add/remove them from the cluster
  //   'draw'     — freehand polygon draw (Stage C): broker draws a new
  //                boundary from scratch via MapboxDraw, for cases where
  //                TxGIO doesn't have the right parcels (subdivisions,
  //                carve-outs, unrecorded boundary changes)
  const [mode, setMode] = useState<'view' | 'reselect' | 'draw'>('view');
  // Parcels currently selected for the cluster (in reselect mode).
  // Stored as a Set of prop_id strings for O(1) toggle lookup.
  const [selectedPropIds, setSelectedPropIds] = useState<Set<string>>(new Set());
  // Cached feature collection of nearby parcels (loaded once when entering
  // reselect mode for the current viewport, then reused for hit-testing
  // and rendering until mode exits). null = not loaded yet.
  const [nearbyParcels, setNearbyParcels] = useState<any[] | null>(null);
  const [loadingParcels, setLoadingParcels] = useState(false);
  const [reselectSaving, setReselectSaving] = useState(false);

  // Owner-search subsystem inside reselect mode. Broker types an owner
  // name (e.g. "Grundhoefer Farms") and we hit /api/parcels-by-owner to
  // find every parcel statewide (filtered by county when known) where
  // owner_name matches. Matched parcels render in sky-blue overlay
  // (distinct from gold selection), are clickable to add to the cluster,
  // and the map auto-fits to their bbox so broker can immediately see
  // them. Lets brokers find parcels the bbox-fetch missed — e.g. when
  // the appraisal pin was wrong and the actual parcels are 5 miles
  // away. Highlighted, not auto-selected: broker still confirms which
  // ones belong by clicking.
  const [ownerQuery, setOwnerQuery] = useState('');
  const [ownerSearching, setOwnerSearching] = useState(false);
  const [ownerMatches, setOwnerMatches] = useState<any[] | null>(null);
  const [ownerSearchError, setOwnerSearchError] = useState<string | null>(null);

  // Draw mode (Stage C). Holds the user's drawn polygon feature once
  // MapboxDraw's 'draw.create' event fires.
  const drawRef = useRef<MapboxDraw | null>(null);
  const [drawnFeature, setDrawnFeature] = useState<any | null>(null);
  const [drawSaving, setDrawSaving] = useState(false);

  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  // Diagnostic: visible on-page error if Mapbox fails to initialize or
  // tile loading errors. Without dev-tools access this is the only way
  // for the broker to communicate WHY the map isn't rendering.
  const [mapError, setMapError] = useState<string | null>(null);

  // ── Fetch the comp by id ────────────────────────────────────────────
  useEffect(() => {
    const compId = params?.compId;
    if (!compId) return;
    let cancelled = false;
    (async () => {
      // Select with source_type/source_url, retry without them if the
      // production schema doesn't have migration 022 applied yet (those
      // columns live on the url-upload-extraction branch which hasn't
      // merged to main). insertCompResilient does the same dance for
      // saveCompSilent — same principle, applied to reads.
      const SELECT_WITH_SOURCE =
        'id, property_name, county, state, acres, sale_price, sale_date, ' +
        'improvements_value, ppa_land_only, price_per_acre, grantor, grantee, ' +
        'address, latitude, longitude, parcel_id, boundary_geojson, aerial_image, ' +
        'needs_extraction_review, needs_location_review, source_type, source_url, confidence, description';
      const SELECT_WITHOUT_SOURCE =
        'id, property_name, county, state, acres, sale_price, sale_date, ' +
        'improvements_value, ppa_land_only, price_per_acre, grantor, grantee, ' +
        'address, latitude, longitude, parcel_id, boundary_geojson, aerial_image, ' +
        'needs_extraction_review, needs_location_review, confidence, description';

      let { data, error } = await supabase
        .from('comps')
        .select(SELECT_WITH_SOURCE)
        .eq('id', compId)
        .maybeSingle();

      // If the source columns don't exist on this Supabase project,
      // retry without them so the page still loads.
      if (error && /source_(type|url)/i.test(error.message)) {
        const retry = await supabase
          .from('comps')
          .select(SELECT_WITHOUT_SOURCE)
          .eq('id', compId)
          .maybeSingle();
        data = retry.data;
        error = retry.error;
      }
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
  // CRITICAL: gated on `comp` being loaded. Previous version ran once on
  // mount with deps=[], but the map container DIV is inside a conditional
  // render that only fires AFTER the comp loads. So mapContainer.current
  // was null at the first useEffect invocation, the function silently
  // early-returned, and never re-ran because of empty deps. Result: black
  // map. Hours of debugging well-spent. Adding `comp` to deps means we
  // try again every time comp changes — first try fails because comp is
  // null, second try succeeds because comp is loaded AND the container
  // is now in the DOM.
  useEffect(() => {
    console.log('[review] init useEffect fired', {
      hasComp: !!comp,
      hasContainer: !!mapContainer.current,
      hasMapAlready: !!map.current,
      hasToken: !!process.env.NEXT_PUBLIC_MAPBOX_TOKEN,
    });

    if (!comp) {
      // Comp not loaded yet — container DIV isn't in the DOM. Wait.
      return;
    }
    if (!mapContainer.current) {
      console.warn('[review] mapContainer.current is null even after comp loaded — this is the real bug');
      setMapError('Map container ref not attached.');
      return;
    }
    if (map.current) {
      console.log('[review] map already initialized, skipping');
      return;
    }

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) {
      const msg = 'NEXT_PUBLIC_MAPBOX_TOKEN is not set in the browser bundle';
      console.error('[review]', msg);
      setMapError(msg);
      return;
    }
    mapboxgl.accessToken = token;

    // Verify container size — Mapbox renders a black canvas when it
    // initializes against a 0×0 container. Logging visible dimensions
    // also helps diagnose layout chain issues from broker-reported bugs.
    const rect = mapContainer.current.getBoundingClientRect();
    console.log('[review] map container size at init:', rect.width, 'x', rect.height);
    if (rect.width < 1 || rect.height < 1) {
      setMapError(`Map container has zero size at init (${rect.width}×${rect.height}px). Layout issue.`);
      return;
    }

    try {
      map.current = new mapboxgl.Map({
        container: mapContainer.current,
        style: MAPBOX_STYLE,
        center: [-99.5, 30.2],
        zoom: 6,
      });
    } catch (e: any) {
      const msg = `Mapbox init threw: ${e?.message || 'unknown'}`;
      console.error('[review]', msg, e);
      setMapError(msg);
      return;
    }

    // Surface runtime errors visibly so broker can SEE why the map
    // failed (token rejection, tile load failure, style fetch failure).
    map.current.on('error', (e: any) => {
      const msg = e?.error?.message || e?.message || 'unknown mapbox error';
      console.error('[review] mapbox error event:', msg, e);
      setMapError((prev) => prev || `Mapbox error: ${msg}`);
    });

    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.current.addControl(new mapboxgl.ScaleControl(), 'bottom-right');
    map.current.once('load', () => {
      console.log('[review] map loaded successfully');
      map.current?.resize();
      setMapLoaded(true);
    });

    const handleWindowResize = () => map.current?.resize();
    window.addEventListener('resize', handleWindowResize);

    return () => {
      window.removeEventListener('resize', handleWindowResize);
      map.current?.remove();
      map.current = null;
    };
    // Depend on comp.id (not full comp object) so the map is only
    // re-initialized when navigating to a DIFFERENT comp. The previous
    // [comp] dep caused a full map teardown+rebuild every time any comp
    // field updated (e.g. on saveReselect, handleMarkVerified), and the
    // reselect-layers cleanup then ran against a destroyed map instance
    // — crashing the page right after Save.
  }, [comp?.id]);

  // Escape-key closes the expanded aerial modal. Mounted once and only
  // fires when the modal is open — cheap, no listener churn from
  // re-binding on every render.
  useEffect(() => {
    if (!aerialExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAerialExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [aerialExpanded]);

  // Resize the map canvas whenever the side panel toggles — flex
  // reflow changes the map column width, but Mapbox can't detect that
  // by itself and renders to the old canvas size, leaving black space
  // on one edge. resize() takes a frame to settle so we use a short
  // delay; matches the CSS transition I'm not using yet but might add.
  useEffect(() => {
    if (!mapLoaded || !map.current) return;
    const t = setTimeout(() => map.current?.resize(), 50);
    return () => clearTimeout(t);
  }, [panelOpen, mapLoaded]);

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

  // ── Reselect mode: setup layers when entering, update data on clicks ─
  //
  // Previous single-effect version recreated ALL layers + sources on every
  // click (because selectedPropIds was in the deps). Mapbox state got into
  // bad states during the cleanup→re-add cycle, producing
  // 'cannot remove source while layer is using it' / 'already a source
  // with ID' errors that crashed the React tree.
  //
  // New two-effect pattern:
  //   Effect 1 (setup/teardown): runs when entering OR exiting reselect
  //     mode. Adds layers on entry, cleans them up on exit via the
  //     returned cleanup function. NO layer thrashing during selection.
  //   Effect 2 (data update): runs when selectedPropIds OR nearbyParcels
  //     changes. Uses setData() on the existing source — pure data swap,
  //     no add/remove churn.

  // Effect 1: layer setup + teardown
  useEffect(() => {
    if (!mapLoaded || !map.current || mode !== 'reselect') return;
    const m = map.current;

    // Defensive cleanup of any leftover layers from a previous mount
    // that didn't tear down cleanly (e.g. fast navigation, error mid-
    // mount). Order matters: layers first, then sources.
    const tryRemove = (kind: 'layer' | 'source', id: string) => {
      try {
        if (kind === 'layer' && m.getLayer(id)) m.removeLayer(id);
        if (kind === 'source' && m.getSource(id)) m.removeSource(id);
      } catch { /* defensive — never let cleanup throw */ }
    };
    const layerIds = [
      'txgio-parcels-raster',
      'nearby-parcels-fill',
      'owner-matches-fill',
      'owner-matches-line',
      'selected-parcels-fill',
      'selected-parcels-line',
    ];
    const sourceIds = ['txgio-parcels-raster', 'nearby-parcels-fill', 'owner-matches-fill', 'selected-parcels-fill'];
    for (const id of layerIds) tryRemove('layer', id);
    for (const id of sourceIds) tryRemove('source', id);

    // Add all sources + layers fresh
    try {
      m.addSource('txgio-parcels-raster', {
        type: 'raster',
        tiles: [
          'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&f=image',
        ],
        tileSize: 512,
        minzoom: 11,
        maxzoom: 19,
      });
      m.addLayer({
        id: 'txgio-parcels-raster',
        type: 'raster',
        source: 'txgio-parcels-raster',
        minzoom: 13,
        paint: {
          'raster-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.75, 15, 0.9, 18, 1] as any,
        },
      });

      m.addSource('nearby-parcels-fill', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: nearbyParcels || [] } as any,
      });
      m.addLayer({
        id: 'nearby-parcels-fill',
        type: 'fill',
        source: 'nearby-parcels-fill',
        paint: { 'fill-color': '#000000', 'fill-opacity': 0 },
      });

      // Owner-search match overlay. Starts EMPTY; the dedicated effect
      // (below) sets data when the broker runs a search. Sky-blue chosen
      // so it's distinct from both selected (gold) and the raster parcel
      // grid — broker can tell at a glance "these are matches, not yet
      // added to the cluster." Click-through is enabled (handler at the
      // bottom of this effect treats the matches layer the same as
      // nearby-parcels-fill — clicking a match toggles it into selection).
      m.addSource('owner-matches-fill', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] } as any,
      });
      m.addLayer({
        id: 'owner-matches-fill',
        type: 'fill',
        source: 'owner-matches-fill',
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.28 },
      });
      m.addLayer({
        id: 'owner-matches-line',
        type: 'line',
        source: 'owner-matches-fill',
        paint: { 'line-color': '#38bdf8', 'line-width': 2, 'line-dasharray': [3, 2] },
      });

      // Selected source starts EMPTY — Effect 2 populates it via setData
      m.addSource('selected-parcels-fill', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] } as any,
      });
      m.addLayer({
        id: 'selected-parcels-fill',
        type: 'fill',
        source: 'selected-parcels-fill',
        paint: { 'fill-color': '#facc15', 'fill-opacity': 0.35 },
      });
      m.addLayer({
        id: 'selected-parcels-line',
        type: 'line',
        source: 'selected-parcels-fill',
        paint: { 'line-color': '#facc15', 'line-width': 2.5 },
      });
    } catch (e: any) {
      console.error('[review] failed to add reselect layers:', e?.message);
    }

    // Click + cursor handlers. Both layers (nearby + owner matches) are
    // clickable — clicking a parcel from either set toggles it into the
    // selected cluster. Owner matches are also added to a merged feature
    // bag at click time so the centroid + acreage math in saveReselect
    // sees the parcel even though it wasn't in the original bbox fetch.
    const handleClick = (e: any) => {
      const features = m.queryRenderedFeatures(e.point, {
        layers: ['nearby-parcels-fill', 'owner-matches-fill'],
      });
      if (features.length === 0) return;
      const propId = features[0].properties?.prop_id;
      if (!propId) return;
      const id = String(propId);
      setSelectedPropIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    };
    const handleEnter = () => {
      if (m.getCanvas()) m.getCanvas().style.cursor = 'crosshair';
    };
    const handleLeave = () => {
      if (m.getCanvas()) m.getCanvas().style.cursor = '';
    };
    m.on('click', 'nearby-parcels-fill', handleClick);
    m.on('mouseenter', 'nearby-parcels-fill', handleEnter);
    m.on('mouseleave', 'nearby-parcels-fill', handleLeave);
    m.on('click', 'owner-matches-fill', handleClick);
    m.on('mouseenter', 'owner-matches-fill', handleEnter);
    m.on('mouseleave', 'owner-matches-fill', handleLeave);

    return () => {
      // The captured `m` reference may point to a destroyed map by the
      // time cleanup runs (e.g. saveReselect updates comp, which used
      // to re-init the map). Wrap EVERY mapbox call in try/catch so a
      // destroyed-map state can't propagate as a React error.
      try { m.off('click', 'nearby-parcels-fill', handleClick); } catch {}
      try { m.off('mouseenter', 'nearby-parcels-fill', handleEnter); } catch {}
      try { m.off('mouseleave', 'nearby-parcels-fill', handleLeave); } catch {}
      try { m.off('click', 'owner-matches-fill', handleClick); } catch {}
      try { m.off('mouseenter', 'owner-matches-fill', handleEnter); } catch {}
      try { m.off('mouseleave', 'owner-matches-fill', handleLeave); } catch {}
      try { if (m.getCanvas()) m.getCanvas().style.cursor = ''; } catch {}
      for (const id of layerIds) tryRemove('layer', id);
      for (const id of sourceIds) tryRemove('source', id);
    };
  }, [mapLoaded, mode, nearbyParcels]); // NOTE: selectedPropIds intentionally excluded

  // Effect 2: update the selected source data when selection changes.
  // Pure data update via setData — no layer add/remove. Runs on every
  // parcel click but is cheap and doesn't churn Mapbox internals.
  // Merges nearbyParcels + ownerMatches when computing the selected
  // feature set so brokers can include owner-matched parcels that
  // weren't in the original bbox fetch.
  useEffect(() => {
    if (!map.current || mode !== 'reselect') return;
    const src = map.current.getSource('selected-parcels-fill') as any;
    if (!src || typeof src.setData !== 'function') return;
    const pool: any[] = [...(nearbyParcels || []), ...(ownerMatches || [])];
    // Dedupe by prop_id — owner search may return parcels already in
    // the bbox-fetch pool, and rendering both would z-fight and double
    // the polygon area in any union math.
    const seen = new Set<string>();
    const selected = pool.filter((f: any) => {
      const id = String(f?.properties?.prop_id ?? '');
      if (!id || !selectedPropIds.has(id)) return false;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    src.setData({ type: 'FeatureCollection', features: selected });
  }, [mode, nearbyParcels, ownerMatches, selectedPropIds]);

  // Effect 3: update the owner-matches source when ownerMatches changes.
  // Same setData pattern as effect 2 — pure data swap, no layer churn.
  useEffect(() => {
    if (!map.current || mode !== 'reselect') return;
    const src = map.current.getSource('owner-matches-fill') as any;
    if (!src || typeof src.setData !== 'function') return;
    src.setData({ type: 'FeatureCollection', features: ownerMatches || [] });
  }, [mode, ownerMatches]);

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

  // ── Stage B: Reselect parcels mode ──────────────────────────────────
  // Broker enters this mode to fix a wrong cluster — click parcels on
  // the map to add/remove them from the selection. Save merges selected
  // polygons via turf.union and writes the new boundary + parcel_id +
  // pin coordinates back to the comp. Cancel exits without DB changes.
  //
  // Initial selection seeds from comp.parcel_id (the comma-separated
  // list of prop_ids stored at save time). If absent, the broker starts
  // with an empty selection and builds it from scratch.

  const enterReselectMode = useCallback(async () => {
    if (!comp || !map.current) return;
    setMode('reselect');

    // Seed selection from existing parcel_id list
    const existingIds = (comp.parcel_id || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setSelectedPropIds(new Set(existingIds));

    // Zoom in if we're too far out — TxGIO's raster parcel tiles have
    // minzoom: 13, so below that the familiar yellow parcel grid won't
    // render. Don't zoom out if broker was already in close.
    if (map.current.getZoom() < 13.5) {
      map.current.easeTo({ zoom: 14, duration: 600 });
      // Wait for the ease to settle before fetching parcels so the
      // bbox covers the right area at the new zoom level.
      await new Promise((r) => setTimeout(r, 650));
    }

    // Fetch nearby parcels for the current viewport. Use a slightly
    // expanded bbox so broker has room to grab adjacent parcels they
    // might want to add to the cluster.
    setLoadingParcels(true);
    try {
      const bounds = map.current.getBounds();
      if (!bounds) throw new Error('map has no bounds');
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      // Expand 20% in each direction for breathing room
      const dLng = (ne.lng - sw.lng) * 0.2;
      const dLat = (ne.lat - sw.lat) * 0.2;
      const bbox = [
        sw.lng - dLng,
        sw.lat - dLat,
        ne.lng + dLng,
        ne.lat + dLat,
      ].map((v) => v.toFixed(6)).join(',');
      const res = await fetch(`/api/parcels-bbox?bbox=${bbox}`);
      if (!res.ok) throw new Error(`parcels-bbox ${res.status}`);
      const data = await res.json();
      const features = Array.isArray(data?.features) ? data.features : [];
      setNearbyParcels(features);
    } catch (e: any) {
      console.error('[review] failed to load nearby parcels:', e);
      toast.error(`Couldn't load nearby parcels: ${e?.message || 'unknown'}`);
      setMode('view');
    } finally {
      setLoadingParcels(false);
    }
  }, [comp]);

  const cancelReselect = useCallback(() => {
    setMode('view');
    setSelectedPropIds(new Set());
    setNearbyParcels(null);
    setOwnerQuery('');
    setOwnerMatches(null);
    setOwnerSearchError(null);
  }, []);

  // Run an owner-name search against TxGIO. Scoped to comp.county when
  // available — drastically narrows results (common surnames otherwise
  // return hundreds of state-wide matches). On success: stash matches +
  // pan/fit the map to their bbox so broker sees what came back.
  const runOwnerSearch = useCallback(async () => {
    const q = ownerQuery.trim();
    if (q.length < 3) {
      setOwnerSearchError('Type at least 3 characters');
      return;
    }
    setOwnerSearchError(null);
    setOwnerSearching(true);
    try {
      const params = new URLSearchParams({ q });
      if (comp?.county) params.set('county', comp.county);
      const res = await fetch(`/api/parcels-by-owner?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Search failed (${res.status})`);
      }
      const data = await res.json();
      const features = Array.isArray(data?.features) ? data.features : [];
      setOwnerMatches(features);
      if (features.length === 0) {
        setOwnerSearchError('No parcels matched that owner in this county');
        return;
      }
      // Auto-fit to the matches' bbox so broker doesn't have to pan
      // looking for them. Padding leaves the side panel + banner room.
      if (map.current) {
        try {
          const fc = { type: 'FeatureCollection', features } as any;
          const bbox = turf.bbox(fc);
          map.current.fitBounds(bbox, { padding: 80, duration: 800, maxZoom: 15 });
        } catch (e) {
          console.warn('[review] failed to fit owner-match bounds:', e);
        }
      }
      toast.success(`Found ${features.length} parcel${features.length === 1 ? '' : 's'}`);
    } catch (e: any) {
      setOwnerSearchError(e?.message || 'Search failed');
      setOwnerMatches(null);
    } finally {
      setOwnerSearching(false);
    }
  }, [ownerQuery, comp?.county]);

  const clearOwnerSearch = useCallback(() => {
    setOwnerQuery('');
    setOwnerMatches(null);
    setOwnerSearchError(null);
  }, []);

  const toggleParcel = useCallback((propId: string) => {
    setSelectedPropIds((prev) => {
      const next = new Set(prev);
      if (next.has(propId)) {
        next.delete(propId);
      } else {
        next.add(propId);
      }
      return next;
    });
  }, []);

  const saveReselect = useCallback(async () => {
    if (!comp || !nearbyParcels || reselectSaving) return;
    if (selectedPropIds.size === 0) {
      toast.error('Select at least one parcel before saving');
      return;
    }
    setReselectSaving(true);
    try {
      // Find selected features — pool both bbox-fetched parcels AND
      // owner-search matches, deduping by prop_id. Without this merge,
      // any parcel the broker added from owner search (which lives in
      // ownerMatches, not nearbyParcels) would be silently dropped at
      // save time even though it appeared selected on the map.
      const pool: any[] = [...nearbyParcels, ...(ownerMatches || [])];
      const seen = new Set<string>();
      const selected = pool.filter((f: any) => {
        const id = String(f?.properties?.prop_id ?? '');
        if (!id || !selectedPropIds.has(id)) return false;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (selected.length === 0) {
        toast.error('Selected parcels not found — try clicking them again');
        setReselectSaving(false);
        return;
      }

      // Merge polygons via turf.union (handles 1 or many)
      let merged: any = selected[0];
      for (let i = 1; i < selected.length; i++) {
        try {
          const u = turf.union(merged, selected[i]);
          if (u) merged = u;
        } catch (e) {
          console.warn('[review] turf.union failed on parcel', i, e);
        }
      }
      const mergedGeometry = merged?.geometry || merged;

      // Compute new pin = centroid of merged polygon
      let pinLat: number | null = null;
      let pinLng: number | null = null;
      try {
        const c = turf.centroid(merged);
        const coords = c?.geometry?.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) {
          pinLng = coords[0];
          pinLat = coords[1];
        }
      } catch {}

      // Comma-separated prop_id list (matches existing convention)
      const newParcelIds = selected
        .map((f: any) => f.properties?.prop_id)
        .filter(Boolean)
        .join(',');

      const { error } = await supabase
        .from('comps')
        .update({
          boundary_geojson: mergedGeometry,
          parcel_id: newParcelIds,
          latitude: pinLat,
          longitude: pinLng,
          // Clear the location-review flag since broker has actively
          // re-picked the boundary — that IS the verification.
          needs_location_review: false,
        })
        .eq('id', comp.id);

      if (error) {
        toast.error(`Save failed: ${error.message}`);
      } else {
        toast.success(`Saved — ${selected.length} parcel${selected.length === 1 ? '' : 's'} merged`);
        setComp({
          ...comp,
          boundary_geojson: mergedGeometry,
          parcel_id: newParcelIds,
          latitude: pinLat,
          longitude: pinLng,
          needs_location_review: false,
        });
        setMode('view');
        setSelectedPropIds(new Set());
        setNearbyParcels(null);
        setOwnerQuery('');
        setOwnerMatches(null);
        setOwnerSearchError(null);
      }
    } finally {
      setReselectSaving(false);
    }
  }, [comp, nearbyParcels, ownerMatches, selectedPropIds, reselectSaving, supabase]);

  // Compute running stats for the reselect side panel
  const reselectStats = (() => {
    if (mode !== 'reselect' || !nearbyParcels) return null;
    const selected = nearbyParcels.filter((f: any) =>
      selectedPropIds.has(String(f.properties?.prop_id))
    );
    const totalAcres = selected.reduce(
      (s: number, f: any) => s + (Number(f.properties?.gis_area) || 0),
      0
    );
    const target = Number(comp?.acres) || 0;
    const delta = target > 0 ? Math.abs(totalAcres - target) / target : null;
    return {
      count: selected.length,
      totalAcres,
      target,
      delta,
    };
  })();

  // ── Stage C: Draw new boundary mode ─────────────────────────────────
  // Broker uses this when TxGIO doesn't have the right parcels at all —
  // subdivisions, carve-outs, easements, unrecorded boundary changes.
  // Uses MapboxDraw plugin (already installed at @mapbox/mapbox-gl-draw).
  //
  // Workflow:
  //   1. Click 'Draw new boundary' → enters draw mode, switches MapboxDraw
  //      to draw_polygon mode (broker clicks vertices, double-click closes)
  //   2. Once polygon complete, draw.create event fires → stash the feature
  //   3. Side panel shows vertex count + area (acres) + Save/Cancel
  //   4. Save → write polygon as boundary_geojson, clear parcel_id (drawn
  //      polygon doesn't correspond to TxGIO parcels), update lat/lng
  //   5. Cancel → discard drawing, return to view mode

  const enterDrawMode = useCallback(() => {
    if (!comp || !map.current) return;
    setMode('draw');
    setDrawnFeature(null);
    // Zoom in if too far out — broker needs accurate vertex placement
    if (map.current.getZoom() < 13.5) {
      map.current.easeTo({ zoom: 14, duration: 600 });
    }
  }, [comp]);

  const cancelDraw = useCallback(() => {
    setMode('view');
    setDrawnFeature(null);
  }, []);

  const saveDraw = useCallback(async () => {
    if (!comp || !drawnFeature || drawSaving) return;
    const geom = drawnFeature.geometry;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) {
      toast.error('Invalid polygon — try drawing again');
      return;
    }

    setDrawSaving(true);
    try {
      // Compute new pin = centroid of drawn polygon
      let pinLat: number | null = null;
      let pinLng: number | null = null;
      try {
        const c = turf.centroid(drawnFeature);
        const coords = c?.geometry?.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) {
          pinLng = coords[0];
          pinLat = coords[1];
        }
      } catch {}

      const { error } = await supabase
        .from('comps')
        .update({
          boundary_geojson: geom,
          // Drawn polygons don't correspond to TxGIO parcels — clear the
          // parcel_id list so it doesn't show stale prop_ids that no
          // longer match the boundary.
          parcel_id: null,
          latitude: pinLat,
          longitude: pinLng,
          // Broker actively drew the boundary — that IS the verification.
          needs_location_review: false,
        })
        .eq('id', comp.id);

      if (error) {
        toast.error(`Save failed: ${error.message}`);
      } else {
        toast.success('Saved — new boundary set');
        setComp({
          ...comp,
          boundary_geojson: geom,
          parcel_id: null,
          latitude: pinLat,
          longitude: pinLng,
          needs_location_review: false,
        });
        setMode('view');
        setDrawnFeature(null);
      }
    } finally {
      setDrawSaving(false);
    }
  }, [comp, drawnFeature, drawSaving, supabase]);

  // Compute area of drawn polygon for side panel stats
  const drawStats = (() => {
    if (mode !== 'draw' || !drawnFeature) return null;
    let acres = 0;
    let vertexCount = 0;
    try {
      acres = turf.area(drawnFeature) / 4046.8564224;
      const coords = drawnFeature.geometry?.coordinates;
      if (coords && coords[0]) {
        // Polygon outer ring; subtract 1 for the closing duplicate vertex
        vertexCount = Math.max(0, coords[0].length - 1);
      }
    } catch {}
    const target = Number(comp?.acres) || 0;
    const delta = target > 0 ? Math.abs(acres - target) / target : null;
    return { acres, vertexCount, target, delta };
  })();

  // Effect: setup MapboxDraw when entering draw mode, tear down on exit.
  // Lives separately from the reselect-layers effect — different control
  // (Mapbox Draw vs raw layers) and different teardown semantics.
  useEffect(() => {
    if (!mapLoaded || !map.current || mode !== 'draw') return;
    const m = map.current;

    // Create a fresh Draw instance each time we enter draw mode. Custom
    // styles match the gold theme used for selected parcels in reselect.
    const GOLD = '#facc15';
    const draw = new MapboxDraw({
      displayControlsDefault: false,
      defaultMode: 'draw_polygon',
      styles: [
        // Polygon fill (active/in-progress)
        { id: 'gl-draw-polygon-fill-active', type: 'fill', filter: ['all', ['==', '$type', 'Polygon'], ['==', 'active', 'true']], paint: { 'fill-color': GOLD, 'fill-opacity': 0.25 } },
        // Polygon stroke (active)
        { id: 'gl-draw-polygon-stroke-active', type: 'line', filter: ['all', ['==', '$type', 'Polygon'], ['==', 'active', 'true']], paint: { 'line-color': GOLD, 'line-width': 2.5, 'line-dasharray': [2, 2] } },
        // Polygon fill (inactive/committed)
        { id: 'gl-draw-polygon-fill-inactive', type: 'fill', filter: ['all', ['==', '$type', 'Polygon'], ['==', 'active', 'false']], paint: { 'fill-color': GOLD, 'fill-opacity': 0.2 } },
        // Polygon stroke (inactive)
        { id: 'gl-draw-polygon-stroke-inactive', type: 'line', filter: ['all', ['==', '$type', 'Polygon'], ['==', 'active', 'false']], paint: { 'line-color': GOLD, 'line-width': 2.5 } },
        // Vertex points (corners)
        { id: 'gl-draw-polygon-vertex', type: 'circle', filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']], paint: { 'circle-radius': 5, 'circle-color': GOLD, 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } },
        // Midpoints (clickable to add new vertex)
        { id: 'gl-draw-polygon-midpoint', type: 'circle', filter: ['all', ['==', 'meta', 'midpoint'], ['==', '$type', 'Point']], paint: { 'circle-radius': 3, 'circle-color': GOLD, 'circle-opacity': 0.7 } },
      ],
    });
    drawRef.current = draw;

    try {
      m.addControl(draw as any, 'top-left');
    } catch (e: any) {
      console.error('[review] failed to add Draw control:', e?.message);
    }

    const handleCreate = (e: any) => {
      const feature = e?.features?.[0];
      if (feature) {
        setDrawnFeature(feature);
        // Switch to simple_select so broker can adjust vertices if needed
        try { draw.changeMode('simple_select', { featureIds: [feature.id] }); } catch {}
      }
    };
    const handleUpdate = (e: any) => {
      const feature = e?.features?.[0];
      if (feature) setDrawnFeature(feature);
    };
    const handleDelete = () => setDrawnFeature(null);

    m.on('draw.create', handleCreate);
    m.on('draw.update', handleUpdate);
    m.on('draw.delete', handleDelete);

    return () => {
      try { m.off('draw.create', handleCreate); } catch {}
      try { m.off('draw.update', handleUpdate); } catch {}
      try { m.off('draw.delete', handleDelete); } catch {}
      try { m.removeControl(draw as any); } catch {}
      drawRef.current = null;
    };
  }, [mapLoaded, mode]);

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
    // Flex root sized to fill the dashboard layout's <main> slot.
    // Use h-full / w-full (NOT h-screen / w-screen) because the
    // dashboard layout already wraps every page in a flex row with
    // the AppNav sidebar — vw/vh would extend past <main>'s edge and
    // clip the right side off-screen. The flex+flex-1+relative+
    // w/h-full pattern is the same one /dashboard/map uses.
    <div className="flex h-full w-full bg-night overflow-hidden">
      {/* MAP COLUMN — relative so absolute overlays (top bar, aerial)
          position against the map area, not the whole viewport. */}
      <div className="flex-1 relative">
        <div ref={mapContainer} className="w-full h-full bg-slate-900" />

        {/* Visible error banner if Mapbox failed to initialize. Without
            this the broker just sees a black map and has no signal as
            to why. Shows the specific error message + a hint about
            where it most likely originates. */}
        {mapError && (
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 mx-auto max-w-md z-20 px-4">
            <div className="bg-red-500/15 border border-red-500/40 rounded-xl p-4 backdrop-blur">
              <div className="text-red-300 font-bold mb-1 flex items-center gap-2">
                <AlertTriangle size={16} />
                Map failed to load
              </div>
              <div className="text-red-200/80 text-xs leading-relaxed">{mapError}</div>
              <div className="text-red-200/60 text-[11px] mt-2 leading-relaxed">
                Check the browser console for more detail. Refresh to retry.
              </div>
            </div>
          </div>
        )}

        {/* Top bar: back link + comp label (absolute over map) */}
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

        {/* Reopen-panel button (only shown when side panel is hidden).
            Top-right of map column so broker can bring details back. */}
        {!panelOpen && (
          <button
            onClick={() => setPanelOpen(true)}
            className="absolute top-3 right-3 z-10 bg-night/90 backdrop-blur border border-border rounded-lg px-3 py-2 text-xs text-slate-300 hover:text-white flex items-center gap-1.5 shadow-xl"
            title="Show details panel"
            aria-label="Show details panel"
          >
            <PanelRightOpen size={14} />
            Details
          </button>
        )}

        {/* FLOATING AERIAL PANEL — bottom-left corner of map area.
            Source aerial extracted at import time. Collapses to a
            toggle button once the comp is verified. Click the thumbnail
            to expand to a full-screen modal for closer inspection. */}
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
                <div className="flex items-center justify-between mb-1.5 gap-3">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Source aerial
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setAerialExpanded(true)}
                      className="text-slate-500 hover:text-white p-0.5"
                      title="Expand to full size"
                      aria-label="Expand aerial"
                    >
                      <Maximize2 size={11} />
                    </button>
                    <button
                      onClick={() => setAerialCollapsed(true)}
                      className="text-slate-500 hover:text-white text-[10px] p-0.5"
                      title="Hide"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {/* Click the thumbnail itself to expand — saves the
                    broker from hunting for the icon. Cursor + title hint
                    that it's clickable. */}
                <button
                  onClick={() => setAerialExpanded(true)}
                  className="block cursor-zoom-in"
                  title="Click to expand"
                  aria-label="Expand source aerial"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={comp.aerial_image}
                    alt="Source aerial"
                    className="w-[220px] h-[160px] object-cover rounded border border-border bg-night"
                  />
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="absolute bottom-3 left-3 z-10 bg-night/80 backdrop-blur border border-border rounded-lg px-3 py-2 text-[10px] text-slate-500 flex items-center gap-1.5">
            <ImageOff size={11} />
            No source aerial available
          </div>
        )}
      </div>

      {/* AERIAL EXPAND MODAL — full-screen backdrop with the aerial sized
          to fit. Renders at the outermost level so it covers BOTH the
          map column and the side panel. Click backdrop or X to close;
          Escape key also closes via the effect at the top of the file. */}
      {aerialExpanded && comp.aerial_image && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => setAerialExpanded(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Source aerial expanded"
        >
          <button
            onClick={(e) => { e.stopPropagation(); setAerialExpanded(false); }}
            className="absolute top-4 right-4 bg-night/80 hover:bg-night border border-border rounded-lg p-2 text-slate-300 hover:text-white"
            title="Close (Esc)"
            aria-label="Close aerial"
          >
            <X size={16} />
          </button>
          <div className="absolute top-4 left-4 bg-night/80 border border-border rounded-lg px-3 py-2 text-xs text-slate-300">
            Source aerial — {label}
          </div>
          {/* Stop propagation on the image itself so clicking it doesn't
              close the modal. Backdrop click still closes. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={comp.aerial_image}
            alt="Source aerial (expanded)"
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl border border-border"
          />
        </div>
      )}

      {/* SIDE PANEL — collapsible. Responsive width: 288px on mobile/small,
          320px on md and up. When closed, hides entirely and the map column
          takes full width (map.resize() runs on toggle to update the canvas).
          A floating reopen button appears in the map column when closed. */}
      {panelOpen && (
      <aside className="w-72 md:w-80 flex-shrink-0 bg-night/95 backdrop-blur border-l border-border overflow-y-auto relative">
        {/* Collapse button (top-right of panel itself) */}
        <button
          onClick={() => setPanelOpen(false)}
          className="absolute top-2 right-2 z-10 p-1 text-slate-500 hover:text-white"
          title="Hide panel"
          aria-label="Hide details panel"
        >
          <PanelRightClose size={16} />
        </button>
        <div className="p-4 space-y-4">
          <div>
            <h1 className="text-base font-bold text-white">{label}</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              {comp.county}{comp.state ? `, ${comp.state}` : ''}
            </p>
          </div>

          {/* RESELECT MODE BANNER — replaces normal action flow with the
              selection controls when broker is actively re-picking parcels.
              Shows running stats so broker can see how acreage compares
              to the appraisal target as they click. */}
          {mode === 'reselect' && (
            <div className="bg-sage/10 border border-sage/40 rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-1.5 text-sage font-bold text-xs uppercase tracking-wide">
                <Edit3 size={12} />
                Reselect mode
              </div>
              {loadingParcels ? (
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <Loader2 size={12} className="animate-spin" />
                  Loading nearby parcels…
                </div>
              ) : (
                <>
                  <p className="text-[11px] text-slate-300 leading-relaxed">
                    Click parcels on the map to add/remove them from the
                    cluster. Selected parcels are gold; unselected are
                    thin gray outlines.
                  </p>

                  {/* OWNER SEARCH — find parcels by appraisal-district
                      owner name (e.g. "Grundhoefer Farms"). Matches
                      render in sky-blue and are clickable to add to the
                      cluster. Scoped to comp.county when known.
                      Useful when the bbox fetch misses parcels — pin
                      was wrong, or the cluster spans further than the
                      initial viewport. */}
                  <div className="border-t border-sage/20 pt-2 space-y-2">
                    <label className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
                      <Search size={10} />
                      Search by owner name
                      {comp?.county && (
                        <span className="text-slate-600 normal-case tracking-normal">
                          · {comp.county} only
                        </span>
                      )}
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={ownerQuery}
                        onChange={(e) => setOwnerQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            runOwnerSearch();
                          }
                        }}
                        placeholder="e.g. Grundhoefer Farms"
                        disabled={ownerSearching}
                        className="flex-1 bg-night/60 border border-border rounded px-2 py-1 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sage/60 disabled:opacity-50"
                      />
                      <button
                        onClick={runOwnerSearch}
                        disabled={ownerSearching || ownerQuery.trim().length < 3}
                        className="px-2.5 bg-sage/20 hover:bg-sage/30 border border-sage/40 text-sage rounded text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
                        title="Search TxGIO by owner"
                      >
                        {ownerSearching ? <Loader2 size={11} className="animate-spin" /> : <Search size={11} />}
                      </button>
                    </div>
                    {ownerSearchError && (
                      <div className="text-[10px] text-red-300 leading-relaxed">{ownerSearchError}</div>
                    )}
                    {ownerMatches && ownerMatches.length > 0 && (
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-sky-300">
                          {ownerMatches.length} match{ownerMatches.length === 1 ? '' : 'es'} (sky blue) — click to add
                        </span>
                        <button
                          onClick={clearOwnerSearch}
                          className="text-slate-500 hover:text-slate-300 underline"
                          title="Clear owner matches"
                        >
                          clear
                        </button>
                      </div>
                    )}
                  </div>

                  {reselectStats && (
                    <div className="text-xs grid grid-cols-2 gap-x-3 gap-y-1 pt-1">
                      <div>
                        <span className="text-slate-500">Selected:</span>{' '}
                        <span className="text-white font-bold font-mono">{reselectStats.count}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Total:</span>{' '}
                        <span className="text-white font-bold font-mono">{reselectStats.totalAcres.toFixed(1)}ac</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Target:</span>{' '}
                        <span className="text-slate-300 font-mono">{reselectStats.target.toFixed(1)}ac</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Δ:</span>{' '}
                        <span className={`font-mono font-bold ${
                          reselectStats.delta == null ? 'text-slate-400' :
                          reselectStats.delta < 0.05 ? 'text-emerald-400' :
                          reselectStats.delta < 0.15 ? 'text-amber-400' :
                          'text-red-400'
                        }`}>
                          {reselectStats.delta != null ? `${(reselectStats.delta * 100).toFixed(1)}%` : '—'}
                        </span>
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      onClick={cancelReselect}
                      disabled={reselectSaving}
                      className="py-2 bg-slate-500/10 hover:bg-slate-500/20 border border-slate-500/30 text-slate-300 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40"
                    >
                      <X size={12} />
                      Cancel
                    </button>
                    <button
                      onClick={saveReselect}
                      disabled={reselectSaving || selectedPropIds.size === 0}
                      className="py-2 bg-sage hover:bg-sage2 text-black rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {reselectSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                      {reselectSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* DRAW MODE BANNER — broker draws a freehand polygon. Click
              to add vertices, double-click to close the polygon. Once
              closed, the drawn feature shows area + vertex count, and
              Save commits it as the new boundary_geojson (clearing
              parcel_id because drawn polygons don't correspond to
              TxGIO parcels). */}
          {mode === 'draw' && (
            <div className="bg-sage/10 border border-sage/40 rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-1.5 text-sage font-bold text-xs uppercase tracking-wide">
                <Pencil size={12} />
                Draw mode
              </div>
              {!drawnFeature ? (
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  Click points on the map to draw the boundary. Double-
                  click to close the polygon. Cancel exits without
                  saving.
                </p>
              ) : (
                <>
                  <p className="text-[11px] text-slate-300 leading-relaxed">
                    Boundary drawn. Drag vertices to adjust, or save to
                    commit as the new comp boundary.
                  </p>
                  {drawStats && (
                    <div className="text-xs grid grid-cols-2 gap-x-3 gap-y-1 pt-1">
                      <div>
                        <span className="text-slate-500">Vertices:</span>{' '}
                        <span className="text-white font-bold font-mono">{drawStats.vertexCount}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Area:</span>{' '}
                        <span className="text-white font-bold font-mono">{drawStats.acres.toFixed(1)}ac</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Target:</span>{' '}
                        <span className="text-slate-300 font-mono">{drawStats.target.toFixed(1)}ac</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Δ:</span>{' '}
                        <span className={`font-mono font-bold ${
                          drawStats.delta == null ? 'text-slate-400' :
                          drawStats.delta < 0.05 ? 'text-emerald-400' :
                          drawStats.delta < 0.15 ? 'text-amber-400' :
                          'text-red-400'
                        }`}>
                          {drawStats.delta != null ? `${(drawStats.delta * 100).toFixed(1)}%` : '—'}
                        </span>
                      </div>
                    </div>
                  )}
                </>
              )}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  onClick={cancelDraw}
                  disabled={drawSaving}
                  className="py-2 bg-slate-500/10 hover:bg-slate-500/20 border border-slate-500/30 text-slate-300 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40"
                >
                  <X size={12} />
                  Cancel
                </button>
                <button
                  onClick={saveDraw}
                  disabled={drawSaving || !drawnFeature}
                  className="py-2 bg-sage hover:bg-sage2 text-black rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {drawSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  {drawSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}

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

          {/* Property description — appraiser remarks, often 200-500
              words. Default collapsed to a 2-line preview because long
              descriptions otherwise dominate the side panel and push
              the action buttons below the fold. Click the header to
              toggle. Whitespace preserved so paragraph breaks survive. */}
          {comp.description && comp.description.trim().length > 0 && (
            <div className="border-t border-border pt-3">
              <button
                onClick={() => setDescriptionOpen((v) => !v)}
                className="w-full flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500 hover:text-slate-300 mb-1.5"
                aria-expanded={descriptionOpen}
                title={descriptionOpen ? 'Collapse description' : 'Expand description'}
              >
                <span>Description</span>
                {descriptionOpen
                  ? <ChevronDown size={12} />
                  : <ChevronRight size={12} />}
              </button>
              {descriptionOpen ? (
                <div className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap max-h-80 overflow-y-auto pr-1">
                  {comp.description}
                </div>
              ) : (
                <div
                  className="text-xs text-slate-400 leading-relaxed line-clamp-2 cursor-pointer hover:text-slate-300"
                  onClick={() => setDescriptionOpen(true)}
                  title="Click to expand"
                >
                  {comp.description}
                </div>
              )}
            </div>
          )}

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

          {/* Action row. Hidden in reselect AND draw modes (those each
              have their own Save/Cancel controls in their banner above). */}
          {mode === 'view' && (
          <div className="border-t border-border pt-3 space-y-2">
            <button
              onClick={enterReselectMode}
              disabled={!map.current}
              title="Re-pick the parcels that make up this comp — click parcels on the map to add/remove"
              className="w-full py-2 bg-sage/10 hover:bg-sage/20 border border-sage/30 text-sage rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Edit3 size={12} />
              Reselect parcels
            </button>
            <button
              onClick={enterDrawMode}
              disabled={!map.current}
              title="Draw a new boundary from scratch — for unrecorded subdivisions, carve-outs, or anything TxGIO doesn't have"
              className="w-full py-2 bg-sage/10 hover:bg-sage/20 border border-sage/30 text-sage rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Pencil size={12} />
              Draw new boundary
            </button>
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
          </div>
          )}
        </div>
      </aside>
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

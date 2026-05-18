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
// Mapbox CSS is loaded globally in src/app/layout.tsx via a <link> tag
// from Mapbox's CDN. No local import needed (and the local import was
// failing on some builds — known Next.js + node_modules CSS interaction
// quirk).
// @ts-expect-error — turf v6.5 .d.ts not exposed via package "exports"
import * as turf from '@turf/turf';
import { ArrowLeft, Check, AlertTriangle, MapPinOff, Clock, ImageOff, PanelRightClose, PanelRightOpen, Edit3, X, Save, Loader2 } from 'lucide-react';
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
  // Side panel collapsible — broker can hide to maximize map area, or
  // to make the page usable on narrow viewports / mobile. Default open
  // on first render; toggled via the button on the panel edge.
  const [panelOpen, setPanelOpen] = useState(true);

  // Editing mode for the workspace. 'view' = read-only (Stage A behavior).
  // 'reselect' = parcel-selection mode (Stage B): broker clicks parcels on
  // the map to add/remove them from the cluster; save merges and writes
  // the new boundary back to the comp.
  const [mode, setMode] = useState<'view' | 'reselect'>('view');
  // Parcels currently selected for the cluster (in reselect mode).
  // Stored as a Set of prop_id strings for O(1) toggle lookup.
  const [selectedPropIds, setSelectedPropIds] = useState<Set<string>>(new Set());
  // Cached feature collection of nearby parcels (loaded once when entering
  // reselect mode for the current viewport, then reused for hit-testing
  // and rendering until mode exits). null = not loaded yet.
  const [nearbyParcels, setNearbyParcels] = useState<any[] | null>(null);
  const [loadingParcels, setLoadingParcels] = useState(false);
  const [reselectSaving, setReselectSaving] = useState(false);

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
        'needs_extraction_review, needs_location_review, source_type, source_url, confidence';
      const SELECT_WITHOUT_SOURCE =
        'id, property_name, county, state, acres, sale_price, sale_date, ' +
        'improvements_value, ppa_land_only, price_per_acre, grantor, grantee, ' +
        'address, latitude, longitude, parcel_id, boundary_geojson, aerial_image, ' +
        'needs_extraction_review, needs_location_review, confidence';

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
  }, [comp]);

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

  // ── Reselect mode: render the TxGIO parcel grid + clickable overlay ─
  //
  // Three layers in reselect mode (added in order, painted bottom→top):
  //   txgio-parcels-raster  — TxGIO's official parcel boundary tiles
  //                            rendered via raster from their ArcGIS
  //                            service. Same layer the main /dashboard/map
  //                            page uses — gives visual consistency with
  //                            the rest of the app (familiar yellow grid).
  //                            Only renders at zoom >= 13.
  //   nearby-parcels-fill   — INVISIBLE fill polygons matching the TxGIO
  //                            geometry. Pure click hit-test surface; the
  //                            raster tiles above provide the visual
  //                            outlines so this layer doesn't need to be
  //                            visible itself.
  //   selected-parcels-fill — Gold-filled selected polygons on top so
  //                            broker sees the current selection state.
  useEffect(() => {
    if (!mapLoaded || !map.current) return;
    const m = map.current;

    // Cleanup. Order matters: REMOVE ALL LAYERS FIRST, then sources.
    // selected-parcels-fill and selected-parcels-line both consume the
    // selected-parcels-fill SOURCE, so we have to drop both layers before
    // Mapbox will let us drop the source. Previous version paired each
    // layer with same-id-source removal one at a time, which tried to
    // remove the shared source while the line layer still referenced it
    // → 'cannot be removed while layer is using it' error → React crash.
    const layersToRemove = [
      'txgio-parcels-raster',
      'nearby-parcels-fill',
      'selected-parcels-fill',
      'selected-parcels-line',
    ];
    for (const id of layersToRemove) {
      if (m.getLayer(id)) m.removeLayer(id);
    }
    const sourcesToRemove = [
      'txgio-parcels-raster',
      'nearby-parcels-fill',
      'selected-parcels-fill',
    ];
    for (const id of sourcesToRemove) {
      if (m.getSource(id)) m.removeSource(id);
    }

    if (mode !== 'reselect' || !nearbyParcels) return;

    // TxGIO raster parcel tiles — matches the visual style on the main
    // map page. Renders parcel outlines as part of the satellite tile
    // image at zoom 13+. Broker sees the familiar yellow parcel grid.
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

    // Invisible fill polygons for click hit-testing. Fill (not line)
    // because Mapbox click events fire when you click ANYWHERE inside
    // the polygon — way more forgiving than requiring pixel-precise
    // clicks on a line. Opacity 0 means the layer is fully transparent
    // (the raster above provides all the visible outlines) but still
    // responds to clicks.
    m.addSource('nearby-parcels-fill', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: nearbyParcels,
      } as any,
    });
    m.addLayer({
      id: 'nearby-parcels-fill',
      type: 'fill',
      source: 'nearby-parcels-fill',
      paint: {
        'fill-color': '#000000',
        'fill-opacity': 0,
      },
    });

    // Render selected parcels as gold fill + thicker outline
    const selectedFeatures = nearbyParcels.filter((f: any) =>
      selectedPropIds.has(String(f.properties?.prop_id))
    );
    m.addSource('selected-parcels-fill', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: selectedFeatures,
      } as any,
    });
    m.addLayer({
      id: 'selected-parcels-fill',
      type: 'fill',
      source: 'selected-parcels-fill',
      paint: {
        'fill-color': '#facc15',
        'fill-opacity': 0.35,
      },
    });
    m.addLayer({
      id: 'selected-parcels-line',
      type: 'line',
      source: 'selected-parcels-fill',
      paint: {
        'line-color': '#facc15',
        'line-width': 2.5,
      },
    });

    // Click handler: toggle the parcel under cursor in the selection set.
    // Hit-test against the INVISIBLE fill layer (not the raster layer
    // above — raster layers don't expose features for click events).
    // Inlined to avoid a useEffect-ordering dependency on toggleParcel.
    const handleClick = (e: any) => {
      const features = m.queryRenderedFeatures(e.point, {
        layers: ['nearby-parcels-fill'],
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
    m.on('click', 'nearby-parcels-fill', handleClick);

    // Crosshair cursor when over a clickable parcel
    const handleEnter = () => {
      if (m.getCanvas()) m.getCanvas().style.cursor = 'crosshair';
    };
    const handleLeave = () => {
      if (m.getCanvas()) m.getCanvas().style.cursor = '';
    };
    m.on('mouseenter', 'nearby-parcels-fill', handleEnter);
    m.on('mouseleave', 'nearby-parcels-fill', handleLeave);

    return () => {
      m.off('click', 'nearby-parcels-fill', handleClick);
      m.off('mouseenter', 'nearby-parcels-fill', handleEnter);
      m.off('mouseleave', 'nearby-parcels-fill', handleLeave);
      if (m.getCanvas()) m.getCanvas().style.cursor = '';
    };
  }, [mapLoaded, mode, nearbyParcels, selectedPropIds]);

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
      // Find selected features
      const selected = nearbyParcels.filter((f: any) =>
        selectedPropIds.has(String(f.properties?.prop_id))
      );
      if (selected.length === 0) {
        toast.error('Selected parcels not found in current viewport');
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
      }
    } finally {
      setReselectSaving(false);
    }
  }, [comp, nearbyParcels, selectedPropIds, reselectSaving, supabase]);

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
            toggle button once the comp is verified. */}
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
          <div className="absolute bottom-3 left-3 z-10 bg-night/80 backdrop-blur border border-border rounded-lg px-3 py-2 text-[10px] text-slate-500 flex items-center gap-1.5">
            <ImageOff size={11} />
            No source aerial available
          </div>
        )}
      </div>

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

          {/* Action row. Hidden in reselect mode (the reselect banner
              above has its own Save/Cancel controls). */}
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
              Drawing a new boundary from scratch comes in the next build.
            </p>
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

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
import { ArrowLeft, Check, AlertTriangle, MapPinOff, Clock, ImageOff, PanelRightClose, PanelRightOpen, Edit3, X, Save, Loader2, Pencil, Search, ChevronDown, ChevronRight, Maximize2, Sparkles, ExternalLink, Link as LinkIcon, Trash2 } from 'lucide-react';
import { formatPPA, formatAcres, formatCurrency } from '@/lib/utils';
import { useMapHover } from '@/lib/hooks/useMapHover';
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
  // Source citations from the AI extraction — where each numeric value
  // came from in the original document. Surfaced in the side panel so
  // brokers can audit the extraction at a glance.
  acres_source: string | null;
  sale_price_source: string | null;
  price_per_acre_source: string | null;
  ppa_land_only_source: string | null;
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

  // ─── Listing URL — AI find + manual paste ──────────────────────────
  // Two ways to attach a listing URL to a comp:
  //   1. Click "Find listing online" → fires /api/comp/[id]/find-listing
  //      → AI searches Land.com/Zillow/Realtor → returns one URL or null
  //      → broker reviews + clicks Save (or Reject + try paste)
  //   2. Paste a URL directly → save
  //
  // Save writes to comp.source_url. The endpoint is conservative — it
  // returns null when it can't find a confident match. That's fine; the
  // broker can retry later or use the paste fallback.
  const [findingListing, setFindingListing] = useState(false);
  const [listingCandidate, setListingCandidate] = useState<{ url: string | null; reason: string | null } | null>(null);
  const [pasteUrlMode, setPasteUrlMode] = useState(false);
  const [pasteUrlInput, setPasteUrlInput] = useState('');
  const [savingListing, setSavingListing] = useState(false);

  // Per-parcel owner + acreage lookup. Fired whenever comp.parcel_id
  // changes (initial load, after a reselect save). One TxGIO/Regrid hit
  // per parcel — typical comps have 1-5 parcels so the fan-out is
  // bounded. Shown in the side panel as a dedicated "Parcels" section
  // so brokers see WHO owns each piece of the cluster without having
  // to enter reselect mode.
  type ParcelDetail = {
    parcel_id: string;
    owner_name: string | null;
    acres: number | null;
    error: boolean;
  };
  const [parcelDetails, setParcelDetails] = useState<ParcelDetail[] | null>(null);
  const [loadingParcelDetails, setLoadingParcelDetails] = useState(false);

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
  // Hover popup — single shared instance via the useMapHover hook.
  // Attached to whichever layer the cursor is over (comp boundary in
  // view mode; nearby/owner-match/selected parcels in reselect mode).
  // Following-cursor label rather than a pinned popup, like id.land's
  // parcel hover. Same hook drives /dashboard/map for consistency.
  const { attach: attachHoverPopup, removePopup: removeHoverPopup } = useMapHover();
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
      // Include the new *_source columns from migration 027. Retry
      // without them if production hasn't applied the migration yet —
      // same defense-in-depth pattern as source_type/source_url.
      const SELECT_WITH_SOURCE =
        'id, property_name, county, state, acres, sale_price, sale_date, ' +
        'improvements_value, ppa_land_only, price_per_acre, grantor, grantee, ' +
        'address, latitude, longitude, parcel_id, boundary_geojson, aerial_image, ' +
        'needs_extraction_review, needs_location_review, source_type, source_url, confidence, description, ' +
        'acres_source, sale_price_source, price_per_acre_source, ppa_land_only_source';
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
      // retry without them so the page still loads. Covers both the
      // source_type/source_url columns (migration 022) and the new
      // *_source citation columns (migration 027).
      if (error && /(source_(type|url)|acres_source|sale_price_source|price_per_acre_source|ppa_land_only_source)/i.test(error.message)) {
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

  // ── Fetch owner names for each parcel in the comp's parcel_id list ──
  // Runs whenever comp.parcel_id changes (initial load + after a
  // reselect save). One /api/parcel?parcel_id=X hit per ID, parallelized.
  // Failures are tolerated — we show "Unknown owner" for any parcel
  // the lookup couldn't resolve, rather than failing the whole panel.
  useEffect(() => {
    const raw = comp?.parcel_id || '';
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      setParcelDetails(null);
      return;
    }
    let cancelled = false;
    setLoadingParcelDetails(true);
    (async () => {
      try {
        const results = await Promise.all(
          ids.map(async (id): Promise<ParcelDetail> => {
            try {
              const r = await fetch(`/api/parcel?parcel_id=${encodeURIComponent(id)}`);
              if (!r.ok) {
                return { parcel_id: id, owner_name: null, acres: null, error: true };
              }
              const data = await r.json();
              return {
                parcel_id: id,
                owner_name: data?.owner_name ?? null,
                acres: typeof data?.acres === 'number' ? data.acres : null,
                error: false,
              };
            } catch {
              return { parcel_id: id, owner_name: null, acres: null, error: true };
            }
          })
        );
        if (!cancelled) setParcelDetails(results);
      } finally {
        if (!cancelled) setLoadingParcelDetails(false);
      }
    })();
    return () => { cancelled = true; };
  }, [comp?.parcel_id]);

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

  // Auto-expand effect moved below enterReselectMode's declaration to
  // avoid the "used before declaration" TS error. See line after the
  // enterReselectMode useCallback for the actual effect.
  const reselectAutoFiredRef = useRef<string | null>(null);

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

    let detachHover: (() => void) | null = null;

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

      // Hover tooltip on the comp boundary — shows total acreage at a
      // glance, like id.land's "Boundary NNN.NN acres" label. Acres can
      // come from either the saved comp.acres OR a fresh turf.area calc
      // on the geometry — prefer comp.acres since that's the broker-
      // verified value, fall back to turf when comp.acres is null (e.g.
      // before extraction-review has been resolved).
      let displayAcres: number | null = null;
      if (typeof comp.acres === 'number' && comp.acres > 0) {
        displayAcres = comp.acres;
      } else {
        try {
          const f: any = { type: 'Feature', properties: {}, geometry: boundary };
          displayAcres = turf.area(f) / 4046.8564224;
        } catch {}
      }
      const acresStr = displayAcres != null
        ? `${displayAcres.toLocaleString(undefined, { maximumFractionDigits: 1 })} ac`
        : '— ac';
      // Generic "Boundary" label (not "Comp boundary") so the same
      // hover treatment is reusable across surfaces — comps today,
      // marketplace listings / CMA subject tracts / drawn boundaries
      // later. The label is the affordance ("this polygon represents a
      // boundary, here are the acres"); the context (which boundary,
      // which property) lives in the side panel and page chrome.
      detachHover = attachHoverPopup(m, 'comp-boundary-fill', () =>
        `<div style="font-weight:700;color:#facc15;">Boundary</div>` +
        `<div style="color:#cbd5e1;">${acresStr}</div>`
      );

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
    } else {
      // Best-effort fallback when comp has NEITHER boundary NOR lat/lng
      // (autoLocate failed during import → broker is here to fix it).
      //
      // Cascade so the broker NEVER lands on the default wide-TX view:
      //   1. Address → street-level zoom (best)
      //   2. County, State → county centroid at zoom 9 (always works)
      //
      // Fire-and-forget; the comp deps already prevent re-firing.
      (async () => {
        const { geocodeBestEffort } = await import('@/lib/utils/geocodePlace');
        const hit = await geocodeBestEffort({
          address: comp.address,
          county: comp.county,
          state: comp.state,
        });
        if (hit && map.current) {
          map.current.flyTo({
            center: [hit.lng, hit.lat],
            zoom: hit.zoom,
            duration: 900,
          });
        }
      })();
    }

    return () => {
      try { detachHover?.(); } catch {}
      try { removeHoverPopup(); } catch {}
    };
  }, [mapLoaded, comp, attachHoverPopup]);

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

    // NOTE: parcel hover tooltips removed per broker feedback - owner
    // names cluttered the map. Brokers find what they need via the
    // owner-search input + the side-panel parcel list; on-map hover
    // doesn't add enough signal to justify the visual noise. The
    // boundary hover ("Boundary · NNN ac" on the gold comp polygon)
    // is kept since it surfaces info that isn't visible elsewhere.

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
      try { removeHoverPopup(); } catch {}
      try { if (m.getCanvas()) m.getCanvas().style.cursor = ''; } catch {}
      for (const id of layerIds) tryRemove('layer', id);
      for (const id of sourceIds) tryRemove('source', id);
    };
  }, [mapLoaded, mode, nearbyParcels, attachHoverPopup]); // NOTE: selectedPropIds intentionally excluded

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
  // Trigger AI find-listing search. Returns either a single URL with a
  // reason, or null (no confident match). Broker decides what to do with
  // the result — Save / Reject / retry later. Conservative endpoint:
  // returns null rather than guessing.
  const handleFindListing = useCallback(async () => {
    if (!comp || findingListing) return;
    setFindingListing(true);
    setListingCandidate(null);
    try {
      const res = await fetch(`/api/comp/${comp.id}/find-listing`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error || 'Find listing failed');
        return;
      }
      setListingCandidate({ url: data?.url ?? null, reason: data?.reason ?? null });
    } catch (e: any) {
      toast.error(e?.message || 'Find listing failed');
    } finally {
      setFindingListing(false);
    }
  }, [comp, findingListing]);

  // Save a URL (from AI find or manual paste) to comp.source_url.
  const handleSaveListingUrl = useCallback(async (url: string) => {
    if (!comp || savingListing) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    // Basic URL shape check; don't be heroic.
    try {
      const u = new URL(trimmed);
      if (!u.protocol.startsWith('http')) throw new Error('not http');
    } catch {
      toast.error('That doesn\'t look like a valid URL');
      return;
    }
    setSavingListing(true);
    try {
      const { error } = await supabase
        .from('comps')
        .update({ source_url: trimmed })
        .eq('id', comp.id);
      if (error) {
        toast.error(`Save failed: ${error.message}`);
        return;
      }
      toast.success('Listing URL saved');
      setComp({ ...comp, source_url: trimmed });
      setListingCandidate(null);
      setPasteUrlMode(false);
      setPasteUrlInput('');
    } finally {
      setSavingListing(false);
    }
  }, [comp, savingListing, supabase]);

  // Clear the saved listing URL (reset to null on the comp).
  const handleRemoveListingUrl = useCallback(async () => {
    if (!comp || savingListing) return;
    if (!confirm('Remove the saved listing URL?')) return;
    setSavingListing(true);
    try {
      const { error } = await supabase
        .from('comps')
        .update({ source_url: null })
        .eq('id', comp.id);
      if (error) {
        toast.error(`Remove failed: ${error.message}`);
        return;
      }
      toast.success('Listing URL removed');
      setComp({ ...comp, source_url: null });
    } finally {
      setSavingListing(false);
    }
  }, [comp, savingListing, supabase]);

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

  // ── Auto-expand Reselect Mode on page load for comps that need
  // location review. The broker came here to FIX the location, so
  // surfacing Reselect Mode immediately saves a click and signals
  // "this is the workflow."
  //
  // Pre-fills the owner search with grantee (the new owner) since
  // grantee is more likely to match current parcel records than grantor.
  // Broker can clear/edit if grantee isn't useful.
  //
  // Guards: only fires once per comp id, only when comp has no lat/lng
  // (otherwise the location is fine and broker is just visiting), and
  // only after the map is loaded so enterReselectMode can do its work.
  // Lives down here (not next to its declaration) because
  // enterReselectMode is declared on line 858+.
  useEffect(() => {
    if (!comp || !mapLoaded) return;
    if (mode !== 'view') return;
    if (reselectAutoFiredRef.current === comp.id) return;
    const needsLocation =
      (comp as any).needs_location_review === true
      || (comp.latitude == null || comp.longitude == null);
    if (!needsLocation) return;
    reselectAutoFiredRef.current = comp.id;
    if (comp.grantee) {
      setOwnerQuery(comp.grantee);
    } else if (comp.grantor) {
      setOwnerQuery(comp.grantor);
    }
    // Wait so the geocode-fallback flyTo settles before Reselect's
    // zoom-to-13.5 logic kicks in (avoids double-animating).
    const t = setTimeout(() => {
      enterReselectMode();
    }, 950);
    return () => clearTimeout(t);
  }, [comp, mapLoaded, mode, enterReselectMode]);

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
      <div className="min-h-screen bg-cream flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-cream border border-beige rounded-xl p-6 text-center">
          <p className="text-red-500 font-bold mb-2">Couldn't load this comp</p>
          <p className="text-sm text-ink-2 mb-4">{loadError}</p>
          <button
            onClick={() => router.push('/dashboard/vault')}
            className="px-4 py-2 bg-olive text-white rounded-lg text-sm font-bold"
          >
            Back to vault
          </button>
        </div>
      </div>
    );
  }
  if (!comp) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center">
        <div className="text-ink-2 text-sm">Loading comp…</div>
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
    <div className="flex h-full w-full bg-cream overflow-hidden">
      {/* MAP COLUMN — relative so absolute overlays (top bar, aerial)
          position against the map area, not the whole viewport. */}
      <div className="flex-1 relative">
        <div ref={mapContainer} className="w-full h-full bg-cream-2" />

        {/* Visible error banner if Mapbox failed to initialize. Without
            this the broker just sees a black map and has no signal as
            to why. Shows the specific error message + a hint about
            where it most likely originates. */}
        {mapError && (
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 mx-auto max-w-md z-20 px-4">
            <div className="bg-red-500/15 border border-red-500/40 rounded-xl p-4 backdrop-blur">
              <div className="text-red-700 font-bold mb-1 flex items-center gap-2">
                <AlertTriangle size={16} />
                Map failed to load
              </div>
              <div className="text-red-700/80 text-xs leading-relaxed">{mapError}</div>
              <div className="text-red-700/60 text-[11px] mt-2 leading-relaxed">
                Check the browser console for more detail. Refresh to retry.
              </div>
            </div>
          </div>
        )}

        {/* Top bar: back link + comp label (absolute over map) */}
        <div className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-cream/90 backdrop-blur border border-beige rounded-lg px-3 py-2 max-w-[40%]">
          <button
            onClick={() => router.push('/dashboard/vault')}
            className="text-ink-2 hover:text-ink flex items-center gap-1 text-xs"
            title="Back to vault"
          >
            <ArrowLeft size={14} />
            Vault
          </button>
          <span className="text-ink-3">·</span>
          <span className="text-sm font-semibold text-ink truncate">{label}</span>
          {comp.needs_location_review && (
            <span className="ml-1 inline-flex items-center gap-1 text-[10px] text-ink-2 bg-cream-2 border border-beige-2 rounded px-1.5 py-0.5">
              <Clock size={10} />
              Needs review
            </span>
          )}
        </div>

        {/* ─── Owner search bar — top-center of map ─────────────────────
            Same look as the vault + map AI search bars (white card, olive
            sparkle, iMessage-blue Ask button). Pre-filled with the comp's
            grantee on page load. Hitting Ask:
              1. Enters Reselect Mode (if not already in it) so the
                 sky-blue parcel highlights render properly
              2. Runs the owner search against TxGIO, scoped to the
                 comp's county
            Brokers will use this constantly — every time autoLocate
            failed, every time they're verifying a multi-parcel ranch.
            Owner name is the highest-signal handle into parcel data,
            so this bar is the workhorse of the page. */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 w-[28rem] max-w-[55%]">
          <div className="relative">
            <Sparkles size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-olive pointer-events-none" />
            <input
              type="text"
              value={ownerQuery}
              onChange={(e) => setOwnerQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (ownerQuery.trim().length < 3) return;
                  if (mode !== 'reselect') {
                    // Enter Reselect first so the search-result layers
                    // (sky-blue parcel highlights) render properly.
                    enterReselectMode();
                    // Give Reselect's parcel-fetch a beat to settle, then
                    // fire the owner search.
                    setTimeout(() => runOwnerSearch(), 900);
                  } else {
                    runOwnerSearch();
                  }
                }
              }}
              placeholder={
                comp?.county
                  ? `Search owners in ${comp.county} County…`
                  : 'Search parcels by owner name…'
              }
              disabled={ownerSearching}
              className="w-full bg-white border border-beige-2 rounded-lg pl-9 pr-24 py-2.5 text-sm text-ink placeholder-ink-3 outline-none focus:border-olive focus:ring-2 focus:ring-olive/20 transition-all shadow-md shadow-black/10 disabled:opacity-60"
            />
            {ownerQuery && !ownerSearching && (
              <button
                onClick={() => { setOwnerQuery(''); clearOwnerSearch(); }}
                title="Clear"
                className="absolute right-[5rem] top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink p-1"
              >
                <X size={13} />
              </button>
            )}
            <button
              onClick={() => {
                if (ownerQuery.trim().length < 3) return;
                if (mode !== 'reselect') {
                  enterReselectMode();
                  setTimeout(() => runOwnerSearch(), 900);
                } else {
                  runOwnerSearch();
                }
              }}
              disabled={ownerSearching || ownerQuery.trim().length < 3}
              title="Search parcels by owner name"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-imsg hover:bg-imsg-2 disabled:opacity-40 disabled:cursor-not-allowed rounded-md text-[12px] font-medium text-white transition-all shadow-sm min-w-[56px] inline-flex items-center justify-center gap-1.5"
            >
              {ownerSearching ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <>
                  <Sparkles size={11} />
                  Ask
                </>
              )}
            </button>
          </div>
          {/* Match-count chip — sits just below the search bar when
              results come back, like the vault's filter chips. Subtle
              olive tint so it's visible without competing. */}
          {ownerMatches && ownerMatches.length > 0 && (
            <div className="mt-1.5 bg-white border border-beige rounded-md px-2.5 py-1.5 flex items-center justify-between gap-2 shadow-sm">
              <p className="text-[11px] text-olive-2 truncate">
                {ownerMatches.length} match{ownerMatches.length === 1 ? '' : 'es'} highlighted on map — click to add
              </p>
              <button
                onClick={clearOwnerSearch}
                className="text-ink-3 hover:text-ink flex-shrink-0"
                title="Clear matches"
              >
                <X size={11} />
              </button>
            </div>
          )}
          {ownerSearchError && (
            <div className="mt-1.5 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5 shadow-sm">
              <p className="text-[11px] text-red-700">{ownerSearchError}</p>
            </div>
          )}
        </div>

        {/* Reopen-panel button (only shown when side panel is hidden).
            Top-right of map column so broker can bring details back. */}
        {!panelOpen && (
          <button
            onClick={() => setPanelOpen(true)}
            className="absolute top-3 right-3 z-10 bg-cream/90 backdrop-blur border border-beige rounded-lg px-3 py-2 text-xs text-ink-2 hover:text-ink flex items-center gap-1.5 shadow-xl"
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
                className="bg-cream/90 backdrop-blur border border-beige rounded-lg px-3 py-2 text-xs text-ink-2 hover:text-ink flex items-center gap-1.5"
                title="Show source aerial"
              >
                <span>📸</span>
                Show aerial
              </button>
            ) : (
              <div className="bg-cream/95 backdrop-blur border border-beige rounded-lg p-2 shadow-xl">
                <div className="flex items-center justify-between mb-1.5 gap-3">
                  <span className="text-[10px] uppercase tracking-wide text-ink-3">
                    Source aerial
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setAerialExpanded(true)}
                      className="text-ink-3 hover:text-ink p-0.5"
                      title="Expand to full size"
                      aria-label="Expand aerial"
                    >
                      <Maximize2 size={11} />
                    </button>
                    <button
                      onClick={() => setAerialCollapsed(true)}
                      className="text-ink-3 hover:text-ink text-[10px] p-0.5"
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
                    className="w-[220px] h-[160px] object-cover rounded border border-beige bg-cream"
                  />
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="absolute bottom-3 left-3 z-10 bg-cream/80 backdrop-blur border border-beige rounded-lg px-3 py-2 text-[10px] text-ink-3 flex items-center gap-1.5">
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
            className="absolute top-4 right-4 bg-cream/80 hover:bg-cream-2 border border-beige rounded-lg p-2 text-ink-2 hover:text-ink"
            title="Close (Esc)"
            aria-label="Close aerial"
          >
            <X size={16} />
          </button>
          <div className="absolute top-4 left-4 bg-cream/80 border border-beige rounded-lg px-3 py-2 text-xs text-ink-2">
            Source aerial — {label}
          </div>
          {/* Stop propagation on the image itself so clicking it doesn't
              close the modal. Backdrop click still closes. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={comp.aerial_image}
            alt="Source aerial (expanded)"
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl border border-beige"
          />
        </div>
      )}

      {/* SIDE PANEL — collapsible. Responsive width: 288px on mobile/small,
          320px on md and up. When closed, hides entirely and the map column
          takes full width (map.resize() runs on toggle to update the canvas).
          A floating reopen button appears in the map column when closed. */}
      {panelOpen && (
      <aside className="w-72 md:w-80 flex-shrink-0 bg-cream/95 backdrop-blur border-l border-beige overflow-y-auto relative">
        {/* Collapse button (top-right of panel itself) */}
        <button
          onClick={() => setPanelOpen(false)}
          className="absolute top-2 right-2 z-10 p-1 text-ink-3 hover:text-ink"
          title="Hide panel"
          aria-label="Hide details panel"
        >
          <PanelRightClose size={16} />
        </button>
        <div className="p-4 space-y-4">
          <div>
            <h1 className="text-base font-semibold text-ink">{label}</h1>
            <p className="text-xs text-ink-2 mt-0.5">
              {comp.county}{comp.state ? `, ${comp.state}` : ''}
            </p>
          </div>

          {/* RESELECT MODE BANNER — replaces normal action flow with the
              selection controls when broker is actively re-picking parcels.
              Shows running stats so broker can see how acreage compares
              to the appraisal target as they click. */}
          {mode === 'reselect' && (
            <div className="bg-olive-tint border border-olive-border rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-1.5 text-olive-2 font-bold text-xs uppercase tracking-wide">
                <Edit3 size={12} />
                Reselect mode
              </div>
              {loadingParcels ? (
                <div className="flex items-center gap-2 text-xs text-ink-2">
                  <Loader2 size={12} className="animate-spin" />
                  Loading nearby parcels…
                </div>
              ) : (
                <>
                  <p className="text-[11px] text-ink-2 leading-relaxed">
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
                  <div className="border-t border-olive-border pt-2 space-y-2">
                    <label className="text-[10px] uppercase tracking-wide text-ink-3 flex items-center gap-1.5">
                      <Search size={10} />
                      Search by owner name
                      {comp?.county && (
                        <span className="text-ink-3 normal-case tracking-normal">
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
                        className="flex-1 bg-cream/60 border border-beige rounded px-2 py-1 text-xs text-ink placeholder-ink-3 focus:outline-none focus:border-olive disabled:opacity-50"
                      />
                      <button
                        onClick={runOwnerSearch}
                        disabled={ownerSearching || ownerQuery.trim().length < 3}
                        className="px-2.5 bg-olive-tint hover:bg-olive-tint border border-olive-border text-olive-2 rounded text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
                        title="Search TxGIO by owner"
                      >
                        {ownerSearching ? <Loader2 size={11} className="animate-spin" /> : <Search size={11} />}
                      </button>
                    </div>
                    {ownerSearchError && (
                      <div className="text-[10px] text-red-700 leading-relaxed">{ownerSearchError}</div>
                    )}
                    {ownerMatches && ownerMatches.length > 0 && (
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-sky-700">
                          {ownerMatches.length} match{ownerMatches.length === 1 ? '' : 'es'} (sky blue) — click to add
                        </span>
                        <button
                          onClick={clearOwnerSearch}
                          className="text-ink-3 hover:text-ink-2 underline"
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
                        <span className="text-ink-3">Selected:</span>{' '}
                        <span className="text-ink font-bold font-mono">{reselectStats.count}</span>
                      </div>
                      <div>
                        <span className="text-ink-3">Total:</span>{' '}
                        <span className="text-ink font-bold font-mono">{reselectStats.totalAcres.toFixed(1)}ac</span>
                      </div>
                      <div>
                        <span className="text-ink-3">Target:</span>{' '}
                        <span className="text-ink-2 font-mono">{reselectStats.target.toFixed(1)}ac</span>
                      </div>
                      <div>
                        <span className="text-ink-3">Δ:</span>{' '}
                        <span className={`font-mono font-bold ${
                          reselectStats.delta == null ? 'text-ink-2' :
                          reselectStats.delta < 0.05 ? 'text-olive' :
                          reselectStats.delta < 0.15 ? 'text-amber-600' :
                          'text-red-500'
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
                      className="py-2 bg-cream-2 hover:bg-cream-2 border border-beige-2 text-ink-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40"
                    >
                      <X size={12} />
                      Cancel
                    </button>
                    <button
                      onClick={saveReselect}
                      disabled={reselectSaving || selectedPropIds.size === 0}
                      className="py-2 bg-olive hover:bg-olive-2 text-white rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
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
            <div className="bg-olive-tint border border-olive-border rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-1.5 text-olive-2 font-bold text-xs uppercase tracking-wide">
                <Pencil size={12} />
                Draw mode
              </div>
              {!drawnFeature ? (
                <p className="text-[11px] text-ink-2 leading-relaxed">
                  Click points on the map to draw the boundary. Double-
                  click to close the polygon. Cancel exits without
                  saving.
                </p>
              ) : (
                <>
                  <p className="text-[11px] text-ink-2 leading-relaxed">
                    Boundary drawn. Drag vertices to adjust, or save to
                    commit as the new comp boundary.
                  </p>
                  {drawStats && (
                    <div className="text-xs grid grid-cols-2 gap-x-3 gap-y-1 pt-1">
                      <div>
                        <span className="text-ink-3">Vertices:</span>{' '}
                        <span className="text-ink font-bold font-mono">{drawStats.vertexCount}</span>
                      </div>
                      <div>
                        <span className="text-ink-3">Area:</span>{' '}
                        <span className="text-ink font-bold font-mono">{drawStats.acres.toFixed(1)}ac</span>
                      </div>
                      <div>
                        <span className="text-ink-3">Target:</span>{' '}
                        <span className="text-ink-2 font-mono">{drawStats.target.toFixed(1)}ac</span>
                      </div>
                      <div>
                        <span className="text-ink-3">Δ:</span>{' '}
                        <span className={`font-mono font-bold ${
                          drawStats.delta == null ? 'text-ink-2' :
                          drawStats.delta < 0.05 ? 'text-olive' :
                          drawStats.delta < 0.15 ? 'text-amber-600' :
                          'text-red-500'
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
                  className="py-2 bg-cream-2 hover:bg-cream-2 border border-beige-2 text-ink-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40"
                >
                  <X size={12} />
                  Cancel
                </button>
                <button
                  onClick={saveDraw}
                  disabled={drawSaving || !drawnFeature}
                  className="py-2 bg-olive hover:bg-olive-2 text-white rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
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
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-700 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
                <MapPinOff size={11} />
                No location
              </span>
            )}
            {comp.needs_extraction_review && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
                <AlertTriangle size={11} />
                Math issue
              </span>
            )}
            {comp.needs_location_review && hasPin && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-ink-2 bg-cream-2 border border-beige-2 rounded px-2 py-1">
                <Clock size={11} />
                Needs review
              </span>
            )}
            {!comp.needs_location_review && !comp.needs_extraction_review && hasPin && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-olive-2 bg-olive-tint border border-olive-border rounded px-2 py-1">
                <Check size={11} />
                Verified
              </span>
            )}
            {comp.source_type === 'listing_url' && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-sky-700 bg-sky-500/10 border border-sky-500/30 rounded px-2 py-1">
                From listing
              </span>
            )}
          </div>

          {/* Headline metrics */}
          <div className="border-t border-beige pt-3 space-y-2 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Acres" value={comp.acres != null ? formatAcres(comp.acres) : '—'} />
              <Stat label="Sale price" value={comp.sale_price != null ? formatCurrency(comp.sale_price) : '—'} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="$/acre" value={ppa != null ? formatPPA(ppa) : '—'} />
              <Stat label="Sale date" value={comp.sale_date || '—'} />
            </div>
          </div>

          {/* Extraction citations — where each numeric field came from in
              the source document. Only shown when at least one citation
              exists. Populated by the AI extraction's cite-the-source
              system (migration 027). Helps brokers spot when the AI
              pulled a value from the wrong table or improvement list. */}
          {(comp.acres_source || comp.sale_price_source || comp.price_per_acre_source || comp.ppa_land_only_source) && (
            <div className="border-t border-beige pt-3 text-xs space-y-1.5">
              <div className="text-[10px] uppercase tracking-wide text-ink-3">Extraction sources</div>
              {comp.acres_source && (
                <div className="text-[10px] leading-relaxed">
                  <span className="text-ink-3">Acres:</span>{' '}
                  <span className="text-ink-2 italic">{comp.acres_source}</span>
                </div>
              )}
              {comp.sale_price_source && (
                <div className="text-[10px] leading-relaxed">
                  <span className="text-ink-3">Sale price:</span>{' '}
                  <span className="text-ink-2 italic">{comp.sale_price_source}</span>
                </div>
              )}
              {comp.price_per_acre_source && (
                <div className="text-[10px] leading-relaxed">
                  <span className="text-ink-3">$/acre:</span>{' '}
                  <span className="text-ink-2 italic">{comp.price_per_acre_source}</span>
                </div>
              )}
              {comp.ppa_land_only_source && comp.ppa_land_only_source !== comp.price_per_acre_source && (
                <div className="text-[10px] leading-relaxed">
                  <span className="text-ink-3">$/ac (land):</span>{' '}
                  <span className="text-ink-2 italic">{comp.ppa_land_only_source}</span>
                </div>
              )}
            </div>
          )}

          {/* Property description — appraiser remarks, often 200-500
              words. Default collapsed to a 2-line preview because long
              descriptions otherwise dominate the side panel and push
              the action buttons below the fold. Click the header to
              toggle. Whitespace preserved so paragraph breaks survive. */}
          {comp.description && comp.description.trim().length > 0 && (
            <div className="border-t border-beige pt-3">
              <button
                onClick={() => setDescriptionOpen((v) => !v)}
                className="w-full flex items-center justify-between text-[10px] uppercase tracking-wide text-ink-3 hover:text-ink-2 mb-1.5"
                aria-expanded={descriptionOpen}
                title={descriptionOpen ? 'Collapse description' : 'Expand description'}
              >
                <span>Description</span>
                {descriptionOpen
                  ? <ChevronDown size={12} />
                  : <ChevronRight size={12} />}
              </button>
              {descriptionOpen ? (
                <div className="text-xs text-ink-2 leading-relaxed whitespace-pre-wrap max-h-80 overflow-y-auto pr-1">
                  {comp.description}
                </div>
              ) : (
                <div
                  className="text-xs text-ink-2 leading-relaxed line-clamp-2 cursor-pointer hover:text-ink-2"
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
            <div className="border-t border-beige pt-3 space-y-1.5 text-xs">
              {comp.grantee && (
                <KeyValue k="Grantee" v={comp.grantee} />
              )}
              {comp.grantor && (
                <KeyValue k="Grantor" v={comp.grantor} />
              )}
            </div>
          )}

          {/* ─── Workflow actions: Reselect + Draw + Verify ─────────────
              Moved here (was at the bottom of the panel) so when a comp
              with needs_location_review lands, the broker sees the
              fix-the-location tools immediately below the transaction
              parties — the natural reading order is subject → financials
              → who-bought-it → "now I'll place the pin." Hidden in
              reselect/draw mode (those each have their own banner). */}
          {mode === 'view' && (
            <div className="border-t border-beige pt-3 space-y-2">
              <button
                onClick={enterReselectMode}
                disabled={!map.current}
                title="Re-pick the parcels that make up this comp — click parcels on the map to add/remove"
                className="w-full py-2 bg-olive-tint hover:bg-olive-tint border border-olive-border text-olive-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Edit3 size={12} />
                Reselect parcels
              </button>
              <button
                onClick={enterDrawMode}
                disabled={!map.current}
                title="Draw a new boundary from scratch — for unrecorded subdivisions, carve-outs, or anything TxGIO doesn't have"
                className="w-full py-2 bg-olive-tint hover:bg-olive-tint border border-olive-border text-olive-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
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
                className="w-full py-2 bg-white hover:bg-cream border border-beige hover:border-beige-2 text-ink-2 hover:text-ink rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Check size={12} />
                {comp.needs_location_review ? 'Mark verified' : 'Verified'}
              </button>
            </div>
          )}

          {/* ─── Source + Listing URL ──────────────────────────────────
              Source type tag (PDF appraisal / Listing URL) + the
              listing-link surface. Always visible so brokers know
              what's attached and have a one-click path to find/save
              a listing for any comp.

              Three states for the listing-link area:
                1. Saved URL exists → show clickable link + remove
                2. Find returned a candidate → show URL + reason +
                   Save / Reject
                3. No link yet → "Find listing online" button (primary)
                   + "Paste URL manually" link (secondary)
              Manual paste always available; broker can override AI
              find at any time. */}
          <div className="border-t border-beige pt-3 text-xs space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wide text-ink-3">Source</div>
              {comp.source_type && (
                <div className="text-[10px] text-ink-2">
                  {comp.source_type === 'listing_url' ? 'Listing URL' : 'PDF appraisal'}
                </div>
              )}
            </div>

            {/* SAVED state — listing URL already on the comp */}
            {comp.source_url && !listingCandidate && !pasteUrlMode && (
              <div className="bg-cream/40 border border-beige rounded-lg p-2 space-y-1.5">
                <a
                  href={comp.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-olive-2 hover:underline break-all text-[11px] flex items-start gap-1.5"
                >
                  <ExternalLink size={11} className="flex-shrink-0 mt-0.5" />
                  <span>{comp.source_url}</span>
                </a>
                <div className="flex items-center gap-2 pt-0.5">
                  <button
                    onClick={handleFindListing}
                    disabled={findingListing}
                    className="text-[10px] text-ink-3 hover:text-olive-2 underline disabled:opacity-50"
                    title="Re-run AI find to look for a better match"
                  >
                    {findingListing ? 'Searching…' : 'Find a better match'}
                  </button>
                  <button
                    onClick={handleRemoveListingUrl}
                    disabled={savingListing}
                    className="text-[10px] text-ink-3 hover:text-red-700 underline disabled:opacity-50 ml-auto"
                    title="Remove the saved listing URL"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}

            {/* AI FOUND state — candidate returned, broker reviews */}
            {listingCandidate && listingCandidate.url && (
              <div className="bg-olive-tint border border-olive-border rounded-lg p-2.5 space-y-2">
                <div className="flex items-center gap-1.5 text-olive-2 text-[10px] font-bold uppercase tracking-wide">
                  <Sparkles size={11} />
                  AI found a match
                </div>
                <a
                  href={listingCandidate.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-olive-2 hover:underline break-all text-[11px] flex items-start gap-1.5"
                >
                  <ExternalLink size={11} className="flex-shrink-0 mt-0.5" />
                  <span>{listingCandidate.url}</span>
                </a>
                {listingCandidate.reason && (
                  <p className="text-[10px] text-ink-2 leading-relaxed">
                    {listingCandidate.reason}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={() => setListingCandidate(null)}
                    disabled={savingListing}
                    className="py-1.5 bg-cream-2 hover:bg-cream-2 border border-beige-2 text-ink-2 rounded text-[10px] font-bold flex items-center justify-center gap-1 disabled:opacity-40"
                  >
                    <X size={10} />
                    Not a match
                  </button>
                  <button
                    onClick={() => handleSaveListingUrl(listingCandidate.url!)}
                    disabled={savingListing}
                    className="py-1.5 bg-olive hover:bg-olive-2 text-white rounded text-[10px] font-bold flex items-center justify-center gap-1 disabled:opacity-40"
                  >
                    {savingListing ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
                    {savingListing ? 'Saving…' : 'Save as listing'}
                  </button>
                </div>
              </div>
            )}

            {/* AI EMPTY state — searched, no confident match */}
            {listingCandidate && !listingCandidate.url && (
              <div className="bg-cream-2 border border-beige-2 rounded-lg p-2.5 space-y-1.5">
                <div className="text-[10px] font-bold text-ink-2 uppercase tracking-wide">
                  No confident match
                </div>
                {listingCandidate.reason && (
                  <p className="text-[10px] text-ink-2 leading-relaxed">
                    {listingCandidate.reason}
                  </p>
                )}
                <p className="text-[10px] text-ink-3">
                  Try again later or paste a URL manually below.
                </p>
                <button
                  onClick={() => setListingCandidate(null)}
                  className="text-[10px] text-ink-3 hover:text-ink-2 underline"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* MANUAL PASTE state — input visible */}
            {pasteUrlMode && (
              <div className="bg-cream/40 border border-beige rounded-lg p-2 space-y-1.5">
                <input
                  type="url"
                  value={pasteUrlInput}
                  onChange={(e) => setPasteUrlInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && pasteUrlInput.trim()) {
                      e.preventDefault();
                      handleSaveListingUrl(pasteUrlInput);
                    }
                    if (e.key === 'Escape') setPasteUrlMode(false);
                  }}
                  placeholder="https://landsofamerica.com/property/…"
                  autoFocus
                  className="w-full bg-cream/60 border border-beige focus:border-olive rounded px-2 py-1 text-[11px] text-ink placeholder-ink-3 outline-none"
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => { setPasteUrlMode(false); setPasteUrlInput(''); }}
                    className="py-1.5 bg-cream-2 hover:bg-cream-2 border border-beige-2 text-ink-2 rounded text-[10px] font-bold"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleSaveListingUrl(pasteUrlInput)}
                    disabled={savingListing || pasteUrlInput.trim().length < 5}
                    className="py-1.5 bg-olive hover:bg-olive-2 text-white rounded text-[10px] font-bold flex items-center justify-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {savingListing ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
                    Save URL
                  </button>
                </div>
              </div>
            )}

            {/* DEFAULT state — Find / Paste actions */}
            {!comp.source_url && !listingCandidate && !pasteUrlMode && (
              <div className="space-y-1.5">
                <button
                  onClick={handleFindListing}
                  disabled={findingListing}
                  // iMessage blue — matches the same "Find listing online"
                  // button on the map page side panel. AI search action =
                  // blue across surfaces.
                  className="w-full py-2 bg-imsg hover:bg-imsg-2 text-white rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 shadow-sm"
                  title="Search Lands of America / LandWatch / Land.com / Realtor / Zillow for a matching listing"
                >
                  {findingListing ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      Searching listing sites…
                    </>
                  ) : (
                    <>
                      <Sparkles size={12} />
                      Find listing online
                    </>
                  )}
                </button>
                <button
                  onClick={() => setPasteUrlMode(true)}
                  className="w-full py-1 text-[10px] text-ink-3 hover:text-ink-2 underline flex items-center justify-center gap-1"
                >
                  <LinkIcon size={10} />
                  or paste URL manually
                </button>
              </div>
            )}

            {/* Search loading message under "Find" button while in flight */}
            {findingListing && !listingCandidate && (
              <p className="text-[10px] text-ink-3 leading-relaxed italic">
                Landstack is searching Lands of America, LandWatch, Land.com, Realtor, and Zillow for a confident match. Conservative on purpose — a missing link is better than a wrong one.
              </p>
            )}
          </div>

          {/* Parcel owners — fetched live from TxGIO/Regrid for each
              prop_id in comp.parcel_id. Shown in view mode AND during
              reselect/draw so the broker can see who owns each piece
              of the cluster without leaving the review page. When
              comp.parcel_id is empty (drawn boundaries), this section
              hides — there's nothing to look up. */}
          {parcelDetails && parcelDetails.length > 0 && (
            <div className="border-t border-beige pt-3">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] uppercase tracking-wide text-ink-3">
                  {parcelDetails.length === 1 ? 'Parcel owner' : `${parcelDetails.length} parcels`}
                </div>
                {loadingParcelDetails && (
                  <Loader2 size={10} className="text-ink-3 animate-spin" />
                )}
              </div>
              <ul className="space-y-1.5">
                {parcelDetails.map((p) => (
                  <li key={p.parcel_id} className="text-xs">
                    <div className="text-ink truncate" title={p.owner_name || 'Unknown owner'}>
                      {p.owner_name || (p.error ? 'Lookup failed' : 'Unknown owner')}
                    </div>
                    <div className="text-[10px] text-ink-3 font-mono flex items-center gap-2">
                      <span>{p.parcel_id}</span>
                      {p.acres != null && (
                        <span>· {p.acres.toFixed(1)}ac</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {loadingParcelDetails && !parcelDetails && (
            <div className="border-t border-beige pt-3 text-[11px] text-ink-3 flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" />
              Loading parcel owners…
            </div>
          )}

          {/* Pin coordinates (debug useful) */}
          {hasPin && (
            <div className="border-t border-beige pt-3 text-xs">
              <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">Pin</div>
              <div className="font-mono text-ink-2 text-[11px]">
                {comp.latitude?.toFixed(5)}, {comp.longitude?.toFixed(5)}
              </div>
            </div>
          )}

          {/* Action row now lives right under Grantor/Grantee — see
              the workflow-actions block above. Intentionally NOT
              duplicated here. */}
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
      <div className="text-[10px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className="text-sm font-bold text-ink font-mono">{value}</div>
    </div>
  );
}

function KeyValue({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-3">{k}</div>
      <div className="text-sm text-ink">{v}</div>
    </div>
  );
}

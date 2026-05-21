'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Comp } from '@/types';
import { formatPPA, formatAcres, formatCurrency, formatDate } from '@/lib/utils';
import { X, Edit, MousePointer, Search, Pencil, Combine, Trash2, ChevronDown, ChevronUp, ArrowRight, ShieldCheck, ShieldAlert, ShieldQuestion, Home, MapPin, FileText, Save, Sparkles, ExternalLink, Globe, Share2, Users, Check, Waves, SlidersHorizontal, Loader2, Link as LinkIcon } from 'lucide-react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
// @ts-expect-error — turf v6.5 .d.ts isn't exposed via package.json "exports"
import * as turf from '@turf/turf';
import CompModal from '@/components/comp/CompModal';
import { FeatureChip, isStrongFeature } from '@/components/comp/FeatureChip';
import {
  ParcelBottomSheet,
  BoundaryCreatedSheet,
  ParcelFeature,
} from '@/components/map/ParcelMerge';
import toast from 'react-hot-toast';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

// Comp-pin accent palette. The pin BASE is always a warm dark surface
// (matches our chrome/overlay system) with a cream-1 text color and a
// thin colored ring per status. The ring color is the only thing that
// varies — so the eye reads "color = status" once and never again.
//
// Status colors moved off the old neon emerald/cyan/orange. Now uses
// the same olive/slate-blue/amber-warm/cream-3 palette as the rest of
// the app — single coherent system across UI chrome + map data.
const STATUS_COLORS: Record<string, string> = {
  Sold: '#A8B57A',      // olive-light — primary "land transaction" color
  Active: '#7B9FCE',    // slate-blue-light — on-market listings
  Pending: '#E8B872',   // amber-warm — under contract
  Withdrawn: '#75716A', // cream-3-text — muted "off-market"
};

// Subject property — warm brick red, distinct from comp pins so it
// reads as "the protagonist." Same convention as Apple Maps drop pins,
// Zillow / Realtor / every real-estate platform.
const SUBJECT_RED = '#C8503F';
const SUBJECT_RED_SOFT = 'rgba(200, 80, 63, 0.35)';

type MapMode = 'view' | 'parcel_select';
type SheetMode = 'none' | 'parcel' | 'selecting' | 'boundary_created';

type GeocodeFeature = {
  id?: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    mapbox_id?: string;
    name?: string;
    full_address?: string;
    place_formatted?: string;
    feature_type?: string;
  };
};

export default function MapPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  // Per-marker hover popups — manually managed (shown on mouseenter, hidden on
  // mouseleave). Tracked separately so we can clean them up on marker rebuild.
  const popupsRef = useRef<mapboxgl.Popup[]>([]);
  // Pin DOM elements keyed by comp id — used by the hover-highlight effect to
  // update styling imperatively without rebuilding markers.
  const markerElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // Comp marker popups keyed by comp id — boundary hover looks the popup
  // up here so hovering a red comp polygon triggers the same rich
  // .comp-hover-popup card that hovering the pin shows. One canonical
  // comp preview, two ways to trigger it; matches the broker's mental
  // model that the boundary IS the comp.
  const compPopupsRef = useRef<Map<string, mapboxgl.Popup>>(new Map());
  const drawRef = useRef<MapboxDraw | null>(null);

  const [comps, setComps] = useState<Comp[]>([]);
  const [selectedComp, setSelectedComp] = useState<Comp | null>(null);
  const [editingComp, setEditingComp] = useState<Comp | null>(null);

  // ─── Listing URL state for Comp Detail panel ───────────────────────
  // Same find/paste/save flow as the review page Source block, scoped
  // to whichever comp is currently selected. Cleared when selectedComp
  // changes (via effect below). Handlers live further down — supabase
  // client is initialized later in the file so the handlers need to
  // sit below that point.
  const [findingListing, setFindingListing] = useState(false);
  const [listingCandidate, setListingCandidate] = useState<{ url: string | null; reason: string | null } | null>(null);
  const [pasteUrlMode, setPasteUrlMode] = useState(false);
  const [pasteUrlInput, setPasteUrlInput] = useState('');
  const [savingListing, setSavingListing] = useState(false);
  // Map style options. Dark was removed per broker feedback (rarely used,
  // wasted real estate). Both remaining options use the same satellite
  // base imagery — "Terrain" is satellite WITH contour lines overlaid
  // (USGS-style brown contours from Mapbox terrain-v2), which is what
  // brokers actually want when they say "terrain view." The previous
  // 'outdoors' style replaced the satellite imagery with topographic
  // rendering, which loses the aerial context brokers rely on.
  const [mapStyle, setMapStyle] = useState<'satellite' | 'terrain'>('satellite');
  // Toggleable raster overlays. Counties always ON now (per broker
  // feedback — they're structural reference data, same as state lines
  // on a US map). Only floodplain has a user-facing toggle.
  // Floodplain defaults OFF — busy at low zoom and most workflows
  // don't need it until the broker focuses on a specific property.
  const [overlays, setOverlays] = useState<{ floodplain: boolean }>({
    floodplain: false,
  });
  // Advanced-filters popover (opens from the sliders icon next to the
  // search bar). Holds the owner-search input + scope filter so we can
  // collapse the two top-of-map search bars into one without losing the
  // owner-search and scope-toggle capabilities.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);

  const [mapMode, setMapMode] = useState<MapMode>('view');
  const [sheetMode, setSheetMode] = useState<SheetMode>('none');
  const [tappedParcel, setTappedParcel] = useState<ParcelFeature | null>(null);
  const [selectedParcels, setSelectedParcels] = useState<ParcelFeature[]>([]);
  const [mergedAcres, setMergedAcres] = useState(0);

  const [showAddModal, setShowAddModal] = useState(false);
  const [prefilledComp, setPrefilledComp] = useState<any>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [askingAi, setAskingAi] = useState(false);

  // Parcel-owner search across TxGIO statewide.
  const [ownerSearchQuery, setOwnerSearchQuery] = useState('');
  const [ownerSearching, setOwnerSearching] = useState(false);
  const [ownerSearchCount, setOwnerSearchCount] = useState<number | null>(null);
  const [ownerSearchTruncated, setOwnerSearchTruncated] = useState(false);
  // When set, only these comp ids are emphasized; non-matching markers dim.
  const [aiHighlightedCompIds, setAiHighlightedCompIds] = useState<Set<string> | null>(null);
  const [aiResultMessage, setAiResultMessage] = useState<string | null>(null);

  const [drawnCount, setDrawnCount] = useState(0);
  const [drawingActive, setDrawingActive] = useState(false);
  // Tracks committed vertex count of the currently in-progress polygon (excludes
  // the cursor-trailing preview point). Used by the drawing UI to show a live
  // count and enable the Finish button only when ≥3 vertices are placed.
  const [drawVertexCount, setDrawVertexCount] = useState(0);
  // Comp pin label mode — toggleable on the map
  const [pinLabelMode, setPinLabelMode] = useState<'ppa' | 'total'>('ppa');
  // Scope filter for the map: All (everything visible) / Company (only
  // is_company_transaction comps) / Mine (only comps created by current user).
  const [mapScope, setMapScope] = useState<'all' | 'company' | 'mine'>('all');
  // County filter — set of normalized county names (e.g. "frio", "real")
  // matched case-insensitively against comp.county. Empty Set = no
  // filter. Populated via the Filters popover, which lists ALL 254 TX
  // counties (not just ones present in the user's data) so brokers can
  // pre-filter to a county before they have comps there — useful for
  // scoping owner searches or planning ahead.
  const [countyFilter, setCountyFilter] = useState<Set<string>>(new Set());
  // Live text filter for the county picker (filters the visible list,
  // not the comps). Typing "frio" reduces 254 to ~1.
  const [countySearch, setCountySearch] = useState('');

  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [detectingBoundary, setDetectingBoundary] = useState(false);
  // Hover-highlighted comp in the workspace panel — drives a pulsing pin
  const [hoveredCompId, setHoveredCompId] = useState<string | null>(null);
  const [expandedCompIds, setExpandedCompIds] = useState<Set<string>>(new Set());
  // CMA per-comp adjustment drafts. Stored on the CMA, never on the comp.
  type CompAdjustment = {
    improvement_value?: number | null;
    improvement_source?: 'appraiser' | 'agent_verified' | 'broker_estimate' | null;
    // Per-comp broker note rendered on both the workspace and the share report.
    // Stored in cmas.comp_adjustments JSONB so it lives at the CMA level
    // (the same comp can carry different notes in different CMAs).
    broker_note?: string | null;
  };
  const [compAdjustmentsDraft, setCompAdjustmentsDraft] = useState<Record<string, CompAdjustment>>({});
  // Per-comp UI state for the inline "Add adjustment" editor
  const [adjustmentEditorOpen, setAdjustmentEditorOpen] = useState<Set<string>>(new Set());
  // Set of comp ids currently waiting on the listing-search response
  const [findingListingFor, setFindingListingFor] = useState<Set<string>>(new Set());
  // Live (transient, not persisted) listing-search results per comp id.
  // Cleared on workspace exit / refresh.
  const [liveListings, setLiveListings] = useState<Record<string, { url: string | null; reason: string | null }>>({});
  // Per-comp "saving / just saved" indicator for the Save-listing button.
  const [savingListingFor, setSavingListingFor] = useState<Set<string>>(new Set());
  const [savedListingFor, setSavedListingFor] = useState<Set<string>>(new Set());
  // Per-comp expand-description toggle (CMA workspace expanded view)
  const [expandedDescriptionIds, setExpandedDescriptionIds] = useState<Set<string>>(new Set());

  // Broker Opinion of Value — supports TWO modes:
  //
  //   'lump_sum' (default) — broker enters a single number for the
  //     property's value via $/Acre OR Total. The two are linked: edit
  //     either, the other auto-calculates from subject acres. Stored
  //     in cmas.broker_opinion_value (total $).
  //
  //   'breakdown' — broker breaks the value into Land + Improvement.
  //     Inputs: Land $/Acre (or Land Total — linked), and a separate
  //     Improvement Value lump sum. Total = Land + Improvement (auto).
  //     Stored in cmas.broker_opinion_land_value (land total $) +
  //     cmas.broker_opinion_improvement_value (improvement $).
  //
  // Flipping modes preserves entered values where possible so brokers
  // don't lose work mid-CMA.
  type BovMode = 'lump_sum' | 'breakdown';
  const [bovMode, setBovMode] = useState<BovMode>('lump_sum');
  // Lump-sum mode inputs (legacy fields, kept for that mode)
  const [bovPpaInput, setBovPpaInput] = useState<string>('');
  const [bovTotalInput, setBovTotalInput] = useState<string>('');
  // Breakdown-mode inputs
  const [bovLandPpaInput, setBovLandPpaInput] = useState<string>('');
  const [bovLandTotalInput, setBovLandTotalInput] = useState<string>('');
  const [bovImprovementInput, setBovImprovementInput] = useState<string>('');
  // Improvement breakdown — optional house itemization (SQFT × $/SQFT)
  // + additional vertical improvements lump. When ANY of these are set,
  // the bovImprovementInput becomes a computed sum: (sqft × ppsf) + addl.
  // Horizontal improvements (fencing, ponds, wells) get baked into the
  // Land $/Acre judgment per real-estate convention.
  const [bovHouseSqftInput, setBovHouseSqftInput] = useState<string>('');
  const [bovHousePpsfInput, setBovHousePpsfInput] = useState<string>('');
  const [bovAddlVerticalInput, setBovAddlVerticalInput] = useState<string>('');
  // UI toggle for the optional house-breakdown expander.
  const [bovHouseBreakdownOpen, setBovHouseBreakdownOpen] = useState(false);

  // Share + collaboration state for the CMA workspace right panel.
  const [shareCopied, setShareCopied] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  type TeamMember = { id: string; full_name: string | null; email: string | null };
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [collaboratorUserIds, setCollaboratorUserIds] = useState<Set<string>>(new Set());
  const [collabLoading, setCollabLoading] = useState(false);
  const [editingBoundaryComp, setEditingBoundaryComp] = useState<Comp | null>(null);
  const [savingBoundary, setSavingBoundary] = useState(false);
  const editingDrawIdRef = useRef<string | null>(null);
  // When set, parcel-select mode + Combine writes to this comp's boundary
  // instead of opening the New Boundary sheet.
  const [reselectingComp, setReselectingComp] = useState<Comp | null>(null);

  // CMA build mode — tap parcels to assemble the subject (merged), then tap
  // comp pins to add comps to the analysis.
  const [cmaMode, setCmaMode] = useState(false);
  const [cmaSubjectParcels, setCmaSubjectParcels] = useState<ParcelFeature[]>([]);
  const [cmaSubjectMeta, setCmaSubjectMeta] = useState<{ name: string; county: string; state: string }>({
    name: '',
    county: '',
    state: 'TX',
  });
  const [cmaCompIds, setCmaCompIds] = useState<string[]>([]);
  const [savingCMA, setSavingCMA] = useState(false);
  const [suggestingComps, setSuggestingComps] = useState(false);
  // When set, saveCMA UPDATEs this row instead of INSERTing a new one
  const [cmaEditingId, setCmaEditingId] = useState<string | null>(null);
  // 'subject' = tapping parcels assembles the subject tract.
  // 'comps'   = subject is locked; tapping comp pins selects comps.
  const [cmaPhase, setCmaPhase] = useState<'subject' | 'comps'>('subject');
  const cmaPhaseRef = useRef<'subject' | 'comps'>('subject');
  useEffect(() => { cmaPhaseRef.current = cmaPhase; }, [cmaPhase]);

  // CMA workspace view: when ?cma=<id> is in the URL, the page filters to
  // only that CMA's subject + selected comps and shows a workspace banner.
  const [viewingCMA, setViewingCMA] = useState<any | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  // Reset expansion whenever a different comp is selected
  useEffect(() => { setDescriptionExpanded(false); }, [selectedComp?.id]);

  // Reset Find Listing state whenever a different comp is selected.
  // Otherwise a candidate found for comp A would appear when opening
  // comp B, which is confusing and a possible save-to-wrong-comp bug.
  useEffect(() => {
    setListingCandidate(null);
    setPasteUrlMode(false);
    setPasteUrlInput('');
    setFindingListing(false);
  }, [selectedComp?.id]);

  // Rule: description's acreage is authoritative. When viewing a comp the
  // current user owns, if the description names a different acreage than
  // what's saved (beyond rounding), reconcile silently — write the
  // description value to the DB so all downstream views are consistent.
  useEffect(() => {
    if (!selectedComp || !currentUserId) return;
    if (selectedComp.created_by !== currentUserId) return;
    const desc = selectedComp.description || '';
    const m = desc.match(/([0-9][0-9,]*(?:\.\d+)?)\s*[-]?\s*(?:acres?|ac)\b/i);
    if (!m) return;
    const fromDesc = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(fromDesc)) return;
    const saved = selectedComp.acres || 0;
    if (Math.abs(fromDesc - saved) <= 0.5) return; // already matches (within rounding)
    let cancelled = false;
    (async () => {
      const { error } = await supabase
        .from('comps')
        .update({ acres: fromDesc })
        .eq('id', selectedComp.id);
      if (cancelled || error) return;
      toast(`Acres reconciled to ${fromDesc.toLocaleString()} from description`, {
        icon: '🔁', duration: 2500,
      });
      await fetchComps();
    })();
    return () => { cancelled = true; };
  }, [selectedComp?.id, currentUserId]);

  const supabase = createClient();
  const searchParams = useSearchParams();
  const router = useRouter();

  // ─── Find Listing handlers (defined after `supabase` is initialized) ──
  // Trigger AI find-listing for the currently-selected comp. Returns one
  // URL or null (the endpoint is conservative — a missing link is
  // better than a wrong one).
  const handleFindListing = useCallback(async () => {
    if (!selectedComp || findingListing) return;
    setFindingListing(true);
    setListingCandidate(null);
    try {
      const res = await fetch(`/api/comp/${selectedComp.id}/find-listing`, { method: 'POST' });
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
  }, [selectedComp, findingListing]);

  // Persist a URL (from AI find or manual paste) to comp.source_url.
  const handleSaveListingUrl = useCallback(async (url: string) => {
    if (!selectedComp || savingListing) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    try {
      const u = new URL(trimmed);
      if (!u.protocol.startsWith('http')) throw new Error('not http');
    } catch {
      toast.error("That doesn't look like a valid URL");
      return;
    }
    setSavingListing(true);
    try {
      const { error } = await supabase
        .from('comps')
        .update({ source_url: trimmed })
        .eq('id', selectedComp.id);
      if (error) {
        toast.error(`Save failed: ${error.message}`);
        return;
      }
      toast.success('Listing URL saved');
      setSelectedComp({ ...selectedComp, source_url: trimmed } as Comp);
      setComps((prev) =>
        prev.map((c) => (c.id === selectedComp.id ? { ...c, source_url: trimmed } : c))
      );
      setListingCandidate(null);
      setPasteUrlMode(false);
      setPasteUrlInput('');
    } finally {
      setSavingListing(false);
    }
  }, [selectedComp, savingListing, supabase]);

  // Clear the saved listing URL (set to null on the comp).
  const handleRemoveListingUrl = useCallback(async () => {
    if (!selectedComp || savingListing) return;
    if (!confirm('Remove the saved listing URL?')) return;
    setSavingListing(true);
    try {
      const { error } = await supabase
        .from('comps')
        .update({ source_url: null })
        .eq('id', selectedComp.id);
      if (error) {
        toast.error(`Remove failed: ${error.message}`);
        return;
      }
      toast.success('Listing URL removed');
      setSelectedComp({ ...selectedComp, source_url: null } as Comp);
      setComps((prev) =>
        prev.map((c) => (c.id === selectedComp.id ? { ...c, source_url: null } : c))
      );
    } finally {
      setSavingListing(false);
    }
  }, [selectedComp, savingListing, supabase]);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!cancelled) setCurrentUserId(user?.id ?? null);
    });
    return () => { cancelled = true; };
  }, [supabase]);

  // Both options share the same satellite base — "Terrain" layers contour
  // lines on top via the overlay-ensure effect below. No setStyle() needed
  // when switching, which avoids the basemap-switch wipes-custom-layers
  // problem the old multi-style switcher created.
  const STYLE_URLS = {
    satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
    terrain: 'mapbox://styles/mapbox/satellite-streets-v12',
  };

  const resetParcelState = useCallback(() => {
    setSelectedParcels([]);
    setTappedParcel(null);
    setMergedAcres(0);
    setMapMode('view');
    setReselectingComp(null);
    setSettingSubjectForCma(null);
    if (map.current && mapLoaded) {
      try {
        const src1 = map.current.getSource('selected-parcels') as mapboxgl.GeoJSONSource;
        const src2 = map.current.getSource('merged-boundary') as mapboxgl.GeoJSONSource;
        const src3 = map.current.getSource('tapped-parcel-highlight') as mapboxgl.GeoJSONSource;
        if (src1) src1.setData({ type: 'FeatureCollection', features: [] });
        if (src2) src2.setData({ type: 'FeatureCollection', features: [] });
        if (src3) src3.setData({ type: 'FeatureCollection', features: [] });
      } catch (e) {}
    }
  }, [mapLoaded]);

  // Push the tapped parcel's geometry into the highlight layer so the user
  // can see which parcel they just clicked. Cleared when tappedParcel goes
  // back to null (sheet closed, different workflow started, etc.).
  useEffect(() => {
    if (!map.current || !mapLoaded) return;
    const src = map.current.getSource('tapped-parcel-highlight') as mapboxgl.GeoJSONSource | undefined;
    if (!src) return;
    if (tappedParcel?.geometry) {
      src.setData({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: {}, geometry: tappedParcel.geometry as any },
        ],
      });
    } else {
      src.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [tappedParcel, mapLoaded]);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: STYLE_URLS.satellite,
      center: [-99.5, 30.2],
      zoom: 6,
    });

    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.current.addControl(new mapboxgl.ScaleControl(), 'bottom-right');

    // Drawing tools (polygon, line) — UI is custom; no built-in controls.
    // Custom styles override MapboxDraw's default orange palette with the
    // app's sage green, and use thicker strokes so the in-progress polygon
    // is easy to see on satellite imagery.
    const DRAW_GREEN = '#34d399';
    const DRAW_GREEN_FILL_OPACITY = 0.22;
    const DRAW_LINE_WIDTH = 4;
    const DRAW_VERTEX_RADIUS = 7;
    drawRef.current = new MapboxDraw({
      displayControlsDefault: false,
      defaultMode: 'simple_select',
      styles: [
        // Polygon fill — active (being drawn/edited) AND inactive (just drawn)
        {
          id: 'gl-draw-polygon-fill',
          type: 'fill',
          filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
          paint: { 'fill-color': DRAW_GREEN, 'fill-outline-color': DRAW_GREEN, 'fill-opacity': DRAW_GREEN_FILL_OPACITY },
        },
        // Polygon outer ring stroke
        {
          id: 'gl-draw-polygon-stroke',
          type: 'line',
          filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': DRAW_GREEN, 'line-width': DRAW_LINE_WIDTH },
        },
        // The "rubber band" line that follows the cursor while drawing
        {
          id: 'gl-draw-line',
          type: 'line',
          filter: ['all', ['==', '$type', 'LineString'], ['!=', 'mode', 'static']],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': DRAW_GREEN, 'line-width': DRAW_LINE_WIDTH, 'line-dasharray': [2, 2] },
        },
        // Vertex halo (white ring around each corner — improves contrast on satellite)
        {
          id: 'gl-draw-polygon-and-line-vertex-stroke',
          type: 'circle',
          filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point'], ['!=', 'mode', 'static']],
          paint: { 'circle-radius': DRAW_VERTEX_RADIUS + 2, 'circle-color': '#ffffff' },
        },
        // Vertex dot (filled green)
        {
          id: 'gl-draw-polygon-and-line-vertex',
          type: 'circle',
          filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point'], ['!=', 'mode', 'static']],
          paint: { 'circle-radius': DRAW_VERTEX_RADIUS, 'circle-color': DRAW_GREEN },
        },
        // Midpoint marker (smaller, hollow — clicking these adds a new vertex)
        {
          id: 'gl-draw-polygon-midpoint',
          type: 'circle',
          filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']],
          paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': DRAW_GREEN, 'circle-stroke-width': 2 },
        },
      ],
    });
    map.current.addControl(drawRef.current as unknown as mapboxgl.IControl);

    const updateDrawnCount = () => {
      setDrawnCount(drawRef.current?.getAll().features.length || 0);
    };
    // After polygon is finished drawing, immediately switch to direct_select
    // so the user can adjust vertices but cannot drag the whole shape. We
    // never want simple_select to be active with a polygon present.
    map.current.on('draw.create', (e: any) => {
      updateDrawnCount();
      const newId = e?.features?.[0]?.id;
      if (newId) {
        // Tiny delay so MapboxDraw finishes its internal post-create state
        // transition before we override it.
        setTimeout(() => {
          if (drawRef.current && drawRef.current.get(newId)) {
            drawRef.current.changeMode('direct_select', { featureId: newId });
          }
        }, 0);
      }
    });
    map.current.on('draw.update', updateDrawnCount);
    map.current.on('draw.delete', updateDrawnCount);
    map.current.on('draw.modechange', (e: any) => {
      const isDrawing = typeof e.mode === 'string' && e.mode.startsWith('draw_');
      setDrawingActive(isDrawing);
      if (!isDrawing) setDrawVertexCount(0);

      // Block simple_select while a polygon exists — it allows whole-shape
      // dragging which we never want. Auto-bounce back to direct_select.
      // If no polygon exists (e.g. after Combine emptied MapboxDraw), allow
      // simple_select since there's nothing to mis-drag anyway.
      if (e.mode === 'simple_select') {
        const features = drawRef.current?.getAll().features || [];
        const polygon = features.find(
          (f: any) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
        );
        if (polygon && polygon.id) {
          setTimeout(() => {
            if (drawRef.current?.getMode() === 'simple_select') {
              try {
                // Cast: MapboxDraw's TS types are over-narrow on the overload
                // for changeMode('direct_select', {featureId}) — runtime is fine.
                (drawRef.current as any).changeMode('direct_select', { featureId: polygon.id });
              } catch {}
            }
          }, 0);
        }
      }
    });
    // Live vertex count during draw_polygon. draw.render fires on every frame
    // while drawing, so we read the in-progress polygon and count committed
    // vertices (excluding the trailing preview point that follows the cursor).
    map.current.on('draw.render', () => {
      const features = drawRef.current?.getAll().features || [];
      const inProgress = features.find(
        (f: any) => f.geometry?.type === 'Polygon' && Array.isArray(f.geometry?.coordinates?.[0])
      );
      if (!inProgress) {
        setDrawVertexCount(0);
        return;
      }
      const ring = (inProgress.geometry as any).coordinates[0] as Array<[number, number]>;
      // Polygon coords include a duplicate closing point. While drawing, the
      // last point is also the preview cursor. So committed unique = length - 2,
      // floored at 0. Once polygon is closed, count is the actual vertex count.
      const committed = Math.max(0, ring.length - 2);
      setDrawVertexCount(committed);
    });

    map.current.on('load', () => {
      // TxGIO statewide TX parcel boundaries (dynamic ArcGIS export → raster tiles)
      map.current!.addSource('txgio-parcels', {
        type: 'raster',
        tiles: [
          'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&f=image',
        ],
        tileSize: 512,
        minzoom: 11,
        maxzoom: 19,
        attribution: 'Parcels © TxGIO + TX Appraisal Districts',
      });
      map.current!.addLayer({
        id: 'txgio-parcels-layer',
        type: 'raster',
        source: 'txgio-parcels',
        minzoom: 13,
        paint: {
          'raster-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.75, 15, 0.9, 18, 1],
        },
      });

      // ── County + floodplain overlays added LATER via the
      // ensureOverlayLayers effect (not in the 'load' handler) so they
      // survive basemap switches — setStyle() wipes all custom layers,
      // and the effect re-adds them whenever mapLoaded flips to true
      // (initial load + after every style.load). See effect below.

      // CMA subject boundary (only populated in workspace view)
      map.current!.addSource('cma-subject', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      // Subject boundary uses the warm brick red SUBJECT_RED so it
      // matches the subject pin marker — broker reads "red = the one
      // we're evaluating" across the boundary, the pin, the right-panel
      // badge. Single visual identity.
      map.current!.addLayer({
        id: 'cma-subject-fill',
        type: 'fill',
        source: 'cma-subject',
        paint: { 'fill-color': '#C8503F', 'fill-opacity': 0.18 },
      });
      map.current!.addLayer({
        id: 'cma-subject-halo',
        type: 'line',
        source: 'cma-subject',
        paint: {
          'line-color': '#C8503F',
          'line-width': 7,
          'line-opacity': 0.35,
          'line-blur': 1.5,
        },
      });
      map.current!.addLayer({
        id: 'cma-subject-line',
        type: 'line',
        source: 'cma-subject',
        paint: { 'line-color': '#C8503F', 'line-width': 3, 'line-opacity': 1 },
      });

      // Saved comp boundaries (rendered from comps.boundary_geojson)
      map.current!.addSource('comp-boundaries', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.current!.addLayer({
        id: 'comp-boundary-fill',
        type: 'fill',
        source: 'comp-boundaries',
        paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.14 },
      });
      // Halo (wider, semi-transparent red — gives the line a glow on satellite)
      map.current!.addLayer({
        id: 'comp-boundary-halo',
        type: 'line',
        source: 'comp-boundaries',
        paint: {
          'line-color': '#ef4444',
          'line-width': 9,
          'line-opacity': 0.4,
          'line-blur': 1.5,
        },
      });
      map.current!.addLayer({
        id: 'comp-boundary-line',
        type: 'line',
        source: 'comp-boundaries',
        paint: { 'line-color': '#ef4444', 'line-width': 5, 'line-opacity': 1 },
      });

      // Selected parcels layer
      map.current!.addSource('selected-parcels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.current!.addLayer({
        id: 'selected-parcel-fill',
        type: 'fill',
        source: 'selected-parcels',
        paint: { 'fill-color': '#34d399', 'fill-opacity': 0.18 },
      });
      map.current!.addLayer({
        id: 'selected-parcel-outline',
        type: 'line',
        source: 'selected-parcels',
        paint: { 'line-color': '#34d399', 'line-width': 4 },
      });

      // Owner-search results. When the user searches "Smith Family Ranch"
      // we light up every parcel TxGIO returns as a match. Magenta so it
      // stays distinct from cyan tap, green selection, red saved comps.
      map.current!.addSource('owner-search-results', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.current!.addLayer({
        id: 'owner-search-fill',
        type: 'fill',
        source: 'owner-search-results',
        paint: { 'fill-color': '#e879f9', 'fill-opacity': 0.18 },
      });
      map.current!.addLayer({
        id: 'owner-search-halo',
        type: 'line',
        source: 'owner-search-results',
        paint: {
          'line-color': '#e879f9',
          'line-width': 9,
          'line-opacity': 0.45,
          'line-blur': 1.5,
        },
      });
      map.current!.addLayer({
        id: 'owner-search-line',
        type: 'line',
        source: 'owner-search-results',
        paint: { 'line-color': '#e879f9', 'line-width': 3.5 },
      });

      // Single-tap parcel highlight. When the user clicks a parcel to view
      // its info (no selection / CMA / drawing flow active), we briefly
      // light up the polygon so they can see what they clicked. Cyan to
      // stay distinct from saved-comp red and multi-select green.
      map.current!.addSource('tapped-parcel-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.current!.addLayer({
        id: 'tapped-parcel-highlight-fill',
        type: 'fill',
        source: 'tapped-parcel-highlight',
        paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.2 },
      });
      map.current!.addLayer({
        id: 'tapped-parcel-highlight-halo',
        type: 'line',
        source: 'tapped-parcel-highlight',
        paint: {
          'line-color': '#22d3ee',
          'line-width': 8,
          'line-opacity': 0.5,
          'line-blur': 1.5,
        },
      });
      map.current!.addLayer({
        id: 'tapped-parcel-highlight-line',
        type: 'line',
        source: 'tapped-parcel-highlight',
        paint: { 'line-color': '#22d3ee', 'line-width': 3.5 },
      });

      // Merged boundary layer
      map.current!.addSource('merged-boundary', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.current!.addLayer({
        id: 'merged-fill',
        type: 'fill',
        source: 'merged-boundary',
        paint: { 'fill-color': '#34d399', 'fill-opacity': 0.22 },
      });
      // Halo for consistency with saved (red) boundaries — adds a soft green
      // glow that makes the boundary readable on busy satellite imagery.
      map.current!.addLayer({
        id: 'merged-halo',
        type: 'line',
        source: 'merged-boundary',
        paint: {
          'line-color': '#34d399',
          'line-width': 9,
          'line-opacity': 0.4,
          'line-blur': 1.5,
        },
      });
      map.current!.addLayer({
        id: 'merged-outline',
        type: 'line',
        source: 'merged-boundary',
        paint: { 'line-color': '#34d399', 'line-width': 5 },
      });

      setMapLoaded(true);
    });

    // Map click — try county CAD vector layers first, then TxGIO via /api/parcel
    map.current.on('click', async (e) => {
      const { lng, lat } = e.lngLat;
      let parcel: ParcelFeature | null = null;

      if (map.current) {
        // Check Blanco CAD first (highest quality), then statewide TxGIO vector
        const blancoHits = map.current.queryRenderedFeatures(e.point, {
          layers: ['cad-blanco-fill'],
        });
        if (blancoHits.length > 0) {
          const f = blancoHits[0];
          const p: any = f.properties || {};
          const acres = parseFloat(p.legal_acreage);
          const addressParts = [
            p.situs_num,
            p.situs_street_prefx,
            p.situs_street,
            p.situs_street_sufix,
          ].map(s => (s == null ? '' : String(s).trim())).filter(Boolean);
          const street = addressParts.join(' ').trim();
          const fullAddress = [street, p.situs_city].filter(Boolean).join(', ').trim() || null;
          parcel = {
            parcel_id: String(p.prop_id || p.prop_id_text || f.id || ''),
            owner_name: p.file_as_name || null,
            acres: Number.isFinite(acres) ? acres : null,
            address: fullAddress,
            county: 'Blanco',
            state: 'TX',
            latitude: lat,
            longitude: lng,
            geometry: f.geometry as any,
          };
        } else {
          const txgioHits = map.current.queryRenderedFeatures(e.point, {
            layers: ['txgio-bbox-fill'],
          });
          if (txgioHits.length > 0) {
            const f = txgioHits[0];
            const p: any = f.properties || {};
            const acres = parseFloat(p.gis_area);
            parcel = {
              parcel_id: String(p.prop_id || ''),
              owner_name: p.owner_name || null,
              acres: Number.isFinite(acres) ? acres : null,
              address: null,
              county: p.county ? String(p.county).replace(/\b\w/g, c => c.toUpperCase()) : null,
              state: 'TX',
              latitude: lat,
              longitude: lng,
              geometry: f.geometry as any,
            };
          }
        }
      }

      let lookupError: string | null = null;
      if (!parcel) {
        // TxGIO can be slow (10-25s). Show a loading toast so the click
        // doesn't feel dead, and dismiss it whether the request succeeds or fails.
        const loadingId = toast.loading('Looking up parcel…', { duration: 30000 });
        try {
          const res = await fetch(`/api/parcel?lat=${lat}&lng=${lng}`);
          const data = await res.json().catch(() => null);
          if (res.ok && data && data.parcel_id) {
            parcel = data;
            parcel!.latitude = lat;
            parcel!.longitude = lng;
          } else if (data?.reason) {
            lookupError = data.reason;
          }
        } catch (e: any) {
          lookupError = e?.message || 'network';
        }
        toast.dismiss(loadingId);
      }

      if (!parcel) {
        if (lookupError && lookupError !== 'no_match') {
          console.warn('[parcel-click] lookup failed:', lookupError);
          toast(`Parcel lookup failed: ${lookupError}`, { icon: '⚠️', duration: 4000 });
        } else {
          toast('No parcel data at this point', { icon: '🗺️', duration: 1800 });
        }
        return;
      }

      // CMA mode, subject phase: tapping a parcel toggles it into the subject.
      // After Lock Subject, we ignore parcel taps and only react to comp pins.
      if (cmaModeRef.current && cmaPhaseRef.current === 'subject') {
        toggleCmaSubjectParcel(parcel);
        return;
      }
      if (cmaModeRef.current && cmaPhaseRef.current === 'comps') {
        toast('Subject is locked. Tap a comp pin to add it. Use Edit Subject to adjust parcels.', { duration: 2200 });
        return;
      }

      if (mapModeRef.current === 'parcel_select') {
        handleAddParcelToSelection(parcel);
      } else {
        setTappedParcel(parcel);
        setSheetMode('parcel');
        setSelectedComp(null);
      }
    });

    return () => {
      if (map.current) { map.current.remove(); map.current = null; }
    };
  }, []);

  // Update map mode ref for click handler
  const mapModeRef = useRef(mapMode);
  useEffect(() => { mapModeRef.current = mapMode; }, [mapMode]);
  // Same trick for CMA-mode reads inside the once-mounted click handler
  const cmaModeRef = useRef(cmaMode);
  useEffect(() => { cmaModeRef.current = cmaMode; }, [cmaMode]);

  // Toggle: clicking a parcel in selection mode adds it; clicking an
  // already-selected parcel removes it.
  const handleAddParcelToSelection = useCallback((parcel: ParcelFeature) => {
    setSelectedParcels(prev => {
      const already = prev.some(p => p.parcel_id === parcel.parcel_id);
      const next = already
        ? prev.filter(p => p.parcel_id !== parcel.parcel_id)
        : [...prev, parcel];

      // Update map layer
      if (map.current) {
        const src = map.current.getSource('selected-parcels') as mapboxgl.GeoJSONSource;
        if (src) {
          src.setData({
            type: 'FeatureCollection',
            features: next.filter(p => p.geometry).map(p => ({
              type: 'Feature' as const,
              properties: { id: p.parcel_id },
              geometry: p.geometry,
            })),
          });
        }
      }

      if (already) {
        toast(`Removed: ${parcel.owner_name || 'Parcel'}`, { duration: 1200, icon: '➖' });
      } else {
        toast.success(`Added: ${parcel.owner_name || 'Parcel'}`, { duration: 1200 });
      }
      return next;
    });
  }, []);

  const fetchComps = useCallback(async () => {
    const { data } = await supabase
      .from('comps')
      .select('*')
      .not('latitude', 'is', null)
      .not('longitude', 'is', null)
      .order('created_at', { ascending: false });
    if (data) setComps(data as Comp[]);
  }, [supabase]);

  useEffect(() => { fetchComps(); }, [fetchComps]);

  const findListingForComp = useCallback(async (compId: string) => {
    setFindingListingFor(prev => new Set(prev).add(compId));
    try {
      const res = await fetch(`/api/comp/${compId}/find-listing`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Search failed');
        return;
      }
      setLiveListings(prev => ({
        ...prev,
        [compId]: { url: data.url ?? null, reason: data.reason ?? null },
      }));
      if (data.url) {
        toast.success('Listing found — link below');
      } else {
        toast(data.reason || 'No matching listing found', { icon: '🔍', duration: 4000 });
      }
    } catch (e: any) {
      toast.error(e?.message || 'Search failed');
    } finally {
      setFindingListingFor(prev => {
        const next = new Set(prev);
        next.delete(compId);
        return next;
      });
    }
  }, []);

  // Persist a live-found listing URL onto the comp so it shows up on the
  // share report. If a different source_url is already set, confirm overwrite.
  const saveListingForComp = useCallback(async (compId: string) => {
    const live = liveListings[compId];
    if (!live?.url) {
      toast.error('No listing URL to save');
      return;
    }
    const existing = comps.find(c => c.id === compId);
    const existingUrl = (existing as any)?.source_url as string | null | undefined;
    if (existingUrl && existingUrl !== live.url) {
      const ok = window.confirm(
        `This comp already has a saved URL:\n\n${existingUrl}\n\nReplace with the new one?`
      );
      if (!ok) return;
    } else if (existingUrl === live.url) {
      // Already saved — just flash the saved state for confirmation
      setSavedListingFor(prev => new Set(prev).add(compId));
      setTimeout(() => {
        setSavedListingFor(prev => {
          const next = new Set(prev);
          next.delete(compId);
          return next;
        });
      }, 2500);
      return;
    }

    setSavingListingFor(prev => new Set(prev).add(compId));
    try {
      const { error } = await supabase
        .from('comps')
        .update({ source_url: live.url })
        .eq('id', compId);
      if (error) {
        toast.error(error.message);
        return;
      }
      // Optimistic local update so the comp card reflects the saved URL.
      setComps(prev =>
        prev.map(c => (c.id === compId ? ({ ...c, source_url: live.url } as any) : c))
      );
      setSavedListingFor(prev => new Set(prev).add(compId));
      toast.success('Saved — appears on share report');
      setTimeout(() => {
        setSavedListingFor(prev => {
          const next = new Set(prev);
          next.delete(compId);
          return next;
        });
      }, 2500);
    } finally {
      setSavingListingFor(prev => {
        const next = new Set(prev);
        next.delete(compId);
        return next;
      });
    }
  }, [liveListings, comps, supabase]);

  const startEditBoundary = useCallback((comp: Comp) => {
    if (!drawRef.current || !map.current) return;
    const geom = (comp as any).boundary_geojson;
    if (!geom) {
      toast.error('Comp has no boundary to edit');
      return;
    }
    drawRef.current.deleteAll();
    const ids = drawRef.current.add({
      type: 'Feature',
      properties: { compId: comp.id },
      geometry: geom,
    } as any);
    editingDrawIdRef.current = ids[0];
    setEditingBoundaryComp(comp);
    setSelectedComp(null); // hide the panel while editing
    drawRef.current.changeMode('direct_select', { featureId: ids[0] });
    if (comp.latitude != null && comp.longitude != null) {
      map.current.flyTo({ center: [comp.longitude, comp.latitude], zoom: 15, duration: 800 });
    }
    toast('Drag vertices to edit · click between vertices to add new ones', {
      icon: '✏️', duration: 4000,
    });
  }, []);

  const cancelEditBoundary = useCallback(() => {
    if (drawRef.current) drawRef.current.deleteAll();
    editingDrawIdRef.current = null;
    setEditingBoundaryComp(null);
  }, []);

  const saveEditedBoundary = useCallback(async () => {
    if (!drawRef.current || !editingBoundaryComp) return;
    const id = editingDrawIdRef.current;
    if (!id) return;
    const feature: any = drawRef.current.get(id);
    if (!feature?.geometry) {
      toast.error('No geometry to save');
      return;
    }
    setSavingBoundary(true);
    try {
      const res = await fetch(`/api/comp/${editingBoundaryComp.id}/boundary`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geometry: feature.geometry }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to save boundary');
        return;
      }
      toast.success('Boundary updated');
      drawRef.current.deleteAll();
      editingDrawIdRef.current = null;
      setEditingBoundaryComp(null);
      await fetchComps();
    } catch (e: any) {
      toast.error(e?.message || 'Save failed');
    } finally {
      setSavingBoundary(false);
    }
  }, [editingBoundaryComp, fetchComps]);

  const startCMA = useCallback(() => {
    setCmaMode(true);
    setCmaSubjectParcels([]);
    setCmaSubjectMeta({ name: '', county: '', state: 'TX' });
    setCmaCompIds([]);
    setCmaPhase('subject');
    setSelectedComp(null);
    setMapMode('view');
    setSheetMode('none');
    toast('Tap parcels to assemble the subject tract. Multiple = merged.', {
      icon: '📋', duration: 4500,
    });
  }, []);

  const cancelCMA = useCallback(() => {
    setCmaMode(false);
    setCmaSubjectParcels([]);
    setCmaSubjectMeta({ name: '', county: '', state: 'TX' });
    setCmaCompIds([]);
    setCmaPhase('subject');
    setCmaEditingId(null);
    // Clear visual layers
    if (map.current && mapLoaded) {
      try {
        const sel = map.current.getSource('selected-parcels') as mapboxgl.GeoJSONSource | undefined;
        if (sel) sel.setData({ type: 'FeatureCollection', features: [] });
        const merged = map.current.getSource('merged-boundary') as mapboxgl.GeoJSONSource | undefined;
        if (merged) merged.setData({ type: 'FeatureCollection', features: [] });
      } catch {}
    }
  }, [mapLoaded]);

  // Lock the selected parcels into a single merged subject tract. Renders the
  // union into the merged-boundary source and transitions to comp-picking phase.
  const lockSubjectTract = useCallback(async () => {
    if (cmaSubjectParcels.length === 0) {
      toast.error('Tap parcels first to build the subject tract');
      return;
    }
    // @ts-expect-error — turf v6.5 .d.ts not exposed
    const turf = (await import('@turf/turf')) as any;
    const features = cmaSubjectParcels
      .filter((p) => p.geometry)
      .map((p) => ({ type: 'Feature' as const, properties: {}, geometry: p.geometry }));
    let merged: any = features[0];
    for (let i = 1; i < features.length; i++) {
      try {
        const u = turf.union(merged, features[i]);
        if (u) merged = u;
      } catch {}
    }
    if (map.current && mapLoaded) {
      try {
        const mergedSrc = map.current.getSource('merged-boundary') as mapboxgl.GeoJSONSource | undefined;
        if (mergedSrc && merged) {
          mergedSrc.setData({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: merged.geometry || merged }],
          });
        }
        // Clear individual parcel highlights now that they're merged
        const sel = map.current.getSource('selected-parcels') as mapboxgl.GeoJSONSource | undefined;
        if (sel) sel.setData({ type: 'FeatureCollection', features: [] });
      } catch {}
    }
    setCmaPhase('comps');
    const totalAcres = cmaSubjectParcels.reduce((s, p) => s + (p.acres || 0), 0);
    toast.success(
      `Subject locked — ${cmaSubjectParcels.length} parcel${cmaSubjectParcels.length === 1 ? '' : 's'}, ${totalAcres.toFixed(1)} ac. Now tap comp pins.`
    );
  }, [cmaSubjectParcels, mapLoaded]);

  const unlockSubjectTract = useCallback(() => {
    setCmaPhase('subject');
    // Re-show individual parcels in the selected layer
    if (map.current && mapLoaded) {
      try {
        const sel = map.current.getSource('selected-parcels') as mapboxgl.GeoJSONSource | undefined;
        if (sel) {
          sel.setData({
            type: 'FeatureCollection',
            features: cmaSubjectParcels.filter(p => p.geometry).map(p => ({
              type: 'Feature' as const,
              properties: { id: p.parcel_id },
              geometry: p.geometry,
            })),
          });
        }
        const merged = map.current.getSource('merged-boundary') as mapboxgl.GeoJSONSource | undefined;
        if (merged) merged.setData({ type: 'FeatureCollection', features: [] });
      } catch {}
    }
  }, [cmaSubjectParcels, mapLoaded]);

  const toggleCmaSubjectParcel = useCallback((parcel: ParcelFeature) => {
    setCmaSubjectParcels(prev => {
      const already = prev.some(p => p.parcel_id === parcel.parcel_id);
      const next = already
        ? prev.filter(p => p.parcel_id !== parcel.parcel_id)
        : [...prev, parcel];
      // Reflect on the map via the existing selected-parcels source
      if (map.current) {
        const src = map.current.getSource('selected-parcels') as mapboxgl.GeoJSONSource | undefined;
        if (src) {
          src.setData({
            type: 'FeatureCollection',
            features: next.filter(p => p.geometry).map(p => ({
              type: 'Feature' as const,
              properties: { id: p.parcel_id },
              geometry: p.geometry,
            })),
          });
        }
      }
      return next;
    });
    // Also seed metadata from the first parcel if blank
    setCmaSubjectMeta(meta => {
      if (meta.county && meta.name) return meta;
      return {
        name: meta.name || parcel.owner_name || `${parcel.county || 'TX'} subject`,
        county: meta.county || parcel.county || '',
        state: meta.state || parcel.state || 'TX',
      };
    });
  }, []);

  const toggleCmaComp = useCallback((compId: string) => {
    setCmaCompIds(prev =>
      prev.includes(compId) ? prev.filter(i => i !== compId) : [...prev, compId]
    );
  }, []);

  const saveCMA = useCallback(async () => {
    const isEditing = !!cmaEditingId;
    if (cmaCompIds.length === 0) {
      toast.error('Tap at least one comp pin to include in the CMA');
      return;
    }
    // For new CMAs, we need fresh subject parcels. When editing existing,
    // the subject is frozen — we only update comp selection + recompute values.
    const subjAcres = isEditing
      ? (parseFloat(String(cmaSubjectMeta.county ? viewingCMA?.subject_acres ?? 0 : 0)) || 0)
      : cmaSubjectParcels.reduce((s, p) => s + (p.acres || 0), 0);
    if (!isEditing) {
      if (cmaSubjectParcels.length === 0) {
        toast.error('Tap one or more parcels to define the subject tract');
        return;
      }
      if (!cmaSubjectMeta.county) {
        toast.error('Subject county is required');
        return;
      }
      if (subjAcres <= 0) {
        toast.error('Subject acreage is missing — set acres on the subject parcels');
        return;
      }
    }
    setSavingCMA(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast.error('Not signed in');
        return;
      }
      const ppas = comps
        .filter(c => cmaCompIds.includes(c.id))
        .map(c => c.ppa_land_only || c.price_per_acre || 0)
        .filter(v => v > 0);
      const ppaLow = ppas.length ? Math.min(...ppas) : null;
      const ppaMid = ppas.length ? ppas.reduce((a, b) => a + b, 0) / ppas.length : null;
      const ppaHigh = ppas.length ? Math.max(...ppas) : null;

      // For new CMAs, compute subject centroid + merged boundary from the
      // selected parcels. Editing existing leaves the stored geometry alone.
      let subjectLat: number | null = null;
      let subjectLng: number | null = null;
      let subjectGeom: any = null;
      if (!isEditing && cmaSubjectParcels.length > 0) {
        // @ts-expect-error — turf v6.5 .d.ts not exposed
        const turf = (await import('@turf/turf')) as any;
        const features = cmaSubjectParcels
          .filter((p) => p.geometry)
          .map((p) => ({ type: 'Feature' as const, properties: {}, geometry: p.geometry }));
        if (features.length > 0) {
          let merged: any = features[0];
          for (let i = 1; i < features.length; i++) {
            try {
              const u = turf.union(merged, features[i]);
              if (u) merged = u;
            } catch {}
          }
          subjectGeom = merged?.geometry || merged;
          try {
            const c = turf.centroid(merged);
            subjectLng = c.geometry.coordinates[0];
            subjectLat = c.geometry.coordinates[1];
          } catch {}
        }
        // Fallback to first parcel's lat/lng if turf failed
        if (subjectLat == null) {
          subjectLat = cmaSubjectParcels[0].latitude ?? null;
          subjectLng = cmaSubjectParcels[0].longitude ?? null;
        }
      }

      let savedId: string | null = null;
      if (isEditing && cmaEditingId) {
        const acresForCalc = viewingCMA?.subject_acres ?? subjAcres;
        const { error } = await supabase
          .from('cmas')
          .update({
            selected_comp_ids: cmaCompIds,
            subject_name: cmaSubjectMeta.name || `${cmaSubjectMeta.county} subject`,
            subject_county: cmaSubjectMeta.county,
            subject_state: cmaSubjectMeta.state || 'TX',
            ppa_low: ppaLow,
            ppa_mid: ppaMid,
            ppa_high: ppaHigh,
            value_low: ppaLow != null ? ppaLow * acresForCalc : null,
            value_mid: ppaMid != null ? ppaMid * acresForCalc : null,
            value_high: ppaHigh != null ? ppaHigh * acresForCalc : null,
          })
          .eq('id', cmaEditingId);
        if (error) {
          toast.error(error.message);
          return;
        }
        savedId = cmaEditingId;
        toast.success(`CMA updated — ${cmaCompIds.length} comps`);
      } else {
        const { data, error } = await supabase
          .from('cmas')
          .insert({
            created_by: user.id,
            subject_name: cmaSubjectMeta.name || `${cmaSubjectMeta.county} subject`,
            subject_county: cmaSubjectMeta.county,
            subject_state: cmaSubjectMeta.state || 'TX',
            subject_acres: subjAcres,
            subject_latitude: subjectLat,
            subject_longitude: subjectLng,
            subject_boundary_geojson: subjectGeom,
            selected_comp_ids: cmaCompIds,
            ppa_low: ppaLow,
            ppa_mid: ppaMid,
            ppa_high: ppaHigh,
            value_low: ppaLow != null ? ppaLow * subjAcres : null,
            value_mid: ppaMid != null ? ppaMid * subjAcres : null,
            value_high: ppaHigh != null ? ppaHigh * subjAcres : null,
          })
          .select()
          .single();
        if (error) {
          toast.error(error.message);
          return;
        }
        savedId = data?.id ?? null;
        toast.success(`CMA created — ${cmaSubjectParcels.length} subject parcel${cmaSubjectParcels.length === 1 ? '' : 's'}, ${cmaCompIds.length} comps`);
      }
      cancelCMA();
      if (savedId) {
        router.push(`/dashboard/map?cma=${savedId}`);
      }
    } catch (e: any) {
      toast.error(e?.message || 'Save failed');
    } finally {
      setSavingCMA(false);
    }
  }, [cmaEditingId, cmaSubjectParcels, cmaSubjectMeta, cmaCompIds, comps, viewingCMA, supabase, cancelCMA, router]);

  // Ask the server for top similar comps, then auto-add them to the CMA
  // selection. Uses the locked subject's lat/lng/acres/county. Already-selected
  // comps are excluded so repeated clicks expand the set.
  const suggestComps = useCallback(async () => {
    let lat: number | null = null, lng: number | null = null;
    let county = cmaSubjectMeta.county;
    let acres = 0;

    if (cmaEditingId && viewingCMA) {
      lat = viewingCMA.subject_latitude ?? null;
      lng = viewingCMA.subject_longitude ?? null;
      acres = Number(viewingCMA.subject_acres) || 0;
      county = county || viewingCMA.subject_county || '';
    } else if (cmaSubjectParcels.length > 0) {
      acres = cmaSubjectParcels.reduce((s, p) => s + (p.acres || 0), 0);
      // Centroid of subject parcels
      const lats = cmaSubjectParcels.map(p => p.latitude).filter(v => v != null) as number[];
      const lngs = cmaSubjectParcels.map(p => p.longitude).filter(v => v != null) as number[];
      if (lats.length && lngs.length) {
        lat = lats.reduce((a, b) => a + b, 0) / lats.length;
        lng = lngs.reduce((a, b) => a + b, 0) / lngs.length;
      }
    }

    if (lat == null || lng == null || !acres) {
      toast.error('Lock a subject tract first');
      return;
    }

    setSuggestingComps(true);
    try {
      const res = await fetch('/api/cma/suggest-comps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: { latitude: lat, longitude: lng, county, state: cmaSubjectMeta.state || 'TX', acres },
          limit: 8,
          exclude_ids: cmaCompIds,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Suggest failed');
        return;
      }
      const ids: string[] = (data.suggestions || []).map((s: any) => s.id);
      if (ids.length === 0) {
        toast(`No similar comps found in ${data.total_candidates} sold comps`, { duration: 3000 });
        return;
      }
      setCmaCompIds(prev => Array.from(new Set([...prev, ...ids])));
      toast.success(`Added ${ids.length} suggested comp${ids.length === 1 ? '' : 's'}`);
    } catch (e: any) {
      toast.error(e?.message || 'Suggest failed');
    } finally {
      setSuggestingComps(false);
    }
  }, [cmaEditingId, viewingCMA, cmaSubjectMeta, cmaSubjectParcels, cmaCompIds]);

  const startReselectParcels = useCallback((comp: Comp) => {
    setReselectingComp(comp);
    setSelectedParcels([]);
    setMapMode('parcel_select');
    setSheetMode('selecting');
    setSelectedComp(null);
    setTappedParcel(null);
    if (map.current && comp.latitude != null && comp.longitude != null) {
      map.current.flyTo({ center: [comp.longitude, comp.latitude], zoom: 15, duration: 800 });
    }
    toast(
      `Re-selecting parcels for "${comp.property_name || comp.county || 'comp'}". ` +
      `Tap parcels to toggle, then Combine.`,
      { icon: '🗺️', duration: 4500 }
    );
  }, []);

  const saveReselectedParcelsToComp = useCallback(
    async (comp: Comp, parcels: ParcelFeature[]) => {
      if (parcels.length === 0) {
        toast.error('No parcels selected');
        return;
      }
      // @ts-expect-error — turf v6.5 .d.ts not exposed
      const turf = (await import('@turf/turf')) as any;
      const features = parcels
        .filter((p) => p.geometry)
        .map((p) => ({ type: 'Feature' as const, properties: {}, geometry: p.geometry }));
      let merged: any = features[0];
      for (let i = 1; i < features.length; i++) {
        try {
          const u = turf.union(merged, features[i]);
          if (u) merged = u;
        } catch {}
      }
      const geometry = merged?.geometry || merged;
      try {
        const res = await fetch(`/api/comp/${comp.id}/boundary`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ geometry }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.error || 'Failed to save boundary');
          return;
        }
        toast.success(
          `Boundary updated — ${parcels.length} parcel${parcels.length === 1 ? '' : 's'}`
        );
        setReselectingComp(null);
        resetParcelState();
        setSheetMode('none');
        await fetchComps();
      } catch (e: any) {
        toast.error(e?.message || 'Save failed');
      }
    },
    [resetParcelState, fetchComps]
  );

  const fixAcresFromDescription = useCallback(
    async (compId: string, newAcres: number) => {
      try {
        const { error } = await supabase
          .from('comps')
          .update({ acres: newAcres })
          .eq('id', compId);
        if (error) {
          toast.error(error.message);
          return;
        }
        toast.success(`Acres updated to ${newAcres.toLocaleString()}`);
        await fetchComps();
      } catch (e: any) {
        toast.error(e?.message || 'Update failed');
      }
    },
    [supabase, fetchComps]
  );

  const clearBoundary = useCallback(async () => {
    if (!selectedComp) return;
    if (!confirm('Remove the saved boundary for this comp?')) return;
    try {
      const res = await fetch(`/api/comp/${selectedComp.id}/boundary`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geometry: null }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to clear boundary');
        return;
      }
      toast.success('Boundary cleared');
      await fetchComps();
    } catch (e: any) {
      toast.error(e?.message || 'Clear failed');
    }
  }, [selectedComp, fetchComps]);

  const detectBoundary = useCallback(async () => {
    if (!selectedComp) return;
    setDetectingBoundary(true);
    try {
      const res = await fetch(`/api/comp/${selectedComp.id}/enrich-boundary`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Could not detect boundary');
        return;
      }
      const summary = `${data.holding_parcel_count} parcel${data.holding_parcel_count === 1 ? '' : 's'}, ${data.acres?.toFixed?.(1) ?? '?'} ac`;
      if (data.partial_sale) {
        toast(
          `⚠️ Partial sale detected — used seed parcel only (${summary}). Verify the boundary matches the report.`,
          { duration: 6000, icon: '⚠️' }
        );
      } else {
        toast.success(`Boundary detected — ${summary}`);
      }
      await fetchComps();
    } catch (e: any) {
      toast.error(e?.message || 'Boundary detection failed');
    } finally {
      setDetectingBoundary(false);
    }
  }, [selectedComp, fetchComps]);

  // Viewport-based TxGIO vector parcels — covers all of TX, only loads what's
  // visible. Kicks in at zoom 13 (parcels appear at county-overview distance).
  // Below zoom 13 the raster layer shows boundaries visually and map clicks
  // fall back to /api/parcel point query.
  useEffect(() => {
    if (!mapLoaded || !map.current) return;

    if (!map.current.getSource('txgio-bbox')) {
      map.current.addSource('txgio-bbox', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        attribution: 'Parcels © TxGIO',
      });
      map.current.addLayer({
        id: 'txgio-bbox-line',
        type: 'line',
        source: 'txgio-bbox',
        minzoom: 13,
        paint: {
          'line-color': '#fbbf24',
          'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 14, 1.3, 15, 1.6, 16, 1.9, 19, 2.5],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.85, 14, 1],
        },
      });
      map.current.addLayer({
        id: 'txgio-bbox-fill',
        type: 'fill',
        source: 'txgio-bbox',
        minzoom: 13,
        paint: { 'fill-color': '#fbbf24', 'fill-opacity': 0 }, // invisible click target
      });
      map.current.addLayer({
        id: 'txgio-bbox-labels',
        type: 'symbol',
        source: 'txgio-bbox',
        minzoom: 14,
        layout: {
          'text-field': ['get', 'owner_name'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14, 9, 16, 11, 19, 13],
          'text-allow-overlap': false,
          'text-padding': 2,
          'text-max-width': 9,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#f8fafc',
          'text-halo-color': '#0b0f14',
          'text-halo-width': 1.6,
          'text-halo-blur': 0.4,
        },
      });

      // (TxGIO parcel hover tooltip removed per broker feedback.
      // Click still surfaces full parcel info via the existing
      // map-click → bottom sheet flow.)
    }

    let timer: any = null;
    let lastBbox = '';
    // Snap to a 0.02° grid (~2km in TX) so panning within a cell reuses the
    // exact same cached request. Matches server-side snap in /api/parcels-bbox.
    const GRID = 0.02;
    const snapBbox = (b: mapboxgl.LngLatBounds) => {
      const w = Math.floor(b.getWest() / GRID) * GRID;
      const s = Math.floor(b.getSouth() / GRID) * GRID;
      const e = Math.ceil(b.getEast() / GRID) * GRID;
      const n = Math.ceil(b.getNorth() / GRID) * GRID;
      return [w, s, e, n].map((v) => v.toFixed(4)).join(',');
    };
    const update = () => {
      if (!map.current) return;
      const zoom = map.current.getZoom();
      // Fetch vector overlay at zoom 13+ — bbox is ~5km across at z13,
      // which may have hundreds of rural parcels but stays under TxGIO's
      // 2000 record cap for typical rural Texas land.
      if (zoom < 13) {
        console.log(`[txgio-bbox] skipped — zoom ${zoom.toFixed(1)} < 13 (click anyway: falls back to point query)`);
        return;
      }
      const b = map.current.getBounds();
      if (!b) return;
      const bbox = snapBbox(b);
      if (bbox === lastBbox) return;
      lastBbox = bbox;
      console.log(`[txgio-bbox] fetching parcels at zoom ${zoom.toFixed(1)} snapped-bbox=${bbox}`);
      fetch(`/api/parcels-bbox?bbox=${bbox}`)
        .then((r) => {
          if (!r.ok) {
            console.warn(`[txgio-bbox] HTTP ${r.status} from /api/parcels-bbox`);
            return Promise.reject(r.status);
          }
          // The API returns a 200 with empty features when TxGIO is down/slow.
          // Detect that via the X-Upstream-Error header so we don't overwrite
          // previously-loaded parcels with nothing.
          const upstreamErr = r.headers.get('x-upstream-error');
          return r.json().then((data) => ({ data, upstreamErr }));
        })
        .then(({ data, upstreamErr }: any) => {
          const count = Array.isArray(data?.features) ? data.features.length : 0;
          if (upstreamErr) {
            console.warn(`[txgio-bbox] upstream failed: ${upstreamErr} — keeping previous parcels on screen`);
            // Reset lastBbox so the next pan retries this bbox.
            lastBbox = '';
            return;
          }
          console.log(`[txgio-bbox] received ${count} parcels`);
          if (!data?.features) return;
          // Guard: never replace currently-displayed parcels with an empty set.
          // If TxGIO returned 0 features for this bbox (water, OK), the previous
          // pan likely had relevant parcels — keep them visible.
          if (count === 0) {
            console.log('[txgio-bbox] empty response — keeping previous parcels');
            return;
          }
          const src = map.current?.getSource('txgio-bbox') as mapboxgl.GeoJSONSource | undefined;
          if (src) src.setData(data);
        })
        .catch((e) => {
          console.warn('[txgio-bbox] fetch failed:', e);
          // Reset so retry happens on next pan.
          lastBbox = '';
        });
    };
    const onMoveEnd = () => {
      clearTimeout(timer);
      timer = setTimeout(update, 350);
    };
    map.current.on('moveend', onMoveEnd);
    update();
    return () => {
      clearTimeout(timer);
      map.current?.off('moveend', onMoveEnd);
    };
  }, [mapLoaded]);

  // Load Blanco CAD parcels and add source+layers together once data arrives.
  // Adding the source before its data is loaded leads to silent rendering
  // failures in some Mapbox-gl versions, so we do both atomically here.
  useEffect(() => {
    if (!mapLoaded || !map.current) return;
    if (map.current.getSource('cad-blanco')) return; // already loaded
    let cancelled = false;
    const t = toast.loading('Loading Blanco CAD parcels…', { id: 'cad-blanco' });

    fetch('/api/county-parcels/blanco')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: any) => {
        if (cancelled || !map.current) return;
        const featureCount = data?.features?.length || 0;
        if (featureCount === 0) {
          toast.error('Blanco: 0 parcels (upstream blank)', { id: 'cad-blanco' });
          return;
        }
        try {
          map.current.addSource('cad-blanco', {
            type: 'geojson',
            data,
            attribution: 'Parcels © Blanco CAD',
          });
          map.current.addLayer({
            id: 'cad-blanco-fill',
            type: 'fill',
            source: 'cad-blanco',
            minzoom: 14,
            paint: { 'fill-color': '#34d399', 'fill-opacity': 0.06 },
          });
          map.current.addLayer({
            id: 'cad-blanco-line',
            type: 'line',
            source: 'cad-blanco',
            minzoom: 14,
            paint: {
              'line-color': '#34d399',
              'line-opacity': 0.95,
              'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1.4, 17, 2, 19, 2.8],
            },
          });
          map.current.addLayer({
            id: 'cad-blanco-labels',
            type: 'symbol',
            source: 'cad-blanco',
            minzoom: 14,
            layout: {
              'text-field': ['get', 'file_as_name'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 16, 11, 19, 14],
              'text-allow-overlap': false,
              'text-padding': 2,
              'text-max-width': 9,
              'text-letter-spacing': 0.02,
              'symbol-placement': 'point',
            },
            paint: {
              'text-color': '#f8fafc',
              'text-halo-color': '#0b0f14',
              'text-halo-width': 1.8,
              'text-halo-blur': 0.6,
            },
          });
          toast.success(`Blanco: ${featureCount} parcels`, { id: 'cad-blanco', duration: 2500 });
        } catch (e: any) {
          toast.error(`Layer add failed: ${e?.message || e}`, { id: 'cad-blanco' });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(`Blanco load failed: ${err.message || err}`, { id: 'cad-blanco' });
      });
    return () => { cancelled = true; toast.dismiss(t); };
  }, [mapLoaded]);

  // Honor ?cma=<id> — load that CMA into workspace view (filters comps to
  // just the ones in this CMA, shows a banner). Clears when ?cma is removed.
  useEffect(() => {
    const cmaId = searchParams?.get('cma');
    if (!cmaId) {
      setViewingCMA(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from('cmas').select('*').eq('id', cmaId).single();
      if (cancelled) return;
      if (error || !data) {
        toast.error('CMA not found');
        return;
      }
      setViewingCMA(data);
    })();
    return () => { cancelled = true; };
  }, [searchParams, supabase]);

  // Copy the active CMA's share URL to clipboard. Falls back to a long toast
  // showing the URL if the clipboard API isn't available (e.g. Safari without
  // user-gesture context).
  const copyShareLink = useCallback(async () => {
    if (!viewingCMA?.share_token) {
      toast.error('No share link available on this CMA');
      return;
    }
    const url = `${window.location.origin}/report/${viewingCMA.share_token}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      toast.success('Share link copied to clipboard');
      setTimeout(() => setShareCopied(false), 2500);
    } catch {
      toast(url, { duration: 8000 });
    }
  }, [viewingCMA]);

  // Load the broker's team members + current collaborators when the Collaborate
  // modal opens. Team is derived from profiles.team_id of the current user.
  const openCollaboratorModal = useCallback(async () => {
    if (!viewingCMA?.id || !currentUserId) return;
    setCollabOpen(true);
    setCollabLoading(true);
    try {
      // Find the current user's team_id
      const { data: me } = await supabase
        .from('profiles')
        .select('team_id')
        .eq('id', currentUserId)
        .maybeSingle();
      const teamId = (me as any)?.team_id;

      // Team members on the same team (excluding the current user)
      let members: TeamMember[] = [];
      if (teamId) {
        const { data: m } = await supabase
          .from('profiles')
          .select('id,full_name,email')
          .eq('team_id', teamId)
          .neq('id', currentUserId);
        members = (m as any) || [];
      }
      setTeamMembers(members);

      // Already-added collaborators on this CMA
      const { data: existing } = await supabase
        .from('cma_collaborators')
        .select('user_id')
        .eq('cma_id', viewingCMA.id);
      setCollaboratorUserIds(new Set(((existing as any) || []).map((r: any) => r.user_id)));
    } catch (e: any) {
      toast.error(e?.message || 'Could not load team');
    } finally {
      setCollabLoading(false);
    }
  }, [viewingCMA, currentUserId, supabase]);

  // Add or remove a teammate as a collaborator. Optimistic UI updates the
  // Set immediately, then writes through to the DB.
  const toggleCollaborator = useCallback(async (userId: string) => {
    if (!viewingCMA?.id) return;
    const wasIn = collaboratorUserIds.has(userId);
    // Optimistic
    setCollaboratorUserIds(prev => {
      const next = new Set(prev);
      if (wasIn) next.delete(userId); else next.add(userId);
      return next;
    });
    if (wasIn) {
      const { error } = await supabase
        .from('cma_collaborators')
        .delete()
        .eq('cma_id', viewingCMA.id)
        .eq('user_id', userId);
      if (error) {
        toast.error(error.message);
        setCollaboratorUserIds(prev => new Set(prev).add(userId)); // rollback
      }
    } else {
      const { error } = await supabase
        .from('cma_collaborators')
        .insert({
          cma_id: viewingCMA.id,
          user_id: userId,
          role: 'editor',
          added_by: currentUserId,
        });
      if (error) {
        toast.error(error.message);
        setCollaboratorUserIds(prev => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      }
    }
  }, [viewingCMA, currentUserId, collaboratorUserIds, supabase]);

  const exitCmaWorkspace = useCallback(() => {
    router.replace('/dashboard/map');
  }, [router]);

  // Hydrate adjustment draft when a CMA loads
  useEffect(() => {
    if (!viewingCMA) {
      setCompAdjustmentsDraft({});
      return;
    }
    setCompAdjustmentsDraft(
      (viewingCMA.comp_adjustments && typeof viewingCMA.comp_adjustments === 'object')
        ? { ...viewingCMA.comp_adjustments }
        : {}
    );
  }, [viewingCMA?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync ALL BOV inputs when a different CMA loads. Mode is inferred from
  // which columns are populated:
  //   broker_opinion_land_value set → breakdown mode
  //   else → lump_sum mode (existing column, default)
  // Bind to id only so live typing isn't clobbered by optimistic state
  // round-trips during keystrokes.
  useEffect(() => {
    const cma: any = viewingCMA;
    const acres = Number(cma?.subject_acres) || 0;
    const lumpTotal = cma?.broker_opinion_value;
    const landTotal = cma?.broker_opinion_land_value;
    const improvement = cma?.broker_opinion_improvement_value;
    const storedMode = cma?.broker_opinion_mode as BovMode | null | undefined;

    // Lump-sum fields
    const lumpNum = lumpTotal != null ? Number(lumpTotal) : NaN;
    if (Number.isFinite(lumpNum) && lumpNum > 0) {
      setBovTotalInput(String(Math.round(lumpNum)));
      setBovPpaInput(acres > 0 ? String(Math.round(lumpNum / acres)) : '');
    } else {
      setBovTotalInput('');
      setBovPpaInput('');
    }

    // Breakdown fields
    const landNum = landTotal != null ? Number(landTotal) : NaN;
    if (Number.isFinite(landNum) && landNum > 0) {
      setBovLandTotalInput(String(Math.round(landNum)));
      setBovLandPpaInput(acres > 0 ? String(Math.round(landNum / acres)) : '');
    } else {
      setBovLandTotalInput('');
      setBovLandPpaInput('');
    }
    const impNum = improvement != null ? Number(improvement) : NaN;
    setBovImprovementInput(Number.isFinite(impNum) && impNum > 0 ? String(Math.round(impNum)) : '');

    // Improvement breakdown sub-fields (house SQFT + Additional Vertical)
    const houseSqft = cma?.broker_opinion_house_sqft;
    const housePpsf = cma?.broker_opinion_house_ppsf;
    const addlVert = cma?.broker_opinion_additional_vertical;
    const sqftNum = houseSqft != null ? Number(houseSqft) : NaN;
    const ppsfNum = housePpsf != null ? Number(housePpsf) : NaN;
    const addlNum = addlVert != null ? Number(addlVert) : NaN;
    setBovHouseSqftInput(Number.isFinite(sqftNum) && sqftNum > 0 ? String(Math.round(sqftNum)) : '');
    setBovHousePpsfInput(Number.isFinite(ppsfNum) && ppsfNum > 0 ? String(Math.round(ppsfNum)) : '');
    setBovAddlVerticalInput(Number.isFinite(addlNum) && addlNum > 0 ? String(Math.round(addlNum)) : '');
    // Auto-open the house-breakdown expander when any of the itemization
    // fields are populated — broker shouldn't have to click to see their
    // own data on next load.
    const hasItemization = (Number.isFinite(sqftNum) && sqftNum > 0)
      || (Number.isFinite(ppsfNum) && ppsfNum > 0)
      || (Number.isFinite(addlNum) && addlNum > 0);
    setBovHouseBreakdownOpen(hasItemization);

    // Mode resolution: explicit > inferred > default
    if (storedMode === 'lump_sum' || storedMode === 'breakdown') {
      setBovMode(storedMode);
    } else if (Number.isFinite(landNum) && landNum > 0) {
      setBovMode('breakdown');
    } else {
      setBovMode('lump_sum');
    }
  }, [viewingCMA?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Immediate save — used by Save button and effect cleanup so pending edits
  // never get cancelled by debounce when the user navigates away.
  const flushAdjustments = useCallback(
    async (cmaId: string, draft: Record<string, CompAdjustment>) => {
      const { error } = await supabase
        .from('cmas')
        .update({ comp_adjustments: draft })
        .eq('id', cmaId);
      if (error) {
        toast.error(error.message);
        return false;
      }
      setViewingCMA((prev: any) =>
        prev && prev.id === cmaId ? { ...prev, comp_adjustments: draft } : prev
      );
      return true;
    },
    [supabase]
  );

  // Debounced auto-save (600ms). Cleanup flushes any pending change so
  // exiting the report mid-edit still persists.
  useEffect(() => {
    if (!viewingCMA?.id) return;
    const cmaId = viewingCMA.id;
    const stored = (viewingCMA.comp_adjustments || {}) as Record<string, CompAdjustment>;
    const draftSnapshot = compAdjustmentsDraft;
    if (JSON.stringify(stored) === JSON.stringify(draftSnapshot)) return;
    const t = setTimeout(() => { flushAdjustments(cmaId, draftSnapshot); }, 600);
    return () => {
      // The 600ms timer hadn't fired yet — flush immediately on cleanup.
      clearTimeout(t);
      flushAdjustments(cmaId, draftSnapshot);
    };
  }, [compAdjustmentsDraft, viewingCMA, flushAdjustments]);

  const updateAdjustment = useCallback((compId: string, patch: Partial<CompAdjustment>) => {
    setCompAdjustmentsDraft(prev => ({
      ...prev,
      [compId]: { ...(prev[compId] || {}), ...patch },
    }));
  }, []);

  // Enter parcel-select mode tied to the active CMA's subject. When the user
  // hits Combine, we save the merged geometry + centroid to the CMA's
  // subject_boundary_geojson / subject_latitude / subject_longitude columns.
  const [settingSubjectForCma, setSettingSubjectForCma] = useState<string | null>(null);
  const startMapSubjectForCMA = useCallback(() => {
    if (!viewingCMA) return;
    setSettingSubjectForCma(viewingCMA.id);
    setSelectedParcels([]);
    setMapMode('parcel_select');
    setSheetMode('selecting');
    setSelectedComp(null);
    setTappedParcel(null);
    toast(
      `Tap parcels for the subject of "${viewingCMA.subject_name || 'CMA'}". Combine to save.`,
      { icon: '📍', duration: 4500 }
    );
  }, [viewingCMA]);

  const saveSubjectFromParcels = useCallback(
    async (cmaId: string, parcels: ParcelFeature[]) => {
      if (parcels.length === 0) {
        toast.error('No parcels selected');
        return;
      }
      // @ts-expect-error — turf v6.5 .d.ts not exposed
      const turf = (await import('@turf/turf')) as any;
      const features = parcels
        .filter((p) => p.geometry)
        .map((p) => ({ type: 'Feature' as const, properties: {}, geometry: p.geometry }));
      let merged: any = features[0];
      for (let i = 1; i < features.length; i++) {
        try {
          const u = turf.union(merged, features[i]);
          if (u) merged = u;
        } catch {}
      }
      let lat: number | null = null, lng: number | null = null;
      try {
        const c = turf.centroid(merged);
        lng = c.geometry.coordinates[0];
        lat = c.geometry.coordinates[1];
      } catch {}
      if (lat == null) { lat = parcels[0].latitude ?? null; lng = parcels[0].longitude ?? null; }
      const totalAcres = parcels.reduce((s, p) => s + (p.acres || 0), 0);
      const { error } = await supabase
        .from('cmas')
        .update({
          subject_latitude: lat,
          subject_longitude: lng,
          subject_boundary_geojson: merged?.geometry || merged,
          // also keep subject_acres in sync
          subject_acres: totalAcres > 0 ? totalAcres : undefined,
        })
        .eq('id', cmaId);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(`Subject mapped — ${parcels.length} parcel${parcels.length === 1 ? '' : 's'}, ${totalAcres.toFixed(1)} ac`);
      setSettingSubjectForCma(null);
      resetParcelState();
      setSheetMode('none');
      // Force re-fetch of the CMA to refresh subject pin/boundary
      const { data } = await supabase.from('cmas').select('*').eq('id', cmaId).single();
      if (data) setViewingCMA(data);
    },
    [supabase, resetParcelState]
  );

  // Re-open the active CMA in build mode so the user can add/remove comps.
  // We don't have the original subject parcels stored, so the subject is
  // shown as a frozen meta card; only comp selection is editable.
  const editCmaComps = useCallback(() => {
    if (!viewingCMA) return;
    setCmaMode(true);
    setCmaEditingId(viewingCMA.id);
    setCmaSubjectParcels([]);
    setCmaSubjectMeta({
      name: viewingCMA.subject_name || '',
      county: viewingCMA.subject_county || '',
      state: viewingCMA.subject_state || 'TX',
    });
    setCmaCompIds(viewingCMA.selected_comp_ids || []);
    setCmaPhase('comps');
    setSelectedComp(null);
    // Exit the workspace filter so all comps are visible again
    router.replace('/dashboard/map');
    toast(`Editing CMA — already-selected comps are highlighted blue. Tap pins to toggle.`, {
      icon: '✏️', duration: 4000,
    });
  }, [viewingCMA, router]);

  // Render subject boundary in workspace view
  useEffect(() => {
    if (!mapLoaded || !map.current) return;
    const src = map.current.getSource('cma-subject') as mapboxgl.GeoJSONSource | undefined;
    if (!src) return;
    if (viewingCMA?.subject_boundary_geojson) {
      src.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: viewingCMA.subject_boundary_geojson }],
      });
    } else {
      src.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [viewingCMA, mapLoaded]);

  // For legacy CMAs missing subject coords, set a fallback pin from comp
  // centroid so it at least shows on the map. Boundary stays empty until the
  // user uses Map Subject Tract — we never guess polygons we weren't given.
  useEffect(() => {
    if (!viewingCMA) return;
    if (viewingCMA.subject_latitude != null && viewingCMA.subject_longitude != null) return;
    if (!viewingCMA.id) return;
    const ids: string[] = viewingCMA.selected_comp_ids || [];
    const pts = comps
      .filter((c) => ids.includes(c.id) && c.latitude != null && c.longitude != null)
      .map((c) => [c.longitude as number, c.latitude as number] as [number, number]);
    if (pts.length === 0) return;
    const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    let cancelled = false;
    (async () => {
      const { error } = await supabase
        .from('cmas')
        .update({ subject_latitude: lat, subject_longitude: lng })
        .eq('id', viewingCMA.id);
      if (cancelled || error) return;
      setViewingCMA((prev: any) =>
        prev && prev.id === viewingCMA.id
          ? { ...prev, subject_latitude: lat, subject_longitude: lng }
          : prev
      );
    })();
    return () => { cancelled = true; };
  }, [viewingCMA, comps, supabase]);

  // Subject marker — warm brick red, the protagonist of the map. Real-
  // estate convention (Zillow / Realtor / Apple Maps drop pin) trained
  // brokers to read "red = the one we're evaluating." A subtle pulse
  // ring keeps the eye anchored when the broker scrolls away and back.
  const subjectMarkerRef = useRef<mapboxgl.Marker | null>(null);
  useEffect(() => {
    if (!mapLoaded || !map.current) return;
    if (subjectMarkerRef.current) {
      subjectMarkerRef.current.remove();
      subjectMarkerRef.current = null;
    }
    if (!viewingCMA?.subject_latitude || !viewingCMA?.subject_longitude) return;
    const el = document.createElement('div');
    el.style.cssText = `
      position:relative;
      background:${SUBJECT_RED};
      border:3px solid #F5F1E8;
      border-radius:50%;
      width:20px;height:20px;cursor:pointer;
      box-shadow:0 0 0 4px ${SUBJECT_RED_SOFT}, 0 6px 18px rgba(0,0,0,.5);
      animation:subjectPulse 2.4s ease-in-out infinite;
    `;
    el.title = viewingCMA.subject_name || 'Subject';
    subjectMarkerRef.current = new mapboxgl.Marker({ element: el })
      .setLngLat([viewingCMA.subject_longitude, viewingCMA.subject_latitude])
      .addTo(map.current);
    return () => {
      if (subjectMarkerRef.current) {
        subjectMarkerRef.current.remove();
        subjectMarkerRef.current = null;
      }
    };
  }, [viewingCMA, mapLoaded]);

  // Fit the map to the subject + comps belonging to the active CMA
  useEffect(() => {
    if (!viewingCMA || !mapLoaded || !map.current) return;
    const ids: string[] = viewingCMA.selected_comp_ids || [];
    const points: [number, number][] = comps
      .filter((c) => ids.includes(c.id) && c.latitude != null && c.longitude != null)
      .map((c) => [c.longitude as number, c.latitude as number]);
    if (viewingCMA.subject_latitude != null && viewingCMA.subject_longitude != null) {
      points.push([viewingCMA.subject_longitude, viewingCMA.subject_latitude]);
    }
    if (points.length === 0) return;
    if (points.length === 1) {
      map.current.flyTo({ center: points[0], zoom: 13, duration: 1000 });
      return;
    }
    let minLng = points[0][0], maxLng = points[0][0], minLat = points[0][1], maxLat = points[0][1];
    for (const [lng, lat] of points) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    map.current.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
      padding: 80, duration: 1000, maxZoom: 13,
    });
  }, [viewingCMA, mapLoaded, comps]);

  // Honor ?focus=lat,lng,zoom — flies the map there once it's loaded
  useEffect(() => {
    if (!mapLoaded || !map.current) return;
    const focus = searchParams?.get('focus');
    if (!focus) return;
    const [latStr, lngStr, zoomStr] = focus.split(',');
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    const zoom = parseFloat(zoomStr || '14');
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      map.current.flyTo({ center: [lng, lat], zoom: Number.isFinite(zoom) ? zoom : 14, duration: 1200 });
    }
  }, [mapLoaded, searchParams]);

  const clearAiSearch = useCallback(() => {
    setAiHighlightedCompIds(null);
    setAiResultMessage(null);
  }, []);

  // Clear owner-search highlights + state. Called from the X button, when
  // starting a new search, or when starting a different workflow.
  const clearOwnerSearch = useCallback(() => {
    setOwnerSearchQuery('');
    setOwnerSearchCount(null);
    setOwnerSearchTruncated(false);
    if (map.current && mapLoaded) {
      try {
        const src = map.current.getSource('owner-search-results') as mapboxgl.GeoJSONSource | undefined;
        if (src) src.setData({ type: 'FeatureCollection', features: [] });
      } catch {}
    }
  }, [mapLoaded]);

  // Query TxGIO for all parcels with a matching owner_name, light them up
  // on the map, and zoom out to fit them all if there are results.
  const searchOwners = useCallback(async () => {
    const q = ownerSearchQuery.trim();
    if (q.length < 3) {
      toast.error('Enter at least 3 characters');
      return;
    }
    setOwnerSearching(true);
    try {
      const res = await fetch(`/api/parcels-by-owner?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error || 'Owner search failed');
        return;
      }
      const features = Array.isArray(data?.features) ? data.features : [];
      const src = map.current?.getSource('owner-search-results') as mapboxgl.GeoJSONSource | undefined;
      if (src) {
        src.setData({ type: 'FeatureCollection', features });
      }
      setOwnerSearchCount(features.length);
      setOwnerSearchTruncated(Boolean(data?.truncated));

      if (features.length === 0) {
        // TxGIO stores individual owners as "LASTNAME FIRSTNAME" — gentle
        // nudge that one of the words may not exist in the dataset at all.
        toast(
          `No parcels found for "${q}". Try a single name (e.g. just "Fritz") to see if either word matches.`,
          { icon: '🔍', duration: 5000 }
        );
        return;
      }

      // Fit map to result bounding box so the user can see all matches
      try {
        // @ts-expect-error — turf v6.5 .d.ts not exposed
        const turf = (await import('@turf/turf')) as any;
        const fc = { type: 'FeatureCollection', features };
        const bbox = turf.bbox(fc) as [number, number, number, number];
        if (bbox.every(Number.isFinite) && map.current) {
          map.current.fitBounds(
            [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
            { padding: 80, duration: 1200, maxZoom: 15 }
          );
        }
      } catch {}

      toast.success(
        `${features.length} parcel${features.length === 1 ? '' : 's'} found${data?.truncated ? ' (showing first 200)' : ''}`,
        { duration: 3000 }
      );
    } catch (e: any) {
      toast.error(e?.message || 'Owner search failed');
    } finally {
      setOwnerSearching(false);
    }
  }, [ownerSearchQuery]);

  // Expand TX-specific road abbreviations into their full names. Mapbox / OSM
  // data is inconsistent about which form is indexed, so we generate variants:
  //   "CR 2875"  → also "County Road 2875"
  //   "FM 3176"  → also "Farm to Market 3176"
  //   "RR 100"   → also "Ranch Road 100"
  //   "Hwy 90"   → also "US Highway 90"
  //   "County Rd 2875" → also "CR 2875"
  // Tries each variant in order until Mapbox returns a usable result.
  const expandTxRoadVariants = (query: string): string[] => {
    const variants = new Set<string>([query]);
    const subs: Array<[RegExp, string]> = [
      [/\bCR\b\.?\s*(\d+)/i, 'County Road $1'],
      [/\bCounty\s+Rd\b\.?\s*(\d+)/i, 'CR $1'],
      [/\bCounty\s+Road\b\s*(\d+)/i, 'CR $1'],
      [/\bFM\b\.?\s*(\d+)/i, 'Farm to Market $1'],
      [/\bF\.?M\.?\b\s*(\d+)/i, 'Farm to Market $1'],
      [/\bRR\b\.?\s*(\d+)/i, 'Ranch Road $1'],
      [/\bRanch\s+Rd\b\.?\s*(\d+)/i, 'RR $1'],
      [/\bRanch\s+Road\b\s*(\d+)/i, 'RR $1'],
      [/\bRM\b\.?\s*(\d+)/i, 'Ranch to Market $1'],
      [/\bPR\b\.?\s*(\d+)/i, 'Private Road $1'],
      [/\bHwy\b\.?\s*(\d+)/i, 'US Highway $1'],
      [/\bHighway\b\s*(\d+)/i, 'Hwy $1'],
      [/\bUS\b\s+(\d+)/i, 'US Highway $1'],
      [/\bSH\b\.?\s*(\d+)/i, 'State Highway $1'],
      [/\bIH\b\.?\s*(\d+)/i, 'Interstate $1'],
    ];
    for (const [re, replacement] of subs) {
      if (re.test(query)) {
        variants.add(query.replace(re, replacement));
      }
    }
    return Array.from(variants);
  };

  // Geocode a place name via Mapbox forward geocoding and fly the map there.
  // Texas-biased: includes "Texas" in the query and uses a TX bounding box so
  // rural roads and city streets resolve to the TX instance, not (say) the
  // Brummett Road in California.
  //
  // Tries multiple query variants (CR ↔ County Road, FM ↔ Farm to Market,
  // etc.) since Mapbox's road index is inconsistent about TX-specific
  // abbreviations.
  //
  // Returns true if the fly succeeded, false if no usable result — so the
  // caller can fall through to AI for ambiguous queries.
  const flyToPlace = useCallback(async (name: string): Promise<boolean> => {
    const variants = expandTxRoadVariants(name);
    for (const variant of variants) {
      try {
        const queryWithState = /\b(tx|texas)\b/i.test(variant) ? variant : `${variant}, Texas`;
        // TX bounding box (approximate): SW -107, 25.5  NE -93, 36.5
        const url =
          `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(queryWithState)}` +
          `&access_token=${process.env.NEXT_PUBLIC_MAPBOX_TOKEN}` +
          `&limit=1&country=us&bbox=-107,25.5,-93,36.5`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const json = await res.json();
        const f = json.features?.[0];
        const coords = f?.geometry?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2 || !map.current) continue;
        const ftype = f.properties?.feature_type;
        const zoom = ftype === 'address' ? 16 : ftype === 'place' ? 11 : ftype === 'street' ? 15 : 13;
        map.current.flyTo({ center: [coords[0], coords[1]], zoom, duration: 1200 });

        if (variant !== name) {
          console.log(`[flyToPlace] resolved "${name}" via variant "${variant}"`);
        }

        // After fly, try to highlight the parcel at the destination if zoomed
        // close enough. Best-effort — TxGIO may be slow / point may be on a road.
        if (zoom >= 15) {
          setTimeout(async () => {
            try {
              const parcelRes = await fetch(`/api/parcel?lat=${coords[1]}&lng=${coords[0]}`);
              if (parcelRes.ok) {
                const parcel = await parcelRes.json();
                if (parcel && parcel.parcel_id && parcel.geometry) {
                  setTappedParcel({
                    ...parcel,
                    latitude: coords[1],
                    longitude: coords[0],
                  });
                  setSheetMode('parcel');
                }
              }
            } catch {}
          }, 1200);
        }
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }, []);

  // Heuristic: does this query look like an address or street name?
  // If yes, we skip the AI roundtrip and go straight to Mapbox geocoding.
  // Patterns that indicate an address/street:
  //   - Starts with a street number ("1234 ...")
  //   - Contains a TX road type abbreviation (FM, CR, RR, RM, PR, Hwy, etc.)
  //   - Contains a road suffix word (Road, Street, Avenue, etc.)
  //   - Contains a US ZIP code
  const isLikelyAddressOrStreet = (q: string): boolean => {
    const trimmed = q.trim();
    // Starts with a number → almost always an address
    if (/^\d+\s+[A-Za-z]/.test(trimmed)) return true;
    // ZIP code
    if (/\b\d{5}(-\d{4})?\b/.test(trimmed)) return true;
    // TX-specific road type abbreviations and full forms (with word boundaries)
    if (/\b(FM|CR|RR|RM|PR|US|SH|IH|I-\d+|Hwy|Highway|Loop)\.?\s*\d+/i.test(trimmed)) return true;
    // Verbose road forms ("County Rd 2875", "Ranch Road 100", "Farm to Market 3176")
    if (/\bCounty\s+(Rd|Road)\b\.?\s*\d+/i.test(trimmed)) return true;
    if (/\bRanch\s+(Rd|Road)\b\s*\d+/i.test(trimmed)) return true;
    if (/\bFarm\s+to\s+Market\b\s*\d+/i.test(trimmed)) return true;
    // Common road suffix words
    if (/\b(Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Lane|Ln|Boulevard|Blvd|Parkway|Pkwy|Trail|Trl|Court|Ct|Way)\b/i.test(trimmed)) return true;
    return false;
  };

  const askAi = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) return;
    setAskingAi(true);

    // Fast path: address / street / zip — skip the AI roundtrip, go straight
    // to Mapbox geocoding. Avoids 2s of AI latency and the occasional
    // misclassification when the AI thinks a road name is a filter keyword.
    if (isLikelyAddressOrStreet(q)) {
      const ok = await flyToPlace(q);
      if (ok) {
        clearAiSearch();
        setAskingAi(false);
        return;
      }
      // Mapbox couldn't find it — fall through to AI for a backup attempt
    }

    try {
      const res = await fetch('/api/ai-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'AI search failed');
        return;
      }
      if (data.mode === 'location' && data.location?.name) {
        clearAiSearch();
        await flyToPlace(data.location.name);
        return;
      }
      if (data.mode !== 'filter' || !data.criteria) {
        toast(`I'm not sure what you meant. ${data.message || ''}`.trim(), { duration: 4500 });
        return;
      }
      const c = data.criteria;
      const matchesArr = (val: any, allowed: string[] | null | undefined) =>
        !allowed || allowed.length === 0 || (val != null && allowed.map(s => s.toLowerCase()).includes(String(val).toLowerCase()));
      const matchesNumRange = (val: any, min: number | null | undefined, max: number | null | undefined) => {
        if (val == null) return min == null && max == null;
        if (min != null && val < min) return false;
        if (max != null && val > max) return false;
        return true;
      };
      const matchesDateRange = (val: any, after: string | null | undefined, before: string | null | undefined) => {
        if (!after && !before) return true;
        if (!val) return false;
        const t = new Date(val).getTime();
        if (after && t < new Date(after).getTime()) return false;
        if (before && t > new Date(before).getTime()) return false;
        return true;
      };

      // County matcher — normalizes BOTH sides + splits compound county
      // strings (e.g. "Frio and Medina", "Atascosa & Frio") into the
      // individual counties before matching. Without the split, a comp
      // tagged "Frio and Medina" would silently fail to match a query
      // for "Frio" — same family of bug as the "Frio" vs "Frio County"
      // case, just one layer deeper.
      //
      // Splits on ' and ', '&', ',' (case-insensitive). Each piece is
      // then normalized (lowercased + " County" suffix stripped).
      // Inlined (not using the component-level normalizeCounty) so
      // there's no source-order dependency for this critical matcher.
      const normCounty = (v: any) => String(v ?? '')
        .toLowerCase()
        .replace(/\bcounty\b/g, '')
        .trim();
      const splitCounties = (v: any): string[] => String(v ?? '')
        .split(/\s+and\s+|\s*&\s*|\s*,\s*/i)
        .map(normCounty)
        .filter(Boolean);
      const matchesCounty = (val: any, allowed: string[] | null | undefined) => {
        if (!allowed || allowed.length === 0) return true;
        if (val == null) return false;
        const compCounties = splitCounties(val);
        return allowed.some((a) => {
          const norm = normCounty(a);
          return compCounties.includes(norm);
        });
      };
      const matchingIds = new Set<string>();
      for (const comp of comps) {
        if (!matchesCounty(comp.county, c.counties)) continue;
        if (!matchesArr(comp.state, c.states)) continue;
        if (!matchesArr(comp.water, c.water)) continue;
        if (!matchesArr(comp.road_frontage, c.road_frontage)) continue;
        if (!matchesArr(comp.dev_potential, c.dev_potential)) continue;
        if (c.has_improvements != null && Boolean(comp.has_improvements) !== Boolean(c.has_improvements)) continue;
        if (Array.isArray(c.irrigation) && c.irrigation.length > 0) {
          const v = (comp as any).irrigation as string | null;
          if (!v || !c.irrigation.includes(v)) continue;
        }
        if (c.has_water_rights != null && Boolean((comp as any).has_water_rights) !== Boolean(c.has_water_rights)) continue;
        if (Array.isArray(c.minerals_sold) && c.minerals_sold.length > 0) {
          const m = String(comp.minerals_sold || '').toLowerCase();
          const ok = c.minerals_sold.some((v: string) => m.includes(String(v).toLowerCase()));
          if (!ok) continue;
        }
        if (Array.isArray(c.best_use) && c.best_use.length > 0) {
          const compUses = Array.isArray(comp.best_use) ? comp.best_use : [];
          const ok = c.best_use.some((u: string) => compUses.includes(u as any));
          if (!ok) continue;
        }
        if (!matchesNumRange(comp.acres, c.min_acres, c.max_acres)) continue;
        const ppa = comp.ppa_land_only || comp.price_per_acre || null;
        if ((c.min_ppa != null || c.max_ppa != null) && !matchesNumRange(ppa, c.min_ppa, c.max_ppa)) continue;
        if (!matchesDateRange(comp.sale_date, c.sold_after_date, c.sold_before_date)) continue;
        if (Array.isArray(c.keywords_in_description) && c.keywords_in_description.length > 0) {
          const desc = (comp.description || '').toLowerCase();
          const ok = c.keywords_in_description.some((k: string) => desc.includes(String(k).toLowerCase()));
          if (!ok) continue;
        }
        matchingIds.add(comp.id);
      }

      if (matchingIds.size === 0) {
        toast(`No matching comps. ${data.message || ''}`.trim(), { duration: 4000, icon: '🔎' });
        setAiHighlightedCompIds(new Set());
        setAiResultMessage(data.message || 'No matches');
        return;
      }
      setAiHighlightedCompIds(matchingIds);
      setAiResultMessage(`${matchingIds.size} comp${matchingIds.size === 1 ? '' : 's'} · ${data.message || q}`);
      toast.success(`Found ${matchingIds.size} comp${matchingIds.size === 1 ? '' : 's'}`);

      // Fit map bounds to matches
      if (map.current) {
        const points: [number, number][] = comps
          .filter(c => matchingIds.has(c.id) && c.latitude != null && c.longitude != null)
          .map(c => [c.longitude as number, c.latitude as number]);
        if (points.length === 1) {
          map.current.flyTo({ center: points[0], zoom: 12, duration: 1200 });
        } else if (points.length > 1) {
          let minLng = points[0][0], maxLng = points[0][0], minLat = points[0][1], maxLat = points[0][1];
          for (const [lng, lat] of points) {
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
          map.current.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
            padding: 100, duration: 1200, maxZoom: 12,
          });
        }
      }
    } catch (e: any) {
      toast.error(e?.message || 'AI search failed');
    } finally {
      setAskingAi(false);
    }
  }, [searchQuery, comps, clearAiSearch, flyToPlace]);

  // Normalize a county string for comparison — strips "County" suffix,
  // collapses whitespace, lowercases. So "Frio County" / "frio" / "FRIO"
  // all match the same bucket.
  const normalizeCounty = (raw: any): string => {
    return String(raw ?? '')
      .toLowerCase()
      .replace(/\bcounty\b/g, '')
      .trim();
  };
  // Split a compound county string into individual normalized counties.
  // "Frio and Medina" / "Atascosa & Frio" / "Atascosa, Wilson" all become
  // ['frio','medina'] / ['atascosa','frio'] / ['atascosa','wilson'].
  // Used so a multi-county comp shows up under BOTH counties in the
  // filter picker (once each) AND matches when EITHER county is filtered —
  // while still being a single row, single pin on the map.
  const splitCounties = (raw: any): string[] => String(raw ?? '')
    .split(/\s+and\s+|\s*&\s*|\s*,\s*/i)
    .map(normalizeCounty)
    .filter(Boolean);

  // When viewing a CMA, restrict everything to its selected comps.
  // Otherwise apply the map-level scope + county filters.
  const displayComps = viewingCMA?.selected_comp_ids?.length
    ? comps.filter((c) => viewingCMA.selected_comp_ids.includes(c.id))
    : comps.filter((c) => {
        if (mapScope === 'company' && !(c as any).is_company_transaction) return false;
        // "My Sales" reads transaction_agent_id (who closed the deal), NOT
        // created_by (who typed it in). Research comps you entered but didn't
        // sell stay out of this view.
        if (mapScope === 'mine' && !(currentUserId != null && (c as any).transaction_agent_id === currentUserId)) return false;
        // County filter: split compound county strings ("Frio and Medina")
        // so the comp matches whenever ANY of its counties is in the
        // filter set. One comp, one pin — but appears under multiple
        // county filters (broker mental model: the property is in both).
        if (countyFilter.size > 0) {
          const compCounties = splitCounties(c.county);
          const hit = compCounties.some((cc) => countyFilter.has(cc));
          if (!hit) return false;
        }
        return true;
      });

  // Distinct counties present in the user's comps — drives the county
  // multi-select in the Filters popover. Sorted alphabetically with a
  // per-county comp count so brokers see at a glance where their data
  // lives. Computed from the unfiltered `comps` pool so the picker
  // doesn't shrink as filters tighten (which would trap brokers in
  // narrowing dead-ends).
  //
  // Compound county strings ("Frio and Medina", "Atascosa & Frio") are
  // SPLIT into individual counties — that comp contributes +1 to BOTH
  // Frio and Medina in the picker. The comp itself is still one row /
  // one pin on the map, but appears under either county's filter. This
  // matches the broker's mental model: the property is in both
  // counties, so it should be findable under either one.
  const availableCounties = (() => {
    const seen = new Map<string, { display: string; count: number }>();
    const titleCase = (s: string) =>
      s.split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ');
    for (const c of comps) {
      for (const norm of splitCounties(c.county)) {
        if (!norm) continue;
        const existing = seen.get(norm);
        if (existing) {
          existing.count += 1;
        } else {
          seen.set(norm, { display: titleCase(norm), count: 1 });
        }
      }
    }
    return Array.from(seen.entries())
      .map(([norm, { display, count }]) => ({ norm, display, count }))
      .sort((a, b) => a.display.localeCompare(b.display));
  })();

  // Comp boundaries (saved polygons from boundary_geojson). Hides the comp
  // currently being edited so we don't render its boundary twice (the draw
  // layer is showing it editable). Filters to the active CMA in workspace view.
  useEffect(() => {
    if (!map.current || !mapLoaded) return;
    const features = displayComps
      .filter((c: any) => c.boundary_geojson && c.id !== editingBoundaryComp?.id)
      .map((c: any) => ({
        type: 'Feature' as const,
        // Carry enough fields on each feature for the hover tooltip to
        // surface a useful label without a separate lookup. property_name
        // is the broker's primary identifier, acres is the headline
        // number, county/state ground it on the satellite view.
        properties: {
          id: c.id,
          owner_name: c.owner_name,
          property_name: c.property_name,
          acres: c.acres,
          county: c.county,
          state: c.state,
        },
        geometry: c.boundary_geojson,
      }));
    const src = map.current.getSource('comp-boundaries') as mapboxgl.GeoJSONSource | undefined;
    if (src) src.setData({ type: 'FeatureCollection', features });
  }, [displayComps, mapLoaded, editingBoundaryComp]);

  // Ensure overlay layers exist + reflect current toggle state.
  //
  // Lives in an effect (not the 'load' handler) because changeStyle()
  // calls setStyle() which wipes every custom source/layer — and after
  // style.load fires, mapLoaded flips false→true, re-running this
  // effect to re-add the layers idempotently. Setup + visibility-sync
  // in one place so they can't drift out of order.
  //
  // Both layers are added as RASTER overlays via the ArcGIS export
  // pattern (same as the existing txgio-parcels-layer). No client-side
  // feature data means no hover / click for these — they're visual
  // reference layers only. Hover wiring on the vector parcel layer
  // above still works for the parcel-owner tooltip; flood zone info,
  // if we ever want it, would need a separate /api/floodzone?lat=&lng=
  // round-trip on click.
  useEffect(() => {
    if (!mapLoaded || !map.current) return;
    const m = map.current;
    try {
      // TX County boundaries — Census TIGER generalized State_County service.
      // Switched from TxGIO Boundaries because TxGIO has server-side scale-
      // dependent rendering: it returns blank tiles at zoom < ~7, so the
      // county grid disappeared on the wide TX view. Census TIGER's
      // generalized service is designed for low-zoom rendering and shows
      // boundaries at every scale.
      // Layer 86 = Counties (boundaries + labels). Filter to TX (state
      // FIPS 48) at the service level to avoid drawing the entire US grid
      // when looking at TX.
      if (!m.getSource('tx-counties')) {
        m.addSource('tx-counties', {
          type: 'raster',
          tiles: [
            'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2023/State_County/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&layers=show:86&f=image',
          ],
          tileSize: 512,
          attribution: 'Counties © U.S. Census Bureau (TIGER/Line)',
        });
      }
      if (!m.getLayer('tx-counties-layer')) {
        m.addLayer({
          id: 'tx-counties-layer',
          type: 'raster',
          source: 'tx-counties',
          // Always visible — counties are structural reference data, not
          // a togglable overlay. No layout.visibility needed.
          paint: {
            // Bumped opacity at low zoom (broker wants to SEE the county
            // grid at the state-wide view) and capped at 0.85 so the
            // satellite imagery still reads through at high zoom.
            'raster-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.7, 6, 0.8, 10, 0.75, 14, 0.7],
          },
        });
      }

      // FEMA National Flood Hazard Layer. Removed the layers=show:28
      // filter — that layer number ("Flood Hazard Boundaries") only
      // returned thin lines, not the colored Zone A/AE/X polygons
      // brokers actually want. Letting the service return its default
      // visible layer stack gives both the boundary lines AND the zone
      // fill polygons. FEMA's service is famously slow (often 5-15s for
      // the first tile in a viewport), so be patient when toggling on.
      if (!m.getSource('fema-floodplain')) {
        m.addSource('fema-floodplain', {
          type: 'raster',
          tiles: [
            'https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&f=image',
          ],
          tileSize: 512,
          // Minzoom: don't try to render flood polygons at state-wide
          // view — the FEMA service times out at very low scales and
          // the result is too small to read anyway. Brokers care about
          // floodplain on a property-by-property basis (zoom 11+).
          minzoom: 8,
          attribution: 'Floodplain © FEMA NFHL',
        });
      }
      if (!m.getLayer('fema-floodplain-layer')) {
        m.addLayer({
          id: 'fema-floodplain-layer',
          type: 'raster',
          source: 'fema-floodplain',
          layout: { visibility: overlays.floodplain ? 'visible' : 'none' },
          // Bumped opacity to 0.75 so the flood zones are clearly
          // visible — they're the whole point of toggling this layer.
          paint: { 'raster-opacity': 0.75 },
        });
      }

      // ── Contour lines (Mapbox terrain-v2 vector tileset) ──────────
      // Powers the "Terrain" style toggle — amber USGS-style contour
      // lines render on top of satellite imagery. Free with any Mapbox
      // token; same source that backs Mapbox's outdoors-v12 style.
      //
      // Previous version split into major (index==5) + minor (index!=5)
      // layers, but Mapbox terrain-v2's `index` only takes values 1, 5,
      // 10 — and at zoom <11 only index=10 features exist. So the
      // "major" filter with index==5 rendered nothing at the zooms it
      // claimed to. Simplified to ONE layer that draws every contour,
      // with zoom-interpolated width/opacity carrying the visual
      // hierarchy: thinner at low zoom, thicker at high.
      if (!m.getSource('mapbox-terrain-v2')) {
        m.addSource('mapbox-terrain-v2', {
          type: 'vector',
          url: 'mapbox://mapbox.mapbox-terrain-v2',
        });
      }
      if (!m.getLayer('contour-lines')) {
        m.addLayer({
          id: 'contour-lines',
          type: 'line',
          source: 'mapbox-terrain-v2',
          'source-layer': 'contour',
          minzoom: 9,
          layout: { visibility: mapStyle === 'terrain' ? 'visible' : 'none' },
          paint: {
            'line-color': '#92400e', // amber-800 — readable on TX terrain colors
            'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 13, 0.9, 17, 1.4],
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.55, 13, 0.7, 17, 0.85],
          },
        });
      }

      // Sync visibility on every run — covers the case where the layer
      // already existed but the toggle state has since changed. Counties
      // intentionally not synced here — always visible.
      m.setLayoutProperty('fema-floodplain-layer', 'visibility', overlays.floodplain ? 'visible' : 'none');
      m.setLayoutProperty('contour-lines', 'visibility', mapStyle === 'terrain' ? 'visible' : 'none');
    } catch (e) {
      console.warn('[overlays] failed to add/toggle overlay layers:', e);
    }
  }, [overlays, mapLoaded, mapStyle]);

  // ── Comp boundary hover tooltip ──────────────────────────────────────
  // Parcel hover tooltips (owner + acres on TxGIO / Blanco CAD / owner-
  // search / selected / tapped / CMA subject / merged) were removed per
  // broker feedback — they cluttered the map without adding signal
  // brokers needed in flow. Owner lookups stay available via the owner-
  // search input + the per-comp parcel list in the side panel.
  //
  // The COMP boundary hover stays because it surfaces the rich price /
  // acres / $/ac card that the comp marker hover already shows — same
  // popup, two ways to trigger it. Worth the on-hover cost because the
  // info isn't visible anywhere else on the map by default.
  useEffect(() => {
    if (!mapLoaded || !map.current) return;
    const m = map.current;

    // ─── Comp boundary hover: reuse the marker's rich .comp-hover-popup
    //
    // Look up the comp's existing popup in compPopupsRef (populated by
    // the markers effect) and addTo(map) on mouseenter. Same popup the
    // pin hover shows — anchored at the comp's centroid, sized to its
    // 4-col price grid. Also sets hoveredCompId so the marker border
    // glows in sync, matching the visual feedback the pin-hover path
    // already provides.
    //
    // No `displayComps` dep on this effect — the popup map is a ref,
    // so reads stay current as the markers effect rebuilds it. If we
    // depended on displayComps, the entire hover-wiring effect would
    // tear down + rebuild on every comp filter change. Wasteful and
    // (more importantly) creates a window where no boundary hover
    // works at all.
    let activeBoundaryCompId: string | null = null;
    const boundaryHoverEnter = (e: any) => {
      const f = e.features?.[0];
      const compId: string | undefined = f?.properties?.id;
      if (!compId) return;
      const popup = compPopupsRef.current.get(compId);
      if (!popup) return;
      // Avoid re-adding the same popup on every mousemove inside the
      // boundary (mousemove fires constantly). Track which comp is
      // active; only swap when the cursor crosses into a different
      // boundary.
      if (activeBoundaryCompId === compId) return;
      // Cursor left one boundary and entered another in the same tick —
      // remove the previous popup before showing the next.
      if (activeBoundaryCompId) {
        try { compPopupsRef.current.get(activeBoundaryCompId)?.remove(); } catch {}
      }
      activeBoundaryCompId = compId;
      try {
        popup.addTo(m);
        if (m.getCanvas()) m.getCanvas().style.cursor = 'pointer';
        setHoveredCompId(compId);
      } catch {}
    };
    const boundaryHoverLeave = () => {
      if (activeBoundaryCompId) {
        try { compPopupsRef.current.get(activeBoundaryCompId)?.remove(); } catch {}
        const leaving = activeBoundaryCompId;
        activeBoundaryCompId = null;
        try { if (m.getCanvas()) m.getCanvas().style.cursor = ''; } catch {}
        setHoveredCompId((prev) => (prev === leaving ? null : prev));
      }
    };
    if (m.getLayer('comp-boundary-fill')) {
      m.on('mousemove', 'comp-boundary-fill', boundaryHoverEnter);
      m.on('mouseleave', 'comp-boundary-fill', boundaryHoverLeave);
    }

    return () => {
      try { m.off('mousemove', 'comp-boundary-fill', boundaryHoverEnter); } catch {}
      try { m.off('mouseleave', 'comp-boundary-fill', boundaryHoverLeave); } catch {}
      if (activeBoundaryCompId) {
        try { compPopupsRef.current.get(activeBoundaryCompId)?.remove(); } catch {}
      }
    };
  }, [mapLoaded]);

  // Comp markers
  useEffect(() => {
    if (!map.current || !mapLoaded) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    popupsRef.current.forEach(p => p.remove());
    popupsRef.current = [];
    // Boundary-hover popup map gets rebuilt below; clear stale entries so
    // a comp that just left displayComps (filter change, CMA exit) can't
    // still pop a popup from a hover on its boundary.
    compPopupsRef.current.clear();

    displayComps.forEach(comp => {
      if (!comp.latitude || !comp.longitude) return;
      const ppa = comp.ppa_land_only || comp.price_per_acre || 0;
      const baseColor = STATUS_COLORS[comp.status] || '#94a3b8';
      const isCmaSelected = cmaMode && cmaCompIds.includes(comp.id);
      const color = isCmaSelected ? '#60a5fa' : baseColor;

      // Base styling. Hover highlight is applied imperatively in a separate
      // effect (so we don't rebuild markers on every hover change).
      const el = document.createElement('div');
      el.dataset.compId = comp.id;
      el.dataset.baseColor = baseColor;
      el.dataset.isCmaSelected = String(isCmaSelected);
      // Pin treatment:
      //   - Warm dark base (matches popup + sidebar surface system)
      //   - Cream-1 number text (reads on ANY satellite color)
      //   - Status-colored ring (subtle, brand-cohesive)
      //   - CMA-selected: brighter olive ring + soft glow
      //
      // NOTE: do NOT use `transform` in transitions or on hover — Mapbox
      // owns the `transform` CSS property on marker DOM (it positions
      // markers via translate). Setting transform: scale() wipes Mapbox's
      // translate and the pin jumps to (0,0) for a frame. Hover affordance
      // comes from border-color + box-shadow only.
      el.style.cssText = `
        background:${isCmaSelected ? '#332E29' : '#1A1815'};
        border:1.5px solid ${isCmaSelected ? '#C4CE96' : color};
        border-radius:20px;
        padding:4px 9px;font-family:'DM Mono',monospace;font-size:11px;
        font-weight:700;color:#F5F1E8;white-space:nowrap;cursor:pointer;
        box-shadow:${isCmaSelected ? '0 0 0 3px rgba(196,206,150,0.25), ' : ''}0 2px 10px rgba(0,0,0,.4);
        transition:border-color .15s, box-shadow .15s, padding .15s, font-size .15s;
      `;
      const total = comp.sale_price || 0;
      const formatPinAmount = (n: number) => {
        if (!Number.isFinite(n) || n <= 0) return '—';
        if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
        if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
        return `$${Math.round(n)}`;
      };
      el.textContent = pinLabelMode === 'total' ? formatPinAmount(total) : formatPinAmount(ppa);

      // Build a hover preview popup that mirrors the collapsed comp card from
      // the CMA workspace right panel — same header (name + badges) and same
      // 4-col grid (Acres / Total / Total $/Ac / Adjusted $/Ac). Click still
      // opens the full Comp Detail panel on the right.
      const totalPpa = comp.price_per_acre || 0;
      const adjustedPpa = comp.ppa_land_only || 0;
      const hasAdjustment = adjustedPpa > 0 && totalPpa > 0 && Math.abs(totalPpa - adjustedPpa) > 1;
      const isImproved = !!comp.has_improvements;
      const isStrongIrrigation = (comp as any).irrigation === 'Strong';
      const isAgentVerified = comp.improvement_source === 'agent_verified';
      const propertyName = (comp.property_name || `${comp.county} County`).replace(/</g, '&lt;');
      // Branded warm dark popup — floats over satellite map with frosted
      // blur (CSS in globals.css). Accent colors use their "light"
      // variants so they glow against the warm dark surface:
      //   olive-light  (#A8B57A) for the headline $/Ac
      //   amber-warm   (#E8B872) for the adjusted delta
      //   slate-blue-light (#7B9FCE) for status badges
      //   cream-1 (#F5F1E8)        primary text
      //   cream-2-text (#A8A296)   muted labels
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
        .setLngLat([comp.longitude!, comp.latitude!])
        .setHTML(popupHtml);

      el.addEventListener('mouseenter', () => {
        setHoveredCompId(comp.id);
        if (map.current) popup.addTo(map.current);
      });
      el.addEventListener('mouseleave', () => {
        setHoveredCompId((prev) => (prev === comp.id ? null : prev));
        popup.remove();
      });
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        // Hide the hover popup so it doesn't sit on top of the detail panel.
        popup.remove();
        if (cmaModeRef.current) {
          if (cmaPhaseRef.current === 'subject') {
            toast('Lock the subject tract first, then tap comps.', { duration: 2000 });
            return;
          }
          toggleCmaComp(comp.id);
          return;
        }
        setSelectedComp(comp);
        setSheetMode('none');
        setTappedParcel(null);
        map.current?.flyTo({ center: [comp.longitude!, comp.latitude!], zoom: 12, duration: 800 });
      });

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([comp.longitude!, comp.latitude!])
        .addTo(map.current!);
      markersRef.current.push(marker);
      popupsRef.current.push(popup);
      markerElsRef.current.set(comp.id, el);
      compPopupsRef.current.set(comp.id, popup);
    });
  }, [displayComps, mapLoaded, cmaMode, cmaCompIds, toggleCmaComp, pinLabelMode]);

  // Imperative styling: applies hover-highlight + AI-search dim/highlight to
  // the existing marker DOM elements without rebuilding them.
  useEffect(() => {
    markerElsRef.current.forEach((el, id) => {
      const baseColor = el.dataset.baseColor || '#94a3b8';
      const isCmaSelected = el.dataset.isCmaSelected === 'true';
      const isHovered = id === hoveredCompId;
      const isAiHighlighted = aiHighlightedCompIds?.has(id) ?? null;
      const isAiDimmed = aiHighlightedCompIds != null && !aiHighlightedCompIds.has(id);

      // Hide non-matching pins entirely when an AI filter is active.
      // Hover / AI-highlight states use box-shadow + border-color only.
      // DO NOT touch el.style.transform — Mapbox uses it for positioning
      // the marker (translate). Setting transform here would wipe the
      // translate and snap the pin to (0,0) for a frame.
      el.style.display = isAiDimmed ? 'none' : '';
      if (isHovered) {
        el.style.boxShadow = '0 0 0 4px rgba(168,181,122,0.40), 0 8px 22px rgba(0,0,0,.55)';
        el.style.borderColor = '#C4CE96';
        el.style.color = '#F5F1E8';
        el.style.zIndex = '10';
        el.style.opacity = '1';
      } else if (isAiHighlighted) {
        el.style.boxShadow = '0 0 0 4px rgba(123,159,206,0.32), 0 4px 14px rgba(0,0,0,.5)';
        el.style.borderColor = '#7B9FCE';
        el.style.color = '#F5F1E8';
        el.style.zIndex = '5';
        el.style.opacity = '1';
      } else {
        el.style.boxShadow = isCmaSelected
          ? '0 0 0 3px rgba(196,206,150,0.25), 0 2px 10px rgba(0,0,0,.4)'
          : '0 2px 10px rgba(0,0,0,.4)';
        el.style.borderColor = isCmaSelected ? '#C4CE96' : baseColor;
        el.style.color = '#F5F1E8';
        el.style.zIndex = '1';
        el.style.opacity = '1';
      }
    });
  }, [hoveredCompId, aiHighlightedCompIds]);


  const handleCreateBoundary = useCallback((parcels: ParcelFeature[]) => {
    // If we're mapping the subject for an existing CMA, save to that CMA's
    // subject geometry columns.
    if (settingSubjectForCma) {
      saveSubjectFromParcels(settingSubjectForCma, parcels);
      return;
    }
    // If we're re-selecting parcels for an existing comp, save directly to it
    // instead of opening the New Boundary sheet.
    if (reselectingComp) {
      saveReselectedParcelsToComp(reselectingComp, parcels);
      return;
    }

    const total = parcels.reduce((sum, p) => sum + (p.acres || 0), 0);
    setMergedAcres(total);

    if (map.current && mapLoaded) {
      const src = map.current.getSource('merged-boundary') as mapboxgl.GeoJSONSource;
      if (src) {
        src.setData({
          type: 'FeatureCollection',
          features: parcels.filter(p => p.geometry).map(p => ({
            type: 'Feature' as const,
            properties: {},
            geometry: p.geometry,
          })),
        });
      }
      // Clear selection layer
      const selSrc = map.current.getSource('selected-parcels') as mapboxgl.GeoJSONSource;
      if (selSrc) selSrc.setData({ type: 'FeatureCollection', features: [] });
    }

    setMapMode('view');
    setSheetMode('boundary_created');
  }, [mapLoaded, reselectingComp, saveReselectedParcelsToComp, settingSubjectForCma, saveSubjectFromParcels]);

  const startDrawing = useCallback(() => {
    if (!drawRef.current) return;
    // Auto-discard any lingering parcel selection / merged boundary so the
    // user starts with a clean canvas. Without this, drawing a new polygon
    // visually piles on top of whatever was previously selected.
    if (map.current && mapLoaded) {
      try {
        const sel = map.current.getSource('selected-parcels') as mapboxgl.GeoJSONSource | undefined;
        const merged = map.current.getSource('merged-boundary') as mapboxgl.GeoJSONSource | undefined;
        if (sel) sel.setData({ type: 'FeatureCollection', features: [] });
        if (merged) merged.setData({ type: 'FeatureCollection', features: [] });
      } catch {}
    }
    setSelectedParcels([]);
    setMergedAcres(0);
    drawRef.current.deleteAll();
    drawRef.current.changeMode('draw_polygon');
    setDrawingActive(true);
    setDrawVertexCount(0);
    setMapMode('view');
    setSheetMode('none');
    setSelectedComp(null);
    setTappedParcel(null);
  }, [mapLoaded]);

  const stopDrawing = useCallback(() => {
    if (!drawRef.current) return;
    drawRef.current.changeMode('simple_select');
    drawRef.current.deleteAll();
    setDrawingActive(false);
    setDrawnCount(0);
    setDrawVertexCount(0);
  }, []);

  // Manually close the polygon and exit draw mode. MapboxDraw closes the
  // polygon automatically when switching to simple_select if there are ≥3
  // vertices; if fewer, the partial polygon is discarded. We guard against
  // that case in the UI by disabling the button until ≥3 vertices.
  const finishDrawing = useCallback(() => {
    if (!drawRef.current) return;
    drawRef.current.changeMode('simple_select');
    setDrawingActive(false);
    setDrawVertexCount(0);
  }, []);

  // Discard the current in-progress polygon and restart drawing from scratch.
  // Useful when the user clicked a wrong vertex and wants a clean slate.
  const startOverDrawing = useCallback(() => {
    if (!drawRef.current) return;
    drawRef.current.deleteAll();
    drawRef.current.changeMode('draw_polygon');
    setDrawnCount(0);
    setDrawVertexCount(0);
  }, []);

  // Discard everything: drawn polygons in MapboxDraw, selected parcels,
  // the merged-boundary preview layer, and reset the sheet. This is the
  // single source of truth for "throw it all away and start fresh."
  const clearDrawings = useCallback(() => {
    if (drawRef.current) drawRef.current.deleteAll();
    setDrawnCount(0);
    setDrawingActive(false);
    setDrawVertexCount(0);
    setSelectedParcels([]);
    setMergedAcres(0);
    setSheetMode('none');
    if (map.current && mapLoaded) {
      try {
        const sel = map.current.getSource('selected-parcels') as mapboxgl.GeoJSONSource | undefined;
        const merged = map.current.getSource('merged-boundary') as mapboxgl.GeoJSONSource | undefined;
        if (sel) sel.setData({ type: 'FeatureCollection', features: [] });
        if (merged) merged.setData({ type: 'FeatureCollection', features: [] });
      } catch {}
    }
  }, [mapLoaded]);

  const combineAll = useCallback(() => {
    if (!map.current || !mapLoaded) return;

    const drawn = (drawRef.current?.getAll().features || [])
      .filter((f: any) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon');
    const parcels = selectedParcels
      .filter(p => p.geometry)
      .map(p => ({ type: 'Feature' as const, properties: {}, geometry: p.geometry }));

    const all = [...drawn, ...parcels];
    if (all.length === 0) {
      toast.error('Nothing to combine — draw or select parcels first');
      return;
    }

    let merged: any = all[0];
    for (let i = 1; i < all.length; i++) {
      try {
        const u = turf.union(merged as any, all[i] as any);
        if (u) merged = u;
      } catch {}
    }

    let totalAcres = 0;
    try { totalAcres = turf.area(merged) / 4046.8564224; } catch {}
    setMergedAcres(totalAcres);

    const src = map.current.getSource('merged-boundary') as mapboxgl.GeoJSONSource;
    if (src) {
      src.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: merged.geometry || merged }],
      });
    }
    // Clear staging visuals so the merged result is the only one shown
    const selSrc = map.current.getSource('selected-parcels') as mapboxgl.GeoJSONSource;
    if (selSrc) selSrc.setData({ type: 'FeatureCollection', features: [] });
    if (drawRef.current) drawRef.current.deleteAll();
    setDrawnCount(0);
    setDrawingActive(false);

    setMapMode('view');
    setSheetMode('boundary_created');
    toast.success(`Combined into ${totalAcres.toFixed(1)} acres`);
  }, [selectedParcels, mapLoaded]);

  const handleAddAsNewComp = useCallback(() => {
    const primary = selectedParcels[0] || tappedParcel;
    if (!primary) return;

    setPrefilledComp({
      county: primary.county || '',
      state: primary.state || 'TX',
      acres: mergedAcres || primary.acres || undefined,
      latitude: primary.latitude,
      longitude: primary.longitude,
      parcel_id: primary.parcel_id,
    });
    setSheetMode('none');
    setShowAddModal(true);
    resetParcelState();
  }, [selectedParcels, tappedParcel, mergedAcres, resetParcelState]);

  // Switch between Satellite and Terrain views. Both use the same base
  // style URL — the only difference is whether the contour-line overlay
  // is visible. So we just update state; the overlay-ensure effect
  // (below) handles toggling the contour layer's visibility on the next
  // render. No setStyle() means no layer wipe + no mapLoaded reset.
  const changeStyle = (style: 'satellite' | 'terrain') => {
    setMapStyle(style);
  };

  const allParcels = selectedParcels.length > 0 ? selectedParcels : tappedParcel ? [tappedParcel] : [];

  return (
    <div className="flex h-full bg-cream">
      <div className="flex-1 relative">
        <div
          ref={mapContainer}
          className="w-full h-full"
          style={{ cursor: mapMode === 'parcel_select' ? 'crosshair' : 'default' }}
        />

        {/* Edit Boundary toolbar — appears when actively editing a saved boundary */}
        {editingBoundaryComp && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30">
            <div className="bg-amber-500/15 backdrop-blur-md border border-amber-300 rounded-xl shadow-2xl px-3 py-2 flex items-center gap-2">
              <Pencil size={14} className="text-amber-600" />
              <span className="text-xs font-bold text-amber-800 mr-1">
                Editing: {editingBoundaryComp.property_name || `${editingBoundaryComp.county} comp`}
              </span>
              <button
                onClick={cancelEditBoundary}
                disabled={savingBoundary}
                className="px-3 py-1.5 border border-beige bg-white/70 hover:border-red-400 hover:text-red-500 text-xs font-bold text-ink-2 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveEditedBoundary}
                disabled={savingBoundary}
                className="px-3 py-1.5 bg-olive hover:bg-olive-2 text-white text-xs font-bold rounded-lg transition-colors disabled:opacity-50"
              >
                {savingBoundary ? 'Saving…' : 'Save Boundary'}
              </button>
            </div>
          </div>
        )}

        {/* Search bar — single input that drives the AI search (filter +
            location + place). Matched to the vault's search bar exactly
            (per broker request): solid white background, beige-2 border,
            olive sparkle on the left, iMessage-blue Ask button on the
            right. Floating shadow keeps it elevated over the satellite.
            Filters button is integrated inline (the map has a popover
            anchored to it, which doesn't exist on the vault).  */}
        <div className="absolute top-3 left-3 right-3 md:left-1/2 md:right-auto md:-translate-x-1/2 md:w-[36rem] z-20">
          <div className="relative">
            <Sparkles size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-olive pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  askAi();
                }
              }}
              placeholder="Ask: show me all 400+ acre comps in Real County"
              className="w-full bg-white border border-beige-2 rounded-lg pl-9 pr-32 py-2.5 text-sm text-ink placeholder-ink-3 outline-none focus:border-olive focus:ring-2 focus:ring-olive/20 transition-all shadow-md shadow-black/10"
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(''); clearAiSearch(); }}
                title="Clear"
                className="absolute right-[8.5rem] top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink p-1"
              >
                <X size={12} />
              </button>
            )}
            {/* Filters button — opens the advanced-filter popover. Sits
                INSIDE the search bar (the map's popover is anchored to
                this button). When any filter is active, olive-tint
                indicates the non-default state. */}
            <button
              onClick={() => setFiltersOpen((v) => !v)}
              title="Advanced filters"
              aria-expanded={filtersOpen}
              className={`absolute right-[5.25rem] top-1/2 -translate-y-1/2 px-2.5 py-1 border rounded-md text-[11px] font-semibold transition-colors flex items-center gap-1 ${
                ownerSearchCount !== null || mapScope !== 'all' || countyFilter.size > 0
                  ? 'bg-olive-tint border-olive-border text-olive-2'
                  : 'bg-cream border-beige text-ink-2 hover:text-ink hover:border-beige-2'
              }`}
            >
              <SlidersHorizontal size={11} />
              Filters
            </button>
            {/* iMessage-blue "Ask" send button — identical to the vault's
                Ask button. Universal "send a chat message" affordance. */}
            <button
              onClick={askAi}
              disabled={askingAi || !searchQuery.trim()}
              title="Ask AI"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-imsg hover:bg-imsg-2 disabled:opacity-40 disabled:cursor-not-allowed rounded-md text-[12px] font-medium text-white transition-all shadow-sm min-w-[56px] inline-flex items-center justify-center gap-1.5"
            >
              <Sparkles size={11} />
              {askingAi ? '…' : 'Ask'}
            </button>
            {aiResultMessage && (
              <div className="absolute top-full mt-1 left-0 right-0 bg-white border border-beige-2 rounded-lg px-3 py-2 flex items-center justify-between gap-2 shadow-md shadow-black/10">
                <p className="text-[11px] text-ink-2 truncate">{aiResultMessage}</p>
                <button
                  onClick={clearAiSearch}
                  className="text-olive hover:text-ink-2 flex-shrink-0"
                  title="Clear filter"
                >
                  <X size={12} />
                </button>
              </div>
            )}
            {/* Owner-search result chip — lives below the bar same as the
                AI result chip. Slate-blue tint distinguishes it from
                the AI result chip (olive) while staying in our palette. */}
            {ownerSearchCount !== null && (
              <div className={`absolute left-0 right-0 bg-slate-blue/10 backdrop-blur-sm border border-slate-blue/30 rounded-lg px-3 py-2 flex items-center justify-between gap-2 shadow-md shadow-black/10 ${
                aiResultMessage ? 'top-[calc(100%+2.5rem)]' : 'top-full mt-1'
              }`}>
                <p className="text-[11px] text-slate-blue-2 truncate">
                  {ownerSearchCount === 0
                    ? `No owner matches for "${ownerSearchQuery}"`
                    : `${ownerSearchCount} parcel${ownerSearchCount === 1 ? '' : 's'} matched "${ownerSearchQuery}"${ownerSearchTruncated ? ' (first 200)' : ''}`}
                </p>
                <button
                  onClick={clearOwnerSearch}
                  className="text-slate-blue hover:text-slate-blue-2 flex-shrink-0"
                  title="Clear owner search"
                >
                  <X size={12} />
                </button>
              </div>
            )}
          </div>

          {/* ── Advanced filters popover ────────────────────────────────
              Drops down from below the search bar. Holds the controls
              that were previously top-of-map pills/bars: owner search
              input + scope toggle. Designed to grow over time (acres
              range, county multi-select, sold-after date, etc.) without
              re-introducing always-visible chrome. */}
          {filtersOpen && (
            <div className="absolute top-full mt-2 left-0 right-0 bg-white/95 backdrop-blur-md border border-beige rounded-xl shadow-2xl p-3 z-30 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wide text-ink-3 flex items-center gap-1.5">
                  <SlidersHorizontal size={11} />
                  Filters
                </div>
                <button
                  onClick={() => setFiltersOpen(false)}
                  className="text-ink-3 hover:text-ink"
                  title="Close filters"
                  aria-label="Close filters"
                >
                  <X size={14} />
                </button>
              </div>

              {/* Owner search — TX-wide parcel lookup by owner_name. Kept
                  out of the AI bar above because it's a separate data
                  source (TxGIO parcels statewide, not the comps table)
                  and a separate code path. */}
              <div>
                <label className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5 flex items-center gap-1.5">
                  <Search size={10} />
                  Search by owner
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={ownerSearchQuery}
                    onChange={(e) => setOwnerSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        (e.target as HTMLInputElement).blur();
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        searchOwners();
                      }
                    }}
                    placeholder="e.g. Grundhoefer Farms"
                    disabled={ownerSearching}
                    className="w-full bg-cream/60 border border-beige focus:border-fuchsia-400 rounded-lg px-2.5 py-1.5 pr-20 text-xs text-ink placeholder-ink-3 outline-none disabled:opacity-50"
                  />
                  {(ownerSearchQuery || ownerSearchCount !== null) && (
                    <button
                      onClick={clearOwnerSearch}
                      title="Clear owner search"
                      className="absolute right-[4.25rem] top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
                    >
                      <X size={11} />
                    </button>
                  )}
                  <button
                    onClick={searchOwners}
                    disabled={ownerSearching || ownerSearchQuery.trim().length < 3}
                    className="absolute right-1 top-1/2 -translate-y-1/2 px-2 py-0.5 bg-fuchsia-500/25 hover:bg-fuchsia-500/35 disabled:opacity-40 disabled:cursor-not-allowed border border-fuchsia-400/40 rounded text-[10px] font-bold text-fuchsia-100 flex items-center gap-1"
                  >
                    {ownerSearching ? <Loader2 size={10} className="animate-spin" /> : <Search size={10} />}
                    Find
                  </button>
                </div>
              </div>

              {/* County filter — multi-select of counties that appear in
                  the user's comps. Empty selection = show all counties.
                  Sourced from comps (not the full 254 TX list) so the
                  picker stays short and matches the broker's actual
                  working set. Checkboxes for now since the list is
                  typically 5-30 items; switch to a searchable dropdown
                  later if a user accumulates >50 counties. */}
              {availableCounties.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[10px] uppercase tracking-wide text-ink-3">
                      County
                    </label>
                    {countyFilter.size > 0 && (
                      <button
                        onClick={() => setCountyFilter(new Set())}
                        className="text-[10px] text-ink-3 hover:text-ink-2 underline"
                        title="Show comps in all counties"
                      >
                        clear
                      </button>
                    )}
                  </div>
                  <div className="bg-cream/60 border border-beige rounded-lg max-h-40 overflow-y-auto p-1.5 space-y-0.5">
                    {availableCounties.map((c) => {
                      const checked = countyFilter.has(c.norm);
                      return (
                        <label
                          key={c.norm}
                          className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-cream cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setCountyFilter((prev) => {
                                const next = new Set(prev);
                                if (next.has(c.norm)) next.delete(c.norm);
                                else next.add(c.norm);
                                return next;
                              });
                            }}
                            className="w-3 h-3 accent-olive"
                          />
                          <span className={`text-[11px] flex-1 ${checked ? 'text-olive-2 font-bold' : 'text-ink-2'}`}>
                            {c.display}
                          </span>
                          {/* Comp count — helps brokers see where their
                              working data actually lives. Multi-county
                              comps are counted in each of their counties
                              (so totals can exceed comps.length). */}
                          <span className="text-[10px] text-ink-3 font-mono">
                            {c.count}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {countyFilter.size > 0 && (
                    <div className="text-[10px] text-ink-3 mt-1">
                      {countyFilter.size} of {availableCounties.length} selected
                    </div>
                  )}
                </div>
              )}

              {/* Scope filter — moved out of the standalone pill row.
                  Hidden in CMA workspace (which filters to its own comps).
                  All / Company / Mine remains a quick toggle since brokers
                  switch between scopes frequently. */}
              {!viewingCMA && (
                <div>
                  <label className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5 block">
                    Scope
                  </label>
                  <div className="bg-cream/60 border border-beige rounded-lg overflow-hidden grid grid-cols-3">
                    <button
                      onClick={() => setMapScope('all')}
                      className={`py-1.5 text-[11px] font-bold transition-colors ${
                        mapScope === 'all' ? 'bg-olive-tint text-olive-2' : 'text-ink-2 hover:text-ink'
                      }`}
                      title="Show every comp you have access to"
                    >
                      All
                    </button>
                    <button
                      onClick={() => setMapScope('company')}
                      className={`py-1.5 text-[11px] font-bold transition-colors ${
                        mapScope === 'company' ? 'bg-olive-tint text-olive-2' : 'text-ink-2 hover:text-ink'
                      }`}
                      title="Only comps marked as Company Transaction"
                    >
                      Company
                    </button>
                    <button
                      onClick={() => setMapScope('mine')}
                      className={`py-1.5 text-[11px] font-bold transition-colors ${
                        mapScope === 'mine' ? 'bg-olive-tint text-olive-2' : 'text-ink-2 hover:text-ink'
                      }`}
                      title="Only deals you personally closed"
                    >
                      My Sales
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Map controls */}
        <div className="absolute top-16 left-3 z-10 flex flex-col gap-2">
          {/* Style switcher — branded warm dark with frosted blur. All
              floating chrome over the satellite map shares this surface
              treatment (same as sidebar + popups). Olive-light glows for
              active state. */}
          <div className="bg-ink-deep/85 backdrop-blur-md border border-ink-line/70 rounded-xl overflow-hidden flex shadow-lg shadow-black/20">
            {(['satellite', 'terrain'] as const).map(s => (
              <button key={s} onClick={() => changeStyle(s)}
                className={`px-3 py-2 text-xs font-semibold capitalize transition-colors ${
                  mapStyle === s ? 'bg-olive-light/15 text-olive-light' : 'text-cream-2-text hover:text-cream-1'
                }`}
                title={s === 'terrain' ? 'Satellite imagery with contour lines' : 'Satellite imagery'}
              >{s}</button>
            ))}
          </div>

          {/* Pin label toggle — $/Ac vs Total Price */}
          <div className="bg-ink-deep/85 backdrop-blur-md border border-ink-line/70 rounded-xl overflow-hidden grid grid-cols-2 w-[10rem] shadow-lg shadow-black/20">
            <button
              onClick={() => setPinLabelMode('ppa')}
              className={`py-2 text-xs font-semibold transition-colors text-center ${
                pinLabelMode === 'ppa' ? 'bg-olive-light/15 text-olive-light' : 'text-cream-2-text hover:text-cream-1'
              }`}
              title="Show price per acre on pins"
            >
              $/Ac
            </button>
            <button
              onClick={() => setPinLabelMode('total')}
              className={`py-2 text-xs font-semibold transition-colors text-center ${
                pinLabelMode === 'total' ? 'bg-olive-light/15 text-olive-light' : 'text-cream-2-text hover:text-cream-1'
              }`}
              title="Show total sale price on pins"
            >
              Total
            </button>
          </div>

          {/* Flood toggle */}
          <div className="bg-ink-deep/85 backdrop-blur-md border border-ink-line/70 rounded-xl overflow-hidden w-[10rem] shadow-lg shadow-black/20">
            <button
              onClick={() => setOverlays((o) => ({ ...o, floodplain: !o.floodplain }))}
              className={`w-full py-2 px-2 text-xs font-semibold transition-colors text-center flex items-center justify-center gap-1.5 ${
                overlays.floodplain ? 'bg-sky-400/20 text-sky-300' : 'text-cream-2-text hover:text-cream-1'
              }`}
              title={overlays.floodplain ? 'Hide FEMA floodplain' : 'Show FEMA floodplain'}
              aria-pressed={overlays.floodplain}
            >
              <Waves size={12} />
              Flood
            </button>
          </div>

          {/* Scope filter (All / Company / Mine) moved into the Filters
              popover next to the search bar — one less always-visible
              pill. Active scope still shows on the Filters button itself
              (gold tint when scope ≠ All) so brokers see at a glance
              that a non-default filter is on. */}

          {/* Parcel mode button */}
          {mapMode === 'view' && !drawingActive && (
            <button
              onClick={() => {
                // Auto-discard any stale merged-boundary preview so the user
                // starts the new selection on a clean canvas.
                if (map.current && mapLoaded) {
                  try {
                    const merged = map.current.getSource('merged-boundary') as mapboxgl.GeoJSONSource | undefined;
                    if (merged) merged.setData({ type: 'FeatureCollection', features: [] });
                  } catch {}
                }
                setMergedAcres(0);
                setMapMode('parcel_select');
                setSheetMode('selecting');
                setSelectedComp(null);
                setTappedParcel(null);
                toast('Tap parcels on the map to select them', { icon: '🗺️', duration: 2500 });
              }}
              className="bg-ink-deep/85 backdrop-blur-md border border-ink-line/70 hover:border-olive-light/40 rounded-xl px-3 py-2 text-xs font-semibold text-cream-2-text hover:text-olive-light transition-colors flex items-center gap-1.5 shadow-lg shadow-black/20"
            >
              <MousePointer size={12} />
              Select Parcels
            </button>
          )}

          {mapMode === 'parcel_select' && (
            <div className={`${settingSubjectForCma ? 'bg-amber-warm/15 border-amber-warm/40 text-amber-warm' : 'bg-olive-light/15 border-olive-light/40 text-olive-light'} backdrop-blur-md border rounded-xl px-3 py-2 text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-black/20`}>
              <MousePointer size={12} />
              {settingSubjectForCma
                ? `Mapping subject for "${viewingCMA?.subject_name || 'CMA'}"`
                : reselectingComp
                ? `Re-selecting: ${reselectingComp.property_name || reselectingComp.county || 'comp'}`
                : 'Tap to select parcels'}
            </div>
          )}

          {/* Draw mode */}
          {mapMode === 'view' && !drawingActive && (
            <button
              onClick={startDrawing}
              className="bg-ink-deep/85 backdrop-blur-md border border-ink-line/70 hover:border-olive-light/40 rounded-xl px-3 py-2 text-xs font-semibold text-cream-2-text hover:text-olive-light transition-colors flex items-center gap-1.5 shadow-lg shadow-black/20"
            >
              <Pencil size={12} />
              Draw Boundary
            </button>
          )}

          {drawingActive && (
            <div className="flex gap-1.5 items-stretch">
              <div className="bg-ink-deep/85 backdrop-blur-md border border-amber-warm/40 rounded-xl px-3 py-2 flex items-center gap-2.5 shadow-lg shadow-black/20">
                <Pencil size={14} className="text-amber-warm shrink-0" />
                <div className="flex flex-col leading-tight">
                  <span className="text-[10px] font-semibold text-amber-warm uppercase tracking-wider">
                    {drawVertexCount === 0
                      ? 'Click the first corner of the property'
                      : drawVertexCount < 3
                      ? `Keep clicking corners (${drawVertexCount} placed, need at least 3)`
                      : `${drawVertexCount} corners placed — click Finish or double-click to close`}
                  </span>
                  <span className="text-[9px] text-cream-2-text">
                    Press <kbd className="font-mono px-0.5 bg-ink-elev text-cream-1 rounded">Backspace</kbd> to remove last corner
                  </span>
                </div>
              </div>
              <button
                onClick={finishDrawing}
                disabled={drawVertexCount < 3}
                className={`backdrop-blur-md rounded-xl px-3 py-2 text-xs font-semibold transition-colors flex items-center gap-1.5 border shadow-lg shadow-black/20 ${
                  drawVertexCount >= 3
                    ? 'bg-olive-light/15 border-olive-light/40 text-olive-light hover:bg-olive-light/20 hover:border-olive-light/60 cursor-pointer'
                    : 'bg-ink-deep/60 border-ink-line/40 text-cream-3-text cursor-not-allowed'
                }`}
                title={drawVertexCount < 3 ? 'Place at least 3 corners first' : 'Close the polygon'}
              >
                <Check size={12} />
                Finish
              </button>
              <button
                onClick={startOverDrawing}
                className="bg-ink-deep/85 backdrop-blur-md border border-ink-line/70 hover:border-amber-warm/50 rounded-xl px-2.5 py-2 text-xs font-semibold text-cream-2-text hover:text-amber-warm transition-colors shadow-lg shadow-black/20"
                title="Discard and start over"
              >
                Start Over
              </button>
              <button
                onClick={stopDrawing}
                className="bg-ink-deep/85 backdrop-blur-md border border-ink-line/70 hover:border-red-400/50 rounded-xl px-2 text-xs font-semibold text-cream-2-text hover:text-red-300 transition-colors shadow-lg shadow-black/20"
                title="Cancel drawing (discards everything)"
              >
                <X size={12} />
              </button>
            </div>
          )}

          {/* Build CMA mode toggle */}
          {mapMode === 'view' && !drawingActive && !cmaMode && (
            <button
              onClick={startCMA}
              className="bg-ink-deep/85 backdrop-blur-md border border-ink-line/70 hover:border-slate-blue-light/40 rounded-xl px-3 py-2 text-xs font-semibold text-cream-2-text hover:text-slate-blue-light transition-colors flex items-center gap-1.5 shadow-lg shadow-black/20"
            >
              <FileText size={12} />
              Build CMA
            </button>
          )}

          {cmaMode && (
            <div className="bg-slate-blue/10 border border-slate-blue/30 rounded-xl px-3 py-2 text-xs font-bold text-slate-blue-2 flex items-center gap-1.5">
              <FileText size={12} />
              {cmaPhase === 'subject' ? 'CMA · Tap subject parcels' : 'CMA · Tap comp pins'}
            </div>
          )}

          {/* Combine + Discard (when something exists) */}
          {(drawnCount > 0 || selectedParcels.length > 0) && !drawingActive && (
            <div className="flex gap-1.5">
              <button
                onClick={combineAll}
                className="bg-olive-tint backdrop-blur-sm border border-olive-border hover:border-olive hover:bg-olive-tint rounded-xl px-3 py-2 text-xs font-bold text-olive-2 transition-colors flex items-center gap-1.5"
              >
                <Combine size={12} />
                Combine ({drawnCount + selectedParcels.length})
              </button>
              <button
                onClick={clearDrawings}
                className="bg-red-50 backdrop-blur-sm border border-red-200 hover:border-red-300 hover:bg-red-100 rounded-xl px-3 py-2 text-xs font-bold text-red-700 hover:text-red-800 transition-colors flex items-center gap-1.5"
                title="Discard everything and start over"
              >
                <Trash2 size={12} />
                Discard
              </button>
            </div>
          )}

          {/* Discard merged-boundary preview if it's lingering with no sheet open
              (rare edge case — sheet usually controls it, but a safety button) */}
          {sheetMode === 'none' && mergedAcres > 0 && !drawingActive && (
            <button
              onClick={clearDrawings}
              className="bg-red-50 backdrop-blur-sm border border-red-200 hover:border-red-300 hover:bg-red-100 rounded-xl px-3 py-2 text-xs font-bold text-red-700 hover:text-red-800 transition-colors flex items-center gap-1.5"
              title="Remove the boundary preview from the map"
            >
              <Trash2 size={12} />
              Clear Boundary
            </button>
          )}
        </div>

        {/* Stats bar */}
        <div className="absolute bottom-8 left-3 z-10">
          <div className="bg-white/90 backdrop-blur-sm border border-beige rounded-xl px-3 py-2 flex gap-4">
            <div>
              <p className="text-[9px] font-bold text-ink-3 uppercase tracking-wider">On Map</p>
              <p className="text-sm font-bold text-olive-2 font-mono">
                {comps.filter(c => c.latitude && c.longitude).length}
              </p>
            </div>
            <div>
              <p className="text-[9px] font-bold text-ink-3 uppercase tracking-wider">Total Comps</p>
              <p className="text-sm font-bold text-ink font-mono">{comps.length}</p>
            </div>
          </div>
        </div>
      </div>

      {/* CMA build panel */}
      {cmaMode && (() => {
        const selectedComps = comps.filter(c => cmaCompIds.includes(c.id));
        const ppas = selectedComps
          .map(c => c.ppa_land_only || c.price_per_acre || 0)
          .filter(v => v > 0);
        const acres = cmaSubjectParcels.reduce((s, p) => s + (p.acres || 0), 0);
        const ppaLow = ppas.length ? Math.min(...ppas) : 0;
        const ppaMid = ppas.length ? ppas.reduce((a, b) => a + b, 0) / ppas.length : 0;
        const ppaHigh = ppas.length ? Math.max(...ppas) : 0;

        return (
          <div className="hidden md:flex w-80 bg-white border-l border-beige flex-col overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-3 border-b border-beige flex-shrink-0">
              <div className="flex items-center gap-2">
                <FileText size={14} className="text-slate-blue-2" />
                <span className="font-bold text-sm">Build CMA</span>
              </div>
              <button onClick={cancelCMA} className="text-ink-3 hover:text-ink">
                <X size={16} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              {/* Subject */}
              <div className="bg-cream border border-beige rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-bold text-ink-3 uppercase tracking-wider">
                    {cmaEditingId ? 'Subject Tract (locked)' : 'Subject Tract'}
                  </p>
                  {cmaSubjectParcels.length > 0 && (
                    <span className="text-[10px] font-bold text-slate-blue-2 font-mono">
                      {cmaSubjectParcels.length} parcel{cmaSubjectParcels.length === 1 ? '' : 's'} · {acres.toFixed(1)} ac
                    </span>
                  )}
                </div>
                {cmaEditingId ? (
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-ink">{cmaSubjectMeta.name}</p>
                    <p className="text-[11px] text-ink-2">
                      {cmaSubjectMeta.county}, {cmaSubjectMeta.state}
                      {viewingCMA?.subject_acres != null && ` · ${viewingCMA.subject_acres} ac`}
                    </p>
                    <p className="text-[10px] text-ink-3 italic mt-1">
                      Subject is locked. Editing comp selection only.
                    </p>
                  </div>
                ) : cmaSubjectParcels.length === 0 ? (
                  <p className="text-xs text-ink-2 italic">
                    Tap one or more parcels on the map. Multiple parcels merge into a single subject tract.
                  </p>
                ) : (
                  <>
                    <input
                      value={cmaSubjectMeta.name}
                      onChange={(e) => setCmaSubjectMeta(m => ({ ...m, name: e.target.value }))}
                      placeholder="Subject name"
                      className="w-full bg-cream border border-beige rounded-md px-2 py-1.5 text-xs text-ink placeholder-ink-3 outline-none focus:border-slate-blue"
                    />
                    <input
                      value={cmaSubjectMeta.county}
                      onChange={(e) => setCmaSubjectMeta(m => ({ ...m, county: e.target.value }))}
                      placeholder="County"
                      className="w-full bg-cream border border-beige rounded-md px-2 py-1.5 text-xs text-ink placeholder-ink-3 outline-none focus:border-slate-blue"
                    />
                    <div className="space-y-1 max-h-32 overflow-y-auto pt-1">
                      {cmaSubjectParcels.map((p, i) => (
                        <div key={p.parcel_id} className="flex items-center justify-between bg-cream border border-beige rounded-md px-2 py-1">
                          <div className="min-w-0 flex-1 flex items-center gap-1.5">
                            <span className="text-[9px] font-bold text-slate-blue-2 font-mono">{i + 1}</span>
                            <span className="text-[11px] text-ink-2 truncate">{p.owner_name || p.parcel_id || 'parcel'}</span>
                          </div>
                          <span className="text-[10px] text-ink-3 font-mono mr-1.5">
                            {p.acres ? p.acres.toFixed(1) + ' ac' : '—'}
                          </span>
                          {cmaPhase === 'subject' && (
                            <button
                              onClick={() => toggleCmaSubjectParcel(p)}
                              className="text-ink-3 hover:text-red-500"
                              title="Remove"
                            >
                              <X size={10} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    {cmaPhase === 'subject' ? (
                      // Primary CTA — was bg-blue-500/20 + text-blue-200,
                      // a leftover from the dark theme that rendered as
                      // ghost-text on the new cream surface. Solid slate-
                      // blue + white text matches the app's "Save CMA"
                      // button and is legible at a glance.
                      <button
                        onClick={lockSubjectTract}
                        className="w-full mt-1 py-2 bg-slate-blue hover:bg-slate-blue-2 text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5 shadow-sm"
                      >
                        <Combine size={12} /> Lock Subject Tract → Pick Comps
                      </button>
                    ) : (
                      <button
                        onClick={unlockSubjectTract}
                        className="w-full mt-1 py-1.5 bg-cream border border-beige hover:border-slate-blue text-[11px] font-bold text-ink-2 hover:text-slate-blue-2 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                      >
                        <Pencil size={11} /> Edit Subject Parcels
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Smart suggest — visible when subject is locked or editing */}
              {(cmaPhase === 'comps' || cmaEditingId) && (
                <button
                  onClick={suggestComps}
                  disabled={suggestingComps}
                  className="w-full py-2.5 bg-gradient-to-r from-olive-tint to-blue-500/20 hover:from-olive-tint hover:to-blue-500/30 border border-olive-border hover:border-olive text-xs font-bold text-ink-2 rounded-xl transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  <Sparkles size={12} />
                  {suggestingComps ? 'Finding similar comps…' : 'Suggest Best Comps'}
                </button>
              )}

              {/* Comp picker */}
              <div className="bg-cream border border-beige rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-bold text-ink-3 uppercase tracking-wider">Selected Comps</p>
                  <span className="text-[10px] font-bold text-slate-blue-2 font-mono">{cmaCompIds.length}</span>
                </div>
                {cmaCompIds.length === 0 ? (
                  <p className="text-xs text-ink-2 italic">Click comp pins on the map to add them.</p>
                ) : (
                  <div className="space-y-1.5">
                    {selectedComps.map(c => (
                      <div key={c.id} className="flex items-center justify-between bg-cream border border-beige rounded-md px-2 py-1.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-bold text-ink truncate">{c.property_name || `${c.county} County`}</p>
                          <p className="text-[10px] text-ink-3 font-mono">
                            {formatAcres(c.acres)} · {formatPPA(c.ppa_land_only || c.price_per_acre || 0)}
                          </p>
                        </div>
                        <button
                          onClick={() => toggleCmaComp(c.id)}
                          className="text-ink-3 hover:text-red-500 ml-2"
                          title="Remove"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Value range */}
              {ppas.length > 0 && acres > 0 && (
                <div className="bg-slate-blue/10 border border-slate-blue/30 rounded-xl p-3 space-y-1">
                  <p className="text-[10px] font-bold text-slate-blue-2/80 uppercase tracking-wider mb-1">Estimated Value</p>
                  <div className="flex justify-between text-xs">
                    <span className="text-ink-2">Low</span>
                    <span className="font-mono font-bold text-slate-blue-2">{formatCurrency(ppaLow * acres)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-ink font-bold">Mid</span>
                    {/* text-blue-200 was leftover dark-theme — invisible on
                        the slate-blue/10 cream surface. Use the brand's
                        slate-blue-2 (dark enough for cream) with extra
                        weight so the headline value stands out. */}
                    <span className="font-mono font-bold text-slate-blue-2">{formatCurrency(ppaMid * acres)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-ink-2">High</span>
                    <span className="font-mono font-bold text-slate-blue-2">{formatCurrency(ppaHigh * acres)}</span>
                  </div>
                  <p className="text-[10px] text-ink-3 font-mono mt-1.5 pt-1.5 border-t border-slate-blue/20">
                    Range from {formatPPA(ppaLow)} to {formatPPA(ppaHigh)} · {acres.toFixed(0)} ac
                  </p>
                </div>
              )}

              {/* Save — was bg-blue-500 (Tailwind default blue, which
                  rendered as washed-out powder blue on cream). Switched
                  to the app's slate-blue brand color for consistency
                  with Lock Subject Tract above and the rest of the
                  CMA-blue accents. */}
              <button
                onClick={saveCMA}
                disabled={savingCMA || cmaCompIds.length === 0 || (!cmaEditingId && cmaSubjectParcels.length === 0)}
                className="w-full py-2.5 bg-slate-blue hover:bg-slate-blue-2 text-white rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
              >
                <Save size={14} />
                {savingCMA ? 'Saving…' : 'Save CMA'}
              </button>
              <button
                onClick={cancelCMA}
                className="w-full py-2 text-xs text-ink-3 hover:text-ink transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        );
      })()}

      {/* CMA Workspace panel — replaces the comp detail panel when ?cma=ID */}
      {viewingCMA && !cmaMode && (() => {
        const ids: string[] = viewingCMA.selected_comp_ids || [];
        const cmaComps = comps.filter(c => ids.includes(c.id));

        // Effective improvement value for a comp in this CMA: CMA-level
        // adjustment wins, else the comp's own improvement_value, else null.
        const effectiveImprovement = (c: Comp): { value: number | null; source: 'appraiser' | 'agent_verified' | 'broker_estimate' | null } => {
          const adj = compAdjustmentsDraft[c.id] || {};
          if (adj.improvement_value != null) {
            return { value: Number(adj.improvement_value), source: adj.improvement_source ?? null };
          }
          if (c.improvement_value != null) {
            return { value: Number(c.improvement_value), source: c.improvement_source ?? null };
          }
          return { value: null, source: null };
        };

        // All-in $/acre: existing logic, sale_price / acres
        const allInPpa = (c: Comp): number => {
          const acres = Number(c.acres) || 0;
          if (acres <= 0) return 0;
          const total = Number(c.sale_price) || 0;
          return total > 0 ? total / acres : (c.price_per_acre || 0);
        };
        // Land-only $/acre: subtract improvement_value when set; when not set,
        // assume zero improvements so the comp still contributes to the
        // land-only average (it'll equal all-in for that comp).
        const landOnlyPpa = (c: Comp): number | null => {
          const acres = Number(c.acres) || 0;
          if (acres <= 0) return null;
          const total = Number(c.sale_price) || 0;
          if (total <= 0) return null;
          const { value: imp } = effectiveImprovement(c);
          const adjusted = total - (imp ?? 0);
          return adjusted > 0 ? adjusted / acres : null;
        };

        // Stats
        const allInPpas = cmaComps.map(allInPpa).filter((v): v is number => v > 0);
        const landOnlyPpas = cmaComps
          .map(c => landOnlyPpa(c))
          .filter((v): v is number => v != null && v > 0);
        const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
        const allInLow = allInPpas.length ? Math.min(...allInPpas) : 0;
        const allInMid = avg(allInPpas);
        const allInHigh = allInPpas.length ? Math.max(...allInPpas) : 0;
        const landLow = landOnlyPpas.length ? Math.min(...landOnlyPpas) : 0;
        const landMid = avg(landOnlyPpas);
        const landHigh = landOnlyPpas.length ? Math.max(...landOnlyPpas) : 0;

        const subjAcres = Number(viewingCMA.subject_acres) || 0;
        const allInValue = allInMid * subjAcres;
        const landOnlyValue = landMid * subjAcres;
        const landOnlySampleSize = landOnlyPpas.length;

        const toggleExpanded = (id: string) => {
          setExpandedCompIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          });
        };

        return (
          <div className="hidden md:flex w-96 bg-white border-l border-beige flex-col overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-3 border-b border-beige flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <FileText size={14} className="text-slate-blue-2 flex-shrink-0" />
                <span className="font-bold text-sm truncate">{viewingCMA.subject_name}</span>
              </div>
              <button onClick={exitCmaWorkspace} className="text-ink-3 hover:text-ink flex-shrink-0">
                <X size={16} />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Subject summary — warm brick red to match the map pin
                  + boundary. Same visual identity across all three
                  surfaces: pin on map, boundary on map, badge here. */}
              <div className="bg-white border border-beige rounded-xl p-3 space-y-1">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#C8503F', boxShadow: '0 0 0 3px rgba(200,80,63,0.20)' }} />
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: '#C8503F' }}>Subject</p>
                </div>
                <p className="text-sm font-semibold text-ink">{viewingCMA.subject_name}</p>
                <p className="text-xs text-ink-2 font-mono tabular-nums">
                  {viewingCMA.subject_county}, {viewingCMA.subject_state} · {formatAcres(subjAcres)}
                </p>
              </div>

              {/* Action row */}
              <div className="grid grid-cols-2 gap-2">
                {(viewingCMA.subject_latitude == null || viewingCMA.subject_boundary_geojson == null) ? (
                  <button
                    onClick={startMapSubjectForCMA}
                    className="col-span-2 py-2 border rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5"
                    style={{ background: 'rgba(200,80,63,0.08)', borderColor: 'rgba(200,80,63,0.40)', color: '#C8503F' }}
                  >
                    <MapPin size={12} /> Map Subject Tract
                  </button>
                ) : null}
                <button
                  onClick={editCmaComps}
                  className="py-2 border border-slate-blue/30 bg-slate-blue/10 hover:bg-slate-blue/15 text-xs font-semibold text-slate-blue-2 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                >
                  <Pencil size={12} /> Edit / Add Comps
                </button>
                <button
                  onClick={copyShareLink}
                  className={`py-2 border text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
                    shareCopied
                      ? 'border-olive bg-olive-tint text-olive-2'
                      : 'border-olive-border bg-olive-tint hover:bg-olive-tint text-olive-2'
                  }`}
                >
                  {shareCopied ? <><Check size={12} /> Copied</> : <><Share2 size={12} /> Share Report</>}
                </button>
                <button
                  onClick={openCollaboratorModal}
                  className="py-2 border border-olive-border bg-olive-tint hover:bg-olive-tint text-xs font-bold text-ink-2 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                >
                  <Users size={12} />
                  Collaborate{collaboratorUserIds.size > 0 ? ` (${collaboratorUserIds.size})` : ''}
                </button>
                <button
                  onClick={exitCmaWorkspace}
                  className="col-span-2 py-2 border border-beige bg-cream hover:border-beige-2 text-xs font-bold text-ink-2 rounded-lg transition-colors"
                >
                  Exit Report
                </button>
              </div>

              {/* All-in average */}
              {/* CMA averages — vault tile pattern. White cards on cream,
                  ink labels, ONE colored numeral on the Mid row to tell
                  the story (olive for the headline $/Ac, amber for the
                  land-only adjustment). No tinted backgrounds; the color
                  cue is in the numeral alone. */}
              {allInPpas.length > 0 && (
                <div className="bg-white border border-beige rounded-xl overflow-hidden">
                  <div className="px-3 py-2 border-b border-beige flex items-center justify-between">
                    <p className="text-[10px] font-medium text-ink-2 uppercase tracking-[0.08em]">Average Total Price Per Acre</p>
                    <p className="text-[9px] text-ink-3 font-mono">{cmaComps.length} of {cmaComps.length} comps</p>
                  </div>
                  <table className="w-full text-xs">
                    <tbody className="font-mono">
                      <tr><td className="px-3 py-1.5 text-ink-2">Low</td><td className="text-right px-3 py-1.5 text-ink tabular-nums">{formatPPA(allInLow)}</td><td className="text-right px-3 py-1.5 text-ink tabular-nums">{formatCurrency(allInLow * subjAcres)}</td></tr>
                      <tr className="border-t border-beige/60"><td className="px-3 py-2 text-olive-2 font-semibold">Mid</td><td className="text-right px-3 py-2 text-olive-2 font-semibold tabular-nums">{formatPPA(allInMid)}</td><td className="text-right px-3 py-2 text-olive-2 font-semibold tabular-nums">{formatCurrency(allInValue)}</td></tr>
                      <tr className="border-t border-beige/60"><td className="px-3 py-1.5 text-ink-2">High</td><td className="text-right px-3 py-1.5 text-ink tabular-nums">{formatPPA(allInHigh)}</td><td className="text-right px-3 py-1.5 text-ink tabular-nums">{formatCurrency(allInHigh * subjAcres)}</td></tr>
                    </tbody>
                  </table>
                </div>
              )}

              {landOnlyPpas.length > 0 && (
                <div className="bg-white border border-beige rounded-xl overflow-hidden">
                  <div className="px-3 py-2 border-b border-beige flex items-center justify-between">
                    <p className="text-[10px] font-medium text-ink-2 uppercase tracking-[0.08em]">Average Adjusted Price Per Acre <span className="text-ink-3 normal-case tracking-normal">(land only)</span></p>
                    <p className="text-[9px] text-ink-3 font-mono">{landOnlySampleSize} of {cmaComps.length} comps</p>
                  </div>
                  <table className="w-full text-xs">
                    <tbody className="font-mono">
                      <tr><td className="px-3 py-1.5 text-ink-2">Low</td><td className="text-right px-3 py-1.5 text-ink tabular-nums">{formatPPA(landLow)}</td><td className="text-right px-3 py-1.5 text-ink tabular-nums">{formatCurrency(landLow * subjAcres)}</td></tr>
                      <tr className="border-t border-beige/60"><td className="px-3 py-2 text-amber-800 font-semibold">Mid</td><td className="text-right px-3 py-2 text-amber-800 font-semibold tabular-nums">{formatPPA(landMid)}</td><td className="text-right px-3 py-2 text-amber-800 font-semibold tabular-nums">{formatCurrency(landOnlyValue)}</td></tr>
                      <tr className="border-t border-beige/60"><td className="px-3 py-1.5 text-ink-2">High</td><td className="text-right px-3 py-1.5 text-ink tabular-nums">{formatPPA(landHigh)}</td><td className="text-right px-3 py-1.5 text-ink tabular-nums">{formatCurrency(landHigh * subjAcres)}</td></tr>
                    </tbody>
                  </table>
                </div>
              )}

              {/* ─── Broker Opinion of Value ──────────────────────────
                  Two modes, broker picks which way they're thinking about
                  the property:

                    Lump Sum (default):    single $/Acre OR Total number
                    Land + Improvements:   Land $/Ac + Improvement lump

                  Lump sum saves to broker_opinion_value (total $).
                  Breakdown saves to broker_opinion_land_value +
                  broker_opinion_improvement_value, plus
                  broker_opinion_value as the computed sum (backwards
                  compatibility for read paths). broker_opinion_mode
                  stores the active mode so the share report knows
                  which way to render. */}
              {(() => {
                // Save helper — writes all relevant columns for the active mode
                // and clears the inactive-mode columns. Optimistic local update
                // so the right-panel re-renders instantly. Now also handles the
                // optional house-breakdown columns (sqft, ppsf, additional vertical).
                const saveBov = async (patch: {
                  mode: BovMode | null;
                  total: number | null;
                  landValue: number | null;
                  improvementValue: number | null;
                  houseSqft?: number | null;
                  housePpsf?: number | null;
                  additionalVertical?: number | null;
                }) => {
                  const fields: any = {
                    broker_opinion_mode: patch.mode,
                    broker_opinion_value: patch.total,
                    broker_opinion_land_value: patch.landValue,
                    broker_opinion_improvement_value: patch.improvementValue,
                  };
                  // Only include house-breakdown columns if explicitly passed.
                  // Lump-sum mode writes them as null; breakdown writes
                  // whatever value the broker has typed.
                  if ('houseSqft' in patch) fields.broker_opinion_house_sqft = patch.houseSqft;
                  if ('housePpsf' in patch) fields.broker_opinion_house_ppsf = patch.housePpsf;
                  if ('additionalVertical' in patch) fields.broker_opinion_additional_vertical = patch.additionalVertical;

                  setViewingCMA((prev: any) => prev ? ({ ...prev, ...fields }) : prev);
                  const { error } = await supabase
                    .from('cmas')
                    .update(fields)
                    .eq('id', viewingCMA.id);
                  if (error) toast.error(error.message);
                };

                // ─── LUMP SUM handlers ───
                // Lump-sum mode clears ALL breakdown fields including the
                // optional house itemization (passing null for each).
                const lumpClear = {
                  mode: 'lump_sum' as BovMode | null,
                  landValue: null,
                  improvementValue: null,
                  houseSqft: null,
                  housePpsf: null,
                  additionalVertical: null,
                };
                const onPpaChange = (raw: string) => {
                  setBovPpaInput(raw);
                  const ppa = raw === '' ? NaN : Number(raw);
                  if (!Number.isFinite(ppa) || ppa <= 0) {
                    setBovTotalInput('');
                    saveBov({ ...lumpClear, total: null });
                    return;
                  }
                  if (subjAcres > 0) {
                    const total = ppa * subjAcres;
                    setBovTotalInput(String(Math.round(total)));
                    saveBov({ ...lumpClear, total });
                  }
                };
                const onTotalChange = (raw: string) => {
                  setBovTotalInput(raw);
                  const total = raw === '' ? NaN : Number(raw);
                  if (!Number.isFinite(total) || total <= 0) {
                    setBovPpaInput('');
                    saveBov({ ...lumpClear, total: null });
                    return;
                  }
                  if (subjAcres > 0) {
                    const ppa = total / subjAcres;
                    setBovPpaInput(String(Math.round(ppa)));
                  }
                  saveBov({ ...lumpClear, total });
                };

                // ─── BREAKDOWN handlers ───
                // Improvement breakdown helpers: derived improvement = (sqft × ppsf)
                // + additional vertical. When any of those three are set, they
                // become the source of truth; bovImprovementInput is computed.
                const parsePos = (s: string): number => {
                  const n = s === '' ? NaN : Number(s);
                  return Number.isFinite(n) && n > 0 ? n : 0;
                };
                const computedImprovementFromItems = (
                  sqft: number, ppsf: number, addl: number
                ): number => {
                  const house = (sqft > 0 && ppsf > 0) ? sqft * ppsf : 0;
                  return house + addl;
                };
                const hasItemizationFlag = (sqft: string, ppsf: string, addl: string): boolean => {
                  return parsePos(sqft) > 0 || parsePos(ppsf) > 0 || parsePos(addl) > 0;
                };

                // commitBreakdown unified — writes land, improvement total, AND
                // the optional house-breakdown columns. The improvement total
                // is either:
                //   - the broker's typed-direct lump (when no itemization), OR
                //   - the computed sum (house_sqft × ppsf) + additional_vertical
                const commitBreakdown = (
                  landValue: number | null,
                  improvementOverride: number | null,
                  itemization: { sqft: number; ppsf: number; addl: number } | null,
                ) => {
                  const land = landValue || 0;
                  // Resolve improvement: itemization wins when present
                  const itemized = itemization
                    ? computedImprovementFromItems(itemization.sqft, itemization.ppsf, itemization.addl)
                    : 0;
                  const improvement = itemization && itemized > 0
                    ? itemized
                    : (improvementOverride && improvementOverride > 0 ? improvementOverride : 0);
                  const total = (land + improvement) > 0 ? (land + improvement) : null;

                  saveBov({
                    mode: 'breakdown',
                    total,
                    landValue: landValue,
                    improvementValue: improvement > 0 ? improvement : null,
                    houseSqft: itemization && itemization.sqft > 0 ? itemization.sqft : null,
                    housePpsf: itemization && itemization.ppsf > 0 ? itemization.ppsf : null,
                    additionalVertical: itemization && itemization.addl > 0 ? itemization.addl : null,
                  });
                };
                // Helper to collect current itemization state from inputs
                const currentItemization = (sqft?: string, ppsf?: string, addl?: string) => {
                  const s = parsePos(sqft ?? bovHouseSqftInput);
                  const p = parsePos(ppsf ?? bovHousePpsfInput);
                  const a = parsePos(addl ?? bovAddlVerticalInput);
                  const has = s > 0 || p > 0 || a > 0;
                  return has ? { sqft: s, ppsf: p, addl: a } : null;
                };
                const currentLand = () => {
                  const v = parsePos(bovLandTotalInput);
                  return v > 0 ? v : null;
                };
                const currentImpLump = () => {
                  const v = parsePos(bovImprovementInput);
                  return v > 0 ? v : null;
                };

                const onLandPpaChange = (raw: string) => {
                  setBovLandPpaInput(raw);
                  const ppa = raw === '' ? NaN : Number(raw);
                  if (!Number.isFinite(ppa) || ppa <= 0) {
                    setBovLandTotalInput('');
                    commitBreakdown(null, currentImpLump(), currentItemization());
                    return;
                  }
                  if (subjAcres > 0) {
                    const landValue = ppa * subjAcres;
                    setBovLandTotalInput(String(Math.round(landValue)));
                    commitBreakdown(landValue, currentImpLump(), currentItemization());
                  }
                };
                const onLandTotalChange = (raw: string) => {
                  setBovLandTotalInput(raw);
                  const landValue = raw === '' ? NaN : Number(raw);
                  if (!Number.isFinite(landValue) || landValue <= 0) {
                    setBovLandPpaInput('');
                    commitBreakdown(null, currentImpLump(), currentItemization());
                    return;
                  }
                  if (subjAcres > 0) {
                    const ppa = landValue / subjAcres;
                    setBovLandPpaInput(String(Math.round(ppa)));
                  }
                  commitBreakdown(landValue, currentImpLump(), currentItemization());
                };
                // Direct Improvement Value input — only used when itemization
                // is NOT active. When itemized, this field is computed/read-only.
                const onImprovementChange = (raw: string) => {
                  setBovImprovementInput(raw);
                  // If broker types directly in Improvement Value, clear any
                  // existing itemization (they're going lump mode within the
                  // breakdown). Carries over land value.
                  setBovHouseSqftInput('');
                  setBovHousePpsfInput('');
                  setBovAddlVerticalInput('');
                  const imp = parsePos(raw);
                  commitBreakdown(currentLand(), imp > 0 ? imp : null, null);
                };
                // House SQFT input — recomputes improvement from items
                const onHouseSqftChange = (raw: string) => {
                  setBovHouseSqftInput(raw);
                  const items = currentItemization(raw, undefined, undefined);
                  const newImpComputed = items ? computedImprovementFromItems(items.sqft, items.ppsf, items.addl) : 0;
                  setBovImprovementInput(newImpComputed > 0 ? String(Math.round(newImpComputed)) : '');
                  commitBreakdown(currentLand(), null, items);
                };
                const onHousePpsfChange = (raw: string) => {
                  setBovHousePpsfInput(raw);
                  const items = currentItemization(undefined, raw, undefined);
                  const newImpComputed = items ? computedImprovementFromItems(items.sqft, items.ppsf, items.addl) : 0;
                  setBovImprovementInput(newImpComputed > 0 ? String(Math.round(newImpComputed)) : '');
                  commitBreakdown(currentLand(), null, items);
                };
                const onAddlVerticalChange = (raw: string) => {
                  setBovAddlVerticalInput(raw);
                  const items = currentItemization(undefined, undefined, raw);
                  const newImpComputed = items ? computedImprovementFromItems(items.sqft, items.ppsf, items.addl) : 0;
                  setBovImprovementInput(newImpComputed > 0 ? String(Math.round(newImpComputed)) : '');
                  commitBreakdown(currentLand(), null, items);
                };

                // ─── Mode switching — preserve values across switches ───
                const switchToLumpSum = () => {
                  // If broker had Land + Improvement values, sum them to the lump total
                  const land = parsePos(bovLandTotalInput);
                  const imp = parsePos(bovImprovementInput);
                  const combined = land + imp;
                  setBovMode('lump_sum');
                  // Clear the house-breakdown UI state on mode flip
                  setBovHouseSqftInput('');
                  setBovHousePpsfInput('');
                  setBovAddlVerticalInput('');
                  setBovHouseBreakdownOpen(false);
                  if (combined > 0) {
                    setBovTotalInput(String(Math.round(combined)));
                    if (subjAcres > 0) setBovPpaInput(String(Math.round(combined / subjAcres)));
                    saveBov({ ...lumpClear, total: combined });
                  } else {
                    saveBov({ ...lumpClear, total: null });
                  }
                };
                const switchToBreakdown = () => {
                  // If broker had a lump total, transfer it to Land Value (assume no improvement yet)
                  const lump = parsePos(bovTotalInput);
                  setBovMode('breakdown');
                  if (lump > 0) {
                    setBovLandTotalInput(String(Math.round(lump)));
                    if (subjAcres > 0) setBovLandPpaInput(String(Math.round(lump / subjAcres)));
                    saveBov({
                      mode: 'breakdown',
                      total: lump,
                      landValue: lump,
                      improvementValue: null,
                      houseSqft: null,
                      housePpsf: null,
                      additionalVertical: null,
                    });
                  } else {
                    saveBov({
                      mode: 'breakdown',
                      total: null,
                      landValue: null,
                      improvementValue: null,
                      houseSqft: null,
                      housePpsf: null,
                      additionalVertical: null,
                    });
                  }
                };

                // Placeholders pull from CMA averages so the broker sees
                // suggested numbers if they leave fields blank.
                const ppaPlaceholder = landMid > 0 ? Math.round(landMid).toString()
                  : allInMid > 0 ? Math.round(allInMid).toString() : '';
                const totalPlaceholder = landOnlyValue > 0 ? Math.round(landOnlyValue).toString()
                  : allInValue > 0 ? Math.round(allInValue).toString() : '';

                // Computed total in breakdown mode (live, from local inputs)
                const breakdownLandNum = bovLandTotalInput === '' ? 0 : Number(bovLandTotalInput);
                const breakdownImpNum = bovImprovementInput === '' ? 0 : Number(bovImprovementInput);
                const breakdownTotal = (Number.isFinite(breakdownLandNum) ? breakdownLandNum : 0)
                                     + (Number.isFinite(breakdownImpNum) ? breakdownImpNum : 0);

                // Shared input class
                const inputCls = 'w-full bg-white border border-beige focus:border-olive focus:ring-2 focus:ring-olive/20 rounded-lg pl-6 pr-2 py-2 text-sm text-ink font-mono tabular-nums outline-none transition-all';

                return (
                  <div className="bg-white border border-beige rounded-xl p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] font-medium text-ink-2 uppercase tracking-[0.08em]">Your Opinion of Value</p>
                      <p className="text-[9px] text-ink-3">optional</p>
                    </div>

                    {/* Mode toggle — Lump Sum vs Land + Improvements */}
                    <div className="grid grid-cols-2 gap-0.5 p-0.5 bg-cream border border-beige rounded-lg">
                      <button
                        type="button"
                        onClick={switchToLumpSum}
                        className={`py-1.5 rounded-md text-[11px] font-semibold transition-colors ${
                          bovMode === 'lump_sum'
                            ? 'bg-white text-ink shadow-sm border border-beige-2'
                            : 'text-ink-2 hover:text-ink'
                        }`}
                      >
                        Lump Sum
                      </button>
                      <button
                        type="button"
                        onClick={switchToBreakdown}
                        className={`py-1.5 rounded-md text-[11px] font-semibold transition-colors ${
                          bovMode === 'breakdown'
                            ? 'bg-white text-ink shadow-sm border border-beige-2'
                            : 'text-ink-2 hover:text-ink'
                        }`}
                      >
                        Land + Improvements
                      </button>
                    </div>

                    {bovMode === 'lump_sum' ? (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <p className="text-[9px] text-ink-3 uppercase tracking-[0.06em] mb-1">$/Acre</p>
                            <div className="relative">
                              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-2 text-xs">$</span>
                              <input type="number" placeholder={ppaPlaceholder} value={bovPpaInput} onChange={(e) => onPpaChange(e.target.value)} className={inputCls} />
                            </div>
                          </div>
                          <div>
                            <p className="text-[9px] text-ink-3 uppercase tracking-[0.06em] mb-1">Total</p>
                            <div className="relative">
                              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-2 text-xs">$</span>
                              <input type="number" placeholder={totalPlaceholder} value={bovTotalInput} onChange={(e) => onTotalChange(e.target.value)} className={inputCls} />
                            </div>
                          </div>
                        </div>
                        <p className="text-[10px] text-ink-3 leading-relaxed">
                          Edit either field — the other auto-calculates from {formatAcres(subjAcres)}.
                        </p>
                      </>
                    ) : (
                      <>
                        {/* Land Value group */}
                        <div className="space-y-1.5">
                          <p className="text-[9px] font-medium text-ink-2 uppercase tracking-[0.08em]">Land Value</p>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <p className="text-[9px] text-ink-3 uppercase tracking-[0.06em] mb-1">$/Acre</p>
                              <div className="relative">
                                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-2 text-xs">$</span>
                                <input type="number" placeholder={ppaPlaceholder} value={bovLandPpaInput} onChange={(e) => onLandPpaChange(e.target.value)} className={inputCls} />
                              </div>
                            </div>
                            <div>
                              <p className="text-[9px] text-ink-3 uppercase tracking-[0.06em] mb-1">Total</p>
                              <div className="relative">
                                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-2 text-xs">$</span>
                                <input type="number" placeholder={totalPlaceholder} value={bovLandTotalInput} onChange={(e) => onLandTotalChange(e.target.value)} className={inputCls} />
                              </div>
                            </div>
                          </div>
                          <p className="text-[10px] text-ink-3 leading-relaxed">
                            Edit either — auto-calculates from {formatAcres(subjAcres)}.
                          </p>
                        </div>

                        {/* Improvement Value
                            When the house-breakdown sub-fields are filled in,
                            this becomes a computed total: (sqft × ppsf) + additional.
                            When the broker types directly here, the itemization
                            sub-fields are cleared. */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <p className="text-[9px] font-medium text-ink-2 uppercase tracking-[0.08em]">Improvement Value</p>
                            <button
                              type="button"
                              onClick={() => setBovHouseBreakdownOpen((v) => !v)}
                              className="text-[10px] text-ink-2 hover:text-olive-2 transition-colors flex items-center gap-1"
                            >
                              {bovHouseBreakdownOpen ? <><ChevronUp size={11} /> Hide house breakdown</> : <><ChevronDown size={11} /> Break out house</>}
                            </button>
                          </div>
                          <div className="relative">
                            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-2 text-xs">$</span>
                            <input
                              type="number"
                              placeholder="0"
                              value={bovImprovementInput}
                              onChange={(e) => onImprovementChange(e.target.value)}
                              disabled={hasItemizationFlag(bovHouseSqftInput, bovHousePpsfInput, bovAddlVerticalInput)}
                              className={`${inputCls} ${hasItemizationFlag(bovHouseSqftInput, bovHousePpsfInput, bovAddlVerticalInput) ? 'opacity-70 cursor-not-allowed' : ''}`}
                              title={hasItemizationFlag(bovHouseSqftInput, bovHousePpsfInput, bovAddlVerticalInput) ? 'Computed from the house breakdown below. Clear those fields to edit directly.' : ''}
                            />
                          </div>
                          {/* Optional house-breakdown expander */}
                          {bovHouseBreakdownOpen && (
                            <div className="bg-cream border border-beige rounded-lg p-2.5 space-y-3 mt-1">
                              {/* HOUSE — SQFT × $/SQFT */}
                              <div className="space-y-1.5">
                                <p className="text-[9px] font-medium text-ink-2 uppercase tracking-[0.06em]">House</p>
                                <div className="grid grid-cols-2 gap-2">
                                  <div>
                                    <p className="text-[9px] text-ink-3 uppercase tracking-[0.04em] mb-0.5">SQFT</p>
                                    <input
                                      type="number"
                                      placeholder="4,000"
                                      value={bovHouseSqftInput}
                                      onChange={(e) => onHouseSqftChange(e.target.value)}
                                      className="w-full bg-white border border-beige focus:border-olive focus:ring-2 focus:ring-olive/20 rounded-md px-2 py-1.5 text-sm text-ink font-mono tabular-nums outline-none transition-all"
                                    />
                                  </div>
                                  <div>
                                    <p className="text-[9px] text-ink-3 uppercase tracking-[0.04em] mb-0.5">$/SQFT</p>
                                    <div className="relative">
                                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-2 text-xs">$</span>
                                      <input
                                        type="number"
                                        placeholder="200"
                                        value={bovHousePpsfInput}
                                        onChange={(e) => onHousePpsfChange(e.target.value)}
                                        className="w-full bg-white border border-beige focus:border-olive focus:ring-2 focus:ring-olive/20 rounded-md pl-5 pr-2 py-1.5 text-sm text-ink font-mono tabular-nums outline-none transition-all"
                                      />
                                    </div>
                                  </div>
                                </div>
                                {/* Live line total */}
                                {(parsePos(bovHouseSqftInput) > 0 && parsePos(bovHousePpsfInput) > 0) && (
                                  <p className="text-[10px] text-ink-3 font-mono tabular-nums">
                                    {parsePos(bovHouseSqftInput).toLocaleString()} sqft × ${parsePos(bovHousePpsfInput).toLocaleString()}/sqft
                                    <span className="text-ink-2"> = </span>
                                    <span className="text-olive-2 font-semibold">{formatCurrency(parsePos(bovHouseSqftInput) * parsePos(bovHousePpsfInput))}</span>
                                  </p>
                                )}
                              </div>

                              {/* ADDITIONAL VERTICAL IMPROVEMENTS — lump */}
                              <div className="space-y-1.5">
                                <p className="text-[9px] font-medium text-ink-2 uppercase tracking-[0.06em]">Additional Vertical Improvements</p>
                                <div className="relative">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-2 text-xs">$</span>
                                  <input
                                    type="number"
                                    placeholder="0"
                                    value={bovAddlVerticalInput}
                                    onChange={(e) => onAddlVerticalChange(e.target.value)}
                                    className="w-full bg-white border border-beige focus:border-olive focus:ring-2 focus:ring-olive/20 rounded-md pl-5 pr-2 py-1.5 text-sm text-ink font-mono tabular-nums outline-none transition-all"
                                  />
                                </div>
                                <p className="text-[9px] text-ink-3 leading-relaxed">
                                  Barns, shops, sheds, equipment buildings, guest houses, etc. Horizontal improvements (fencing, ponds, wells) typically get baked into Land $/Acre above.
                                </p>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Total Opinion — computed sum */}
                        <div className="border-t border-beige pt-2 flex items-baseline justify-between">
                          <p className="text-[10px] font-medium text-ink-2 uppercase tracking-[0.08em]">Total Opinion</p>
                          <p className="text-base font-semibold text-olive-2 tabular-nums leading-tight">
                            {breakdownTotal > 0 ? formatCurrency(breakdownTotal) : '—'}
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Comps list */}
              <div className="space-y-2">
                <p className="text-[10px] font-bold text-ink-3 uppercase tracking-wider">Comparable Sales</p>
                {cmaComps.map((c) => {
                  const expanded = expandedCompIds.has(c.id);
                  const adj = compAdjustmentsDraft[c.id] || {};
                  const allIn = allInPpa(c);
                  const landOnly = landOnlyPpa(c);
                  const { value: effImp, source: effSrc } = effectiveImprovement(c);
                  const isHovered = hoveredCompId === c.id;
                  const isAdjusted = adj.improvement_value != null;
                  const isBrokerEstimated = effSrc === 'broker_estimate';
                  const editorOpen = adjustmentEditorOpen.has(c.id);
                  return (
                    <div
                      key={c.id}
                      onMouseEnter={() => setHoveredCompId(c.id)}
                      onMouseLeave={() => setHoveredCompId(prev => prev === c.id ? null : prev)}
                      className={`bg-cream border rounded-xl overflow-hidden transition-colors ${
                        isHovered ? 'border-slate-blue ring-2 ring-blue-400/30' : 'border-beige'
                      }`}
                    >
                      <button
                        onClick={() => toggleExpanded(c.id)}
                        className="w-full px-3 py-2 text-left"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-bold text-ink truncate flex-1 flex items-center gap-1.5">
                            <span className="truncate">{c.property_name || `${c.county} County`}</span>
                            {c.has_improvements && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 bg-olive-tint text-olive rounded flex-shrink-0">
                                IMPROVED
                              </span>
                            )}
                            {(c as any).irrigation === 'Strong' && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 bg-olive-tint text-olive rounded flex-shrink-0">
                                IRRIGATION
                              </span>
                            )}
                            {isAdjusted && <span className="text-[9px] text-amber-600 font-mono flex-shrink-0">ADJ</span>}
                            {effSrc === 'agent_verified' && (
                              <span
                                className="text-[9px] font-bold px-1.5 py-0.5 bg-olive-tint border border-olive-border text-olive-2 rounded flex-shrink-0"
                                title="An agent involved in this transaction verified the improvement value."
                              >
                                Agent-Verified
                              </span>
                            )}
                            {isBrokerEstimated && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-800 font-bold flex-shrink-0">
                                Broker-estimated
                              </span>
                            )}
                          </p>
                          {expanded ? <ChevronUp size={12} className="text-ink-3 flex-shrink-0" /> : <ChevronDown size={12} className="text-ink-3 flex-shrink-0" />}
                        </div>
                        <div className="grid grid-cols-4 gap-2 mt-1.5 text-[10px] font-mono">
                          <div>
                            <p className="text-ink-3">Acres</p>
                            <p className="text-ink font-bold">{formatAcres(c.acres)}</p>
                          </div>
                          <div>
                            <p className="text-ink-3">Total</p>
                            <p className="text-ink font-bold">{formatCurrency(c.sale_price)}</p>
                          </div>
                          <div>
                            <p className="text-ink-3">Total $/Ac</p>
                            <p className="text-olive-2 font-bold">{allIn > 0 ? formatPPA(allIn) : '—'}</p>
                          </div>
                          <div>
                            <p className="text-ink-3">Adjusted $/Ac</p>
                            <p className={`font-bold ${effImp != null ? 'text-amber-800' : 'text-amber-700/60'}`}>
                              {landOnly != null ? formatPPA(landOnly) : '—'}
                            </p>
                          </div>
                        </div>
                      </button>
                      {expanded && (
                        <div className="border-t border-beige bg-cream/30 px-3 py-2 space-y-1.5 text-[11px]">
                          {/* Per-comp broker note — editable textarea at the
                              top of expanded content so the broker drafts the
                              client-facing reasoning first. Mirrors the share
                              report's placement (read-only there). */}
                          <div className="pb-2 border-b border-beige/60 space-y-1">
                            <p className="text-[10px] font-bold text-slate-blue-2 uppercase tracking-wider">
                              Your Note on This Comp
                            </p>
                            <textarea
                              value={adj.broker_note ?? ''}
                              onChange={(e) => updateAdjustment(c.id, { broker_note: e.target.value })}
                              onClick={(e) => e.stopPropagation()}
                              placeholder="e.g. Most direct comparison — same river frontage and similar improvements."
                              rows={2}
                              className="w-full bg-cream border border-beige focus:border-slate-blue rounded px-2 py-1.5 text-[12px] text-ink outline-none resize-none"
                            />
                            <p className="text-[9px] text-ink-3">Shown to the client in the expanded comp on the share report.</p>
                          </div>

                          {/* Key facts — Sale date · Address · Improvements (+notes).
                              Same order as share report + standalone Comp Detail. */}
                          {c.sale_date && (
                            <div className="flex justify-between">
                              <span className="text-ink-3">Sale date</span>
                              <span className="text-ink-2 font-mono">{c.sale_date}</span>
                            </div>
                          )}
                          {c.address && (
                            <div className="flex justify-between gap-2">
                              <span className="text-ink-3 flex-shrink-0">Address</span>
                              <span className="text-ink-2 text-right truncate">{c.address}</span>
                            </div>
                          )}
                          {c.has_improvements && c.improvements_value != null && (
                            <div className="flex justify-between">
                              <span className="text-ink-3">Improvements</span>
                              <span className="text-slate-blue-2 font-mono">{formatCurrency(c.improvements_value)} ECV</span>
                            </div>
                          )}
                          {c.improvements_notes && (
                            <div className="pt-1">
                              <p className="text-ink-3 mb-0.5">Improvements notes</p>
                              <p className="text-ink-2 leading-relaxed">{c.improvements_notes}</p>
                            </div>
                          )}

                          {/* Land-character chips — sit below key facts so the
                              order reads facts → character → narrative across
                              every comp surface. */}
                          {(() => {
                            const irrigationVal = (c as any).irrigation as string | null;
                            return (
                              <div className="grid grid-cols-2 gap-2 pt-1">
                                <FeatureChip label="Water" value={c.water} strong={isStrongFeature('water', c.water)} />
                                <FeatureChip label="Road" value={c.road_frontage} strong={isStrongFeature('road', c.road_frontage)} />
                                <FeatureChip label="Dev" value={c.dev_potential} strong={isStrongFeature('dev', c.dev_potential)} />
                                <FeatureChip label="Irrigation" value={irrigationVal} strong={isStrongFeature('irrigation', irrigationVal)} />
                              </div>
                            );
                          })()}
                          {c.description && (() => {
                            const desc = c.description;
                            const sentences = desc
                              .split(/(?<=[.!?])\s+(?=[A-Z])/)
                              .map(s => s.trim())
                              .filter(Boolean);
                            const previewLen = 220;
                            const isExpanded = expandedDescriptionIds.has(c.id);
                            const previewBySentences = sentences.slice(0, 3).join(' ');
                            const preview = previewBySentences.length > 0 && previewBySentences.length < desc.length - 10
                              ? previewBySentences
                              : (desc.length > previewLen ? desc.slice(0, previewLen) + '…' : desc);
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
                                      setExpandedDescriptionIds(prev => {
                                        const next = new Set(prev);
                                        if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                                        return next;
                                      });
                                    }}
                                    className="mt-1 flex items-center gap-1 text-[10px] font-bold text-olive-2 hover:text-olive-2 transition-colors"
                                  >
                                    {isExpanded ? (<><ChevronUp size={11} /> Show less</>) : (<><ChevronDown size={11} /> Read more</>)}
                                  </button>
                                )}
                              </div>
                            );
                          })()}

                          {/* Improvement adjustment editor */}
                          <div className="pt-2 border-t border-beige/60 space-y-1.5">
                            <div className="flex items-center justify-between">
                              <p className="text-[10px] font-bold text-amber-600 uppercase tracking-wider">Improvement Adjustment</p>
                              {!editorOpen && effImp == null && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setAdjustmentEditorOpen(prev => new Set(prev).add(c.id));
                                  }}
                                  className="text-[10px] text-amber-800 hover:text-amber-900 font-bold underline"
                                >
                                  + Add adjustment
                                </button>
                              )}
                              {!editorOpen && effImp != null && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setAdjustmentEditorOpen(prev => new Set(prev).add(c.id));
                                  }}
                                  className="text-[10px] text-amber-800 hover:text-amber-900 font-bold underline"
                                >
                                  Edit
                                </button>
                              )}
                            </div>
                            {effImp != null && !editorOpen && (
                              <p className="text-[11px] text-ink-2 font-mono">
                                {formatCurrency(effImp)} <span className="text-ink-3">·</span>{' '}
                                <span className="text-ink-3">{effSrc === 'broker_estimate' ? 'Broker Estimate' : effSrc === 'appraiser' ? 'Appraiser' : '—'}</span>
                              </p>
                            )}
                            {effImp == null && !editorOpen && (
                              <p className="text-[11px] text-ink-3 italic">No improvement value set.</p>
                            )}
                            {editorOpen && (
                              <div className="space-y-2 bg-cream/40 border border-beige/60 rounded-lg p-2"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div>
                                  <p className="text-[9px] text-ink-3 mb-0.5">Improvement Value ($)</p>
                                  <input
                                    type="number"
                                    placeholder="e.g. 350000"
                                    value={adj.improvement_value ?? (c.improvement_value ?? '')}
                                    onChange={(e) => {
                                      const v = e.target.value === '' ? null : Number(e.target.value);
                                      updateAdjustment(c.id, { improvement_value: v });
                                    }}
                                    className="w-full bg-cream border border-beige focus:border-amber-500/60 rounded px-2 py-1 text-[12px] text-ink font-mono outline-none"
                                  />
                                </div>
                                <div>
                                  <p className="text-[9px] text-ink-3 mb-0.5">Source</p>
                                  <select
                                    value={(adj.improvement_source ?? c.improvement_source ?? '') as string}
                                    onChange={async (e) => {
                                      const v = e.target.value === '' ? null : (e.target.value as 'appraiser' | 'agent_verified' | 'broker_estimate');
                                      updateAdjustment(c.id, { improvement_source: v });
                                      // Agent-Verified auto-tags the verifier and timestamp on the
                                      // comp itself (back-end audit trail — never shown publicly).
                                      // Skipped silently if there's no signed-in user.
                                      if (v === 'agent_verified' && currentUserId) {
                                        await supabase
                                          .from('comps')
                                          .update({
                                            improvement_verified_by: currentUserId,
                                            improvement_verified_at: new Date().toISOString(),
                                          })
                                          .eq('id', c.id);
                                      }
                                    }}
                                    className="w-full bg-cream border border-beige focus:border-amber-500/60 rounded px-2 py-1 text-[12px] text-ink outline-none"
                                  >
                                    <option value="">Select…</option>
                                    <option value="appraiser">Appraiser Report</option>
                                    <option value="agent_verified">Agent-Verified (listing/buyer's agent)</option>
                                    <option value="broker_estimate">Broker Estimate</option>
                                  </select>
                                </div>
                                <div className="flex gap-2 pt-1">
                                  <button
                                    onClick={async () => {
                                      // Close the editor and flush immediately so the value
                                      // persists even if the user exits within debounce window.
                                      setAdjustmentEditorOpen(prev => {
                                        const next = new Set(prev);
                                        next.delete(c.id);
                                        return next;
                                      });
                                      if (viewingCMA?.id) {
                                        const ok = await flushAdjustments(viewingCMA.id, compAdjustmentsDraft);
                                        if (ok) toast.success('Adjustment saved');
                                      }
                                    }}
                                    className="flex-1 py-1.5 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded text-[11px] font-bold text-amber-800 transition-colors"
                                  >
                                    Save
                                  </button>
                                  <button
                                    onClick={() => {
                                      updateAdjustment(c.id, { improvement_value: null, improvement_source: null });
                                      setAdjustmentEditorOpen(prev => {
                                        const next = new Set(prev);
                                        next.delete(c.id);
                                        return next;
                                      });
                                    }}
                                    className="px-3 py-1.5 border border-beige hover:border-red-400 rounded text-[11px] font-bold text-ink-2 hover:text-red-500 transition-colors"
                                  >
                                    Clear
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Live listing search — not persisted, just shown */}
                          <div className="pt-2 border-t border-beige/60 space-y-1.5">
                            <p className="text-[10px] font-bold text-olive uppercase tracking-wider">Online Listing</p>
                            <button
                              onClick={(e) => { e.stopPropagation(); findListingForComp(c.id); }}
                              disabled={findingListingFor.has(c.id)}
                              className="text-[10px] flex items-center gap-1 px-2 py-1 bg-olive-tint hover:bg-olive-tint border border-olive-border hover:border-olive rounded text-ink-2 font-bold transition-colors disabled:opacity-50"
                            >
                              <Globe size={10} />
                              {findingListingFor.has(c.id)
                                ? 'Searching live…'
                                : liveListings[c.id]
                                ? 'Re-search'
                                : 'Find listing online'}
                            </button>
                            {liveListings[c.id]?.url && (() => {
                              const isSaved = savedListingFor.has(c.id);
                              const isSaving = savingListingFor.has(c.id);
                              const isAlreadyPersisted = (c as any).source_url === liveListings[c.id]?.url;
                              return (
                                <div className="space-y-1">
                                  <a
                                    href={liveListings[c.id]!.url!}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="inline-flex items-center gap-1.5 text-[11px] text-olive hover:text-ink-2 underline break-all"
                                  >
                                    <ExternalLink size={11} />
                                    {liveListings[c.id]!.url!.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}
                                    {liveListings[c.id]!.url!.length > 70 ? '…' : ''}
                                  </a>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); saveListingForComp(c.id); }}
                                    disabled={isSaving}
                                    className={`text-[10px] px-2 py-0.5 rounded font-bold transition-colors disabled:opacity-50 ${
                                      isSaved || isAlreadyPersisted
                                        ? 'bg-olive-tint border border-olive-border text-olive-2'
                                        : 'bg-olive-tint hover:bg-olive-tint border border-olive-border hover:border-olive text-ink-2'
                                    }`}
                                  >
                                    {isSaving
                                      ? 'Saving…'
                                      : isSaved || isAlreadyPersisted
                                      ? '✓ Saved to comp'
                                      : 'Save to comp (show on share)'}
                                  </button>
                                </div>
                              );
                            })()}
                            {liveListings[c.id] && !liveListings[c.id]?.url && (
                              <p className="text-[11px] text-ink-3 italic">{liveListings[c.id]!.reason || 'No matching listing found'}</p>
                            )}
                          </div>

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (c.latitude != null && c.longitude != null) {
                                map.current?.flyTo({ center: [c.longitude, c.latitude], zoom: 14, duration: 800 });
                              }
                            }}
                            className="text-[10px] text-slate-blue-2 hover:text-slate-blue-2 font-bold mt-1"
                          >
                            Fly to →
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {cmaComps.length === 0 && (
                  <p className="text-xs text-ink-3 italic text-center py-4">
                    No comps in this CMA yet. Use Edit / Add Comps in the banner.
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Collaborator picker — lets the CMA owner toggle which team members
          can view/edit this CMA. Only renders when invoked from the workspace. */}
      {collabOpen && viewingCMA && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white border border-beige rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-beige flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users size={14} className="text-olive" />
                <div>
                  <p className="font-bold text-sm text-ink">Collaborate on this CMA</p>
                  <p className="text-[11px] text-ink-3 mt-0.5">Selected teammates can view and edit from their dashboard.</p>
                </div>
              </div>
              <button onClick={() => setCollabOpen(false)} className="text-ink-3 hover:text-ink">
                <X size={16} />
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {collabLoading ? (
                <p className="text-center text-xs text-ink-3 py-8">Loading team…</p>
              ) : teamMembers.length === 0 ? (
                <div className="px-5 py-8 text-center space-y-2">
                  <p className="text-sm text-ink-2">No teammates found.</p>
                  <p className="text-[11px] text-ink-3">Add team members in Settings to enable collaboration.</p>
                </div>
              ) : (
                <ul className="divide-y divide-beige">
                  {teamMembers.map((m) => {
                    const isCollab = collaboratorUserIds.has(m.id);
                    const label = m.full_name || m.email || 'Teammate';
                    const initial = (m.full_name || m.email || '?').charAt(0).toUpperCase();
                    return (
                      <li key={m.id} className="px-5 py-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-8 h-8 rounded-full bg-olive-tint border border-olive-border flex items-center justify-center flex-shrink-0">
                            <span className="text-olive font-bold text-xs">{initial}</span>
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-ink truncate">{label}</p>
                            {m.email && m.full_name && (
                              <p className="text-[11px] text-ink-3 truncate">{m.email}</p>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => toggleCollaborator(m.id)}
                          className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-colors flex-shrink-0 ${
                            isCollab
                              ? 'bg-olive-tint border border-olive-border text-ink-2 hover:bg-olive-tint'
                              : 'bg-cream border border-beige hover:border-olive text-ink-2 hover:text-olive'
                          }`}
                        >
                          {isCollab ? '✓ Editor' : '+ Add'}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="px-5 py-3 border-t border-beige flex items-center justify-end">
              <button
                onClick={() => setCollabOpen(false)}
                className="px-4 py-2 bg-olive hover:bg-olive-2 text-white rounded-lg text-xs font-bold transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Comp detail panel */}
      {!cmaMode && !viewingCMA && selectedComp && (() => {
        const desc = selectedComp.description || '';
        // Split into sentences only at terminating punctuation followed by
        // whitespace + uppercase. Avoids false splits inside numbers like
        // "206.99 ac" or acronyms like "U.S."
        const sentences = desc
          .split(/(?<=[.!?])\s+(?=[A-Z])/)
          .map(s => s.trim())
          .filter(Boolean);
        const previewSentences = sentences.slice(0, 5).join(' ');
        const hasMore = sentences.length > 5;

        // Detect acres-in-description vs saved-acres mismatch. The description
        // is closest to the appraiser's prose, so a discrepancy with the saved
        // value usually means the saved value was pulled from a different field.
        const acresInDesc = (() => {
          const m = desc.match(/([0-9][0-9,]*(?:\.\d+)?)\s*[-]?\s*acres?\b/i);
          if (!m) return null;
          const v = parseFloat(m[1].replace(/,/g, ''));
          return Number.isFinite(v) ? v : null;
        })();
        const savedAcres = selectedComp.acres || 0;
        // Flag any meaningful deviation. Tolerate rounding (≤0.5 ac) but
        // surface anything bigger so the user can verify against the report.
        const acreageDiscrepancy =
          acresInDesc != null &&
          savedAcres > 0 &&
          Math.abs(acresInDesc - savedAcres) > 0.5;

        const conf = selectedComp.confidence;
        // Verified gets the slate-blue treatment — same color the vault uses
        // for its "Improved" badge. Universal "trust + status" affordance:
        // slate-blue means "this has been confirmed." Distinct from olive
        // (creation/state) and iMessage blue (chat send) so each color
        // carries one meaning.
        const confStyle =
          conf === 'Verified' ? { Icon: ShieldCheck, color: 'text-slate-blue-2', ring: 'border-slate-blue/20 bg-slate-blue/10' }
          : conf === 'Estimated' ? { Icon: ShieldAlert, color: 'text-amber-800', ring: 'border-amber-200 bg-amber-50' }
          : { Icon: ShieldQuestion, color: 'text-ink-2', ring: 'border-beige bg-cream' };

        return (
        <div className="hidden md:flex w-80 bg-white border-l border-beige flex-col overflow-y-auto">
          {/* Header bar — vault-style restraint: font-semibold not bold,
              subtle text size, calm proportions. Matches the "Comp Vault"
              title treatment in the main vault page. */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-beige flex-shrink-0">
            <span className="text-[13px] font-semibold text-ink tracking-tight">Comp Detail</span>
            <button onClick={() => setSelectedComp(null)} className="text-ink-3 hover:text-ink">
              <X size={16} />
            </button>
          </div>
          <div className="p-4 space-y-3">
            {/* Property name + subtitle. Same typography hierarchy the
                vault uses for its h1: font-semibold, tracking-tight,
                muted subtitle in text-ink-2. */}
            <div>
              <h2 className="text-base font-semibold text-ink tracking-tight leading-tight">{selectedComp.property_name || `${selectedComp.county} County`}</h2>
              <p className="text-[12px] text-ink-2 mt-1">{selectedComp.county}, {selectedComp.state}</p>
            </div>

            {/* Status badges — vault pill style (rounded-full, tighter
                padding, subtle borders). Vault's "Improved" table pill is
                the reference. Calm, restrained, single accent per badge. */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border ${confStyle.ring}`}>
                <confStyle.Icon size={11} className={confStyle.color} />
                <span className={`text-[10px] font-semibold ${confStyle.color}`}>{conf}</span>
              </span>
              {selectedComp.has_improvements && (
                <span className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 bg-slate-blue/10 text-slate-blue-2 border border-slate-blue/20 rounded-full">
                  Improved
                </span>
              )}
              {(selectedComp as any).irrigation === 'Strong' && (
                <span className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 bg-olive-tint text-olive-2 border border-olive-border rounded-full">
                  Irrigation
                </span>
              )}
              {selectedComp.improvement_source === 'agent_verified' && (
                <span
                  className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 bg-slate-blue/15 text-slate-blue-2 border border-slate-blue/30 rounded-full"
                  title="An agent involved in this transaction verified the improvement value."
                >
                  Agent-Verified
                </span>
              )}
            </div>

            {/* Stacked stats: Acres → Total Price → Price/Acre.
                When the comp carries an improvement_value adjustment we surface
                BOTH "All-in $/Ac" (raw sale price ÷ acres) AND "Land $/Ac"
                (adjusted, with improvements backed out). Land $/Ac is amber to
                mirror the broker workspace's color language. */}
            {(() => {
              const allIn = selectedComp.price_per_acre || 0;
              const landOnly = selectedComp.ppa_land_only || 0;
              // Show Land $/Ac whenever a land-only value exists that differs
              // from the all-in. Source-agnostic — covers ECV-imported comps
              // (improvements_value) AND explicit broker adjustments
              // (improvement_value). The DB-computed ppa_land_only is the
              // single source of truth for "something was backed out."
              const hasAdjustment = landOnly > 0 && allIn > 0 && Math.abs(allIn - landOnly) > 1;
              // Vault-style KPI tile pattern: white cards on cream, single
              // olive accent on the HEADLINE metric ($/Acre — what the
              // broker is actually evaluating). Everything else is calm
              // ink on white. Same typography stack as the vault's KPI
              // dashboard above the table so the system reads as one app.
              return (
                <div className="space-y-2">
                  <div className="bg-white border border-beige rounded-xl px-3 py-2.5 flex items-baseline justify-between">
                    <p className="text-[10px] font-medium text-ink-2 uppercase tracking-[0.08em]">Acres</p>
                    <p className="text-base font-semibold text-ink tabular-nums leading-tight">
                      {formatAcres(selectedComp.acres)}
                    </p>
                  </div>
                  <div className="bg-white border border-beige rounded-xl px-3 py-2.5 flex items-baseline justify-between">
                    <p className="text-[10px] font-medium text-ink-2 uppercase tracking-[0.08em]">Total Price</p>
                    <p className="text-base font-semibold text-ink tabular-nums leading-tight">
                      {formatCurrency(selectedComp.sale_price)}
                    </p>
                  </div>
                  {hasAdjustment ? (
                    <>
                      <div className="bg-white border border-beige rounded-xl px-3 py-2.5 flex items-baseline justify-between">
                        <p className="text-[10px] font-medium text-ink-2 uppercase tracking-[0.08em]">Total $/Ac</p>
                        <p className="text-base font-semibold text-olive-2 tabular-nums leading-tight">
                          {formatPPA(allIn)}
                        </p>
                      </div>
                      {/* Adjusted = the "story" metric — subtle amber accent
                          on the number only, white card to match the others.
                          No tinted background; the color cue is in the
                          numeral alone, which is what vault does. */}
                      <div className="bg-white border border-beige rounded-xl px-3 py-2.5 flex items-baseline justify-between">
                        <p className="text-[10px] font-medium text-ink-2 uppercase tracking-[0.08em]">Adjusted $/Ac</p>
                        <p className="text-base font-semibold text-amber-800 tabular-nums leading-tight">
                          {formatPPA(landOnly)}
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="bg-white border border-beige rounded-xl px-3 py-2.5 flex items-baseline justify-between">
                      <p className="text-[10px] font-medium text-ink-2 uppercase tracking-[0.08em]">Price Per Acre</p>
                      <p className="text-base font-semibold text-olive-2 tabular-nums leading-tight">
                        {formatPPA(selectedComp.ppa_land_only || selectedComp.price_per_acre || 0)}
                      </p>
                    </div>
                  )}
                </div>
              );
            })()}

            {acreageDiscrepancy && acresInDesc != null && selectedComp.created_by === currentUserId && (
              <div className="bg-amber-50 border border-amber-300 rounded-xl px-3 py-2 space-y-2">
                <div className="flex items-start gap-2">
                  <ShieldAlert size={14} className="text-amber-600 mt-0.5 flex-shrink-0" />
                  <div className="text-[11px] text-amber-800 leading-relaxed">
                    <span className="font-bold">Acreage discrepancy.</span> Description mentions{' '}
                    <span className="font-mono font-bold">{acresInDesc.toLocaleString()} ac</span>{' '}
                    but saved value is{' '}
                    <span className="font-mono font-bold">{savedAcres.toLocaleString()} ac</span>.
                  </div>
                </div>
                <button
                  onClick={() => fixAcresFromDescription(selectedComp.id, acresInDesc!)}
                  className="w-full py-1.5 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-lg text-[11px] font-bold text-amber-800 transition-colors"
                >
                  Use {acresInDesc.toLocaleString()} ac from description
                </button>
              </div>
            )}

            {/* Key facts — same row format as CMA expanded + share report
                expanded comp views. Format-unified across the three surfaces. */}
            <div className="space-y-1.5 text-[11px]">
              {selectedComp.sale_date && (
                <div className="flex justify-between">
                  <span className="text-ink-3">Sale date</span>
                  <span className="text-ink-2 font-mono">{selectedComp.sale_date}</span>
                </div>
              )}
              {selectedComp.address && (
                <div className="flex justify-between gap-2">
                  <span className="text-ink-3 flex-shrink-0">Address</span>
                  <span className="text-ink-2 text-right truncate">{selectedComp.address}</span>
                </div>
              )}
              {selectedComp.has_improvements && selectedComp.improvements_value != null && (
                <div className="flex justify-between">
                  <span className="text-ink-3">Improvements</span>
                  <span className="text-slate-blue-2 font-mono">{formatCurrency(selectedComp.improvements_value)} ECV</span>
                </div>
              )}
              {selectedComp.improvements_notes && (
                <div className="pt-1">
                  <p className="text-ink-3 mb-0.5">Improvements notes</p>
                  <p className="text-ink-2 leading-relaxed">{selectedComp.improvements_notes}</p>
                </div>
              )}
            </div>

            {/* ─── Source + Listing URL ──────────────────────────────
                AI find + manual paste. Same flow as the review page
                side panel — broker hits "Find listing online", AI
                searches Lands of America / LandWatch / Land.com /
                Realtor / Zillow, returns one URL or null, broker
                reviews + Save. Manual paste fallback always available.

                Only shown to the comp's owner (created_by) — the
                /api/comp/[id]/find-listing endpoint enforces this on
                the server side too. */}
            {selectedComp.created_by === currentUserId && (
            <div className="border-t border-beige pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wide text-ink-3">Listing</div>
                {(selectedComp as any).source_type && (
                  <div className="text-[10px] text-ink-2">
                    {(selectedComp as any).source_type === 'listing_url' ? 'From listing' : 'From PDF'}
                  </div>
                )}
              </div>

              {/* SAVED state */}
              {selectedComp.source_url && !listingCandidate && !pasteUrlMode && (
                <div className="bg-cream/40 border border-beige rounded-lg p-2 space-y-1.5">
                  <a
                    href={selectedComp.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-olive-2 hover:underline break-all text-[11px] flex items-start gap-1.5"
                  >
                    <ExternalLink size={11} className="flex-shrink-0 mt-0.5" />
                    <span>{selectedComp.source_url}</span>
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

              {/* AI FOUND state */}
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
                    <p className="text-[10px] text-ink-2 leading-relaxed">{listingCandidate.reason}</p>
                  )}
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      onClick={() => setListingCandidate(null)}
                      disabled={savingListing}
                      className="py-1.5 bg-cream hover:bg-cream-2 border border-beige text-ink-2 rounded text-[10px] font-bold flex items-center justify-center gap-1 disabled:opacity-40"
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

              {/* AI EMPTY state */}
              {listingCandidate && !listingCandidate.url && (
                <div className="bg-cream border border-beige rounded-lg p-2.5 space-y-1.5">
                  <div className="text-[10px] font-bold text-ink-2 uppercase tracking-wide">
                    No confident match
                  </div>
                  {listingCandidate.reason && (
                    <p className="text-[10px] text-ink-2 leading-relaxed">{listingCandidate.reason}</p>
                  )}
                  <p className="text-[10px] text-ink-3">Try again later or paste a URL manually below.</p>
                  <button
                    onClick={() => setListingCandidate(null)}
                    className="text-[10px] text-ink-3 hover:text-ink-2 underline"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* MANUAL PASTE state */}
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
                      className="py-1.5 bg-cream hover:bg-cream-2 border border-beige text-ink-2 rounded text-[10px] font-bold"
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

              {/* DEFAULT state */}
              {!selectedComp.source_url && !listingCandidate && !pasteUrlMode && (
                <div className="space-y-1.5">
                  <button
                    onClick={handleFindListing}
                    disabled={findingListing}
                    // iMessage blue — "Find listing online" is an AI search
                    // action (sends the comp to the AI to hunt for a
                    // matching public listing). Same family as the Ask
                    // button: blue = "send to AI." Makes the right panel's
                    // primary action visually distinct from the olive +
                    // slate-blue surrounding chrome.
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
            </div>
            )}

            {/* Land character grid — Water · Road · Dev · Irrigation.
                Strong tiers light emerald. Same chips as every other surface. */}
            {(() => {
              const irrigationVal = (selectedComp as any).irrigation as string | null;
              return (
                <div className="grid grid-cols-2 gap-2">
                  {/* Strong-state palette per attr: water→sky, dev→purple,
                      road/irrigation→olive. Adds tasteful color variety to
                      the right panel without becoming a rainbow. Each color
                      carries semantic meaning (water=blue universal, dev=
                      purple for "growth/future"). */}
                  <FeatureChip label="Water" value={selectedComp.water} strong={isStrongFeature('water', selectedComp.water)} attr="water" />
                  <FeatureChip label="Road" value={selectedComp.road_frontage} strong={isStrongFeature('road', selectedComp.road_frontage)} attr="road" />
                  <FeatureChip label="Dev" value={selectedComp.dev_potential} strong={isStrongFeature('dev', selectedComp.dev_potential)} attr="dev" />
                  <FeatureChip label="Irrigation" value={irrigationVal} strong={isStrongFeature('irrigation', irrigationVal)} attr="irrigation" />
                </div>
              );
            })()}

            {/* Description with sentence-aware Read more.
                Inline pattern (no card border) to match CMA expanded + share report. */}
            {desc && (
              <div className="pt-1">
                <p className="text-[10px] font-bold text-ink-3 uppercase tracking-wider mb-1">Description</p>
                <p className="text-[11px] text-ink-2 leading-relaxed whitespace-pre-wrap">
                  {descriptionExpanded ? desc : previewSentences}
                </p>
                {hasMore && (
                  <button
                    onClick={() => setDescriptionExpanded(v => !v)}
                    className="mt-1 flex items-center gap-1 text-[10px] font-bold text-olive-2 hover:text-olive-2 transition-colors"
                  >
                    {descriptionExpanded ? (<><ChevronUp size={11} /> Show less</>) : (<><ChevronDown size={11} /> Read more</>)}
                  </button>
                )}
              </div>
            )}

            {/* Ownership transfer */}
            {(selectedComp.grantor || selectedComp.grantee) && (
              <div className="bg-cream border border-beige rounded-xl p-3">
                <p className="text-[9px] font-bold text-ink-3 uppercase tracking-wider mb-2">Ownership Transfer</p>
                <div className="space-y-1.5">
                  {selectedComp.grantor && (
                    <div>
                      <p className="text-[9px] text-ink-3 font-bold uppercase tracking-wider">From</p>
                      <p className="text-xs font-semibold text-ink">{selectedComp.grantor}</p>
                    </div>
                  )}
                  {selectedComp.grantor && selectedComp.grantee && (
                    <div className="flex justify-center"><ArrowRight size={12} className="text-ink-3" /></div>
                  )}
                  {selectedComp.grantee && (
                    <div>
                      <p className="text-[9px] text-ink-3 font-bold uppercase tracking-wider">To</p>
                      <p className="text-xs font-semibold text-ink">{selectedComp.grantee}</p>
                    </div>
                  )}
                </div>
                {selectedComp.recording_number && (
                  <p className="text-[10px] text-ink-3 font-mono mt-2 pt-2 border-t border-beige">
                    Recording: {selectedComp.recording_number}
                  </p>
                )}
              </div>
            )}

            {selectedComp.created_by === currentUserId && selectedComp.latitude != null && (
              <div className="space-y-2">
                {!(selectedComp as any).boundary_geojson ? (
                  <button
                    onClick={detectBoundary}
                    disabled={detectingBoundary}
                    className="w-full py-2.5 bg-olive-tint border border-olive-border hover:bg-olive-tint hover:border-olive text-sm font-bold text-olive-2 rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    <MapPin size={14} />
                    {detectingBoundary ? 'Detecting…' : 'Detect Property Boundary'}
                  </button>
                ) : (
                  <button
                    onClick={detectBoundary}
                    disabled={detectingBoundary}
                    className="w-full py-2 bg-cream border border-beige hover:border-olive text-xs font-bold text-ink-2 hover:text-olive-2 rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    <MapPin size={12} />
                    {detectingBoundary ? 'Re-detecting…' : 'Re-detect Boundary'}
                  </button>
                )}

                <button
                  onClick={() => startReselectParcels(selectedComp)}
                  className="w-full py-2 bg-cream border border-beige hover:border-olive text-xs font-bold text-ink-2 hover:text-olive-2 rounded-xl transition-colors flex items-center justify-center gap-1.5"
                >
                  <MousePointer size={12} /> Re-select Parcels
                </button>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => startEditBoundary(selectedComp)}
                    disabled={!(selectedComp as any).boundary_geojson}
                    className="py-2 bg-cream border border-beige hover:border-amber-500/60 text-xs font-bold text-ink-2 hover:text-amber-600 rounded-xl transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Pencil size={12} /> Edit
                  </button>
                  <button
                    onClick={clearBoundary}
                    disabled={!(selectedComp as any).boundary_geojson}
                    className="py-2 bg-cream border border-beige hover:border-red-400 text-xs font-bold text-ink-2 hover:text-red-500 rounded-xl transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 size={12} /> Clear
                  </button>
                </div>
              </div>
            )}

            {selectedComp.created_by === currentUserId && (
              <button onClick={() => setEditingComp(selectedComp)}
                className="w-full py-2.5 bg-cream border border-beige hover:border-olive text-sm font-bold text-ink-2 hover:text-ink rounded-xl transition-colors flex items-center justify-center gap-2">
                <Edit size={14} /> Edit Comp
              </button>
            )}
          </div>
        </div>
        );
      })()}

      {/* Parcel sheets */}
      {sheetMode === 'parcel' && tappedParcel && mapMode === 'view' && (
        <ParcelBottomSheet
          parcel={tappedParcel}
          selectedParcels={selectedParcels}
          mode="single"
          onCreateBoundary={handleCreateBoundary}
          onSelectMore={() => {
            setMapMode('parcel_select');
            setSheetMode('selecting');
            handleAddParcelToSelection(tappedParcel);
          }}
          onAddParcel={handleAddParcelToSelection}
          onRemoveParcel={(id) => setSelectedParcels(prev => prev.filter(p => p.parcel_id !== id))}
          onCancel={() => { setSheetMode('none'); setTappedParcel(null); }}
          onCreateAsSubject={(parcel) => {
            setSheetMode('none');
            setTappedParcel(null);
            // Enter CMA mode pre-seeded with this parcel as the subject and
            // immediately lock so the user can start tapping comp pins.
            setCmaMode(true);
            setCmaEditingId(null);
            setCmaSubjectParcels([parcel]);
            setCmaSubjectMeta({
              name: parcel.owner_name || `${parcel.county || 'TX'} subject`,
              county: parcel.county || '',
              state: parcel.state || 'TX',
            });
            setCmaCompIds([]);
            setCmaPhase('comps');
            // Render the locked subject as merged-boundary
            if (map.current && mapLoaded && parcel.geometry) {
              try {
                const mergedSrc = map.current.getSource('merged-boundary') as mapboxgl.GeoJSONSource | undefined;
                if (mergedSrc) {
                  mergedSrc.setData({
                    type: 'FeatureCollection',
                    features: [{ type: 'Feature', properties: {}, geometry: parcel.geometry }],
                  });
                }
                const sel = map.current.getSource('selected-parcels') as mapboxgl.GeoJSONSource | undefined;
                if (sel) sel.setData({ type: 'FeatureCollection', features: [] });
              } catch {}
            }
            toast.success(
              `Subject: ${parcel.owner_name || parcel.county || 'parcel'} (${parcel.acres ? parcel.acres.toFixed(1) + ' ac' : 'no acres'}). Tap comp pins.`,
              { duration: 4000 }
            );
          }}
        />
      )}

      {mapMode === 'parcel_select' && sheetMode !== 'boundary_created' && (
        <ParcelBottomSheet
          parcel={tappedParcel || { parcel_id: '', owner_name: null, acres: null, address: null, county: null, state: 'TX', latitude: 0, longitude: 0, geometry: null }}
          selectedParcels={selectedParcels}
          mode="selecting"
          onCreateBoundary={handleCreateBoundary}
          onSelectMore={() => {}}
          onAddParcel={handleAddParcelToSelection}
          onRemoveParcel={(id) => setSelectedParcels(prev => prev.filter(p => p.parcel_id !== id))}
          onCancel={() => { resetParcelState(); setSheetMode('none'); }}
        />
      )}

      {sheetMode === 'boundary_created' && (
        <BoundaryCreatedSheet
          parcels={allParcels}
          totalAcres={mergedAcres}
          onAddAsNewComp={handleAddAsNewComp}
          onAttachToComp={() => { toast('Open the vault to attach this boundary', { icon: '📎' }); setSheetMode('none'); resetParcelState(); }}
          onSaveBoundaryOnly={() => { toast.success('Boundary saved'); setSheetMode('none'); resetParcelState(); }}
          onClose={() => { setSheetMode('none'); resetParcelState(); }}
          onUseAsSubject={() => {
            // Pre-seed the CMA build with these parcels as a locked subject.
            const primary = allParcels[0];
            setSheetMode('none');
            setCmaMode(true);
            setCmaEditingId(null);
            setCmaSubjectParcels([...allParcels]);
            setCmaSubjectMeta({
              name: primary?.owner_name || `${primary?.county || 'TX'} subject`,
              county: primary?.county || '',
              state: primary?.state || 'TX',
            });
            setCmaCompIds([]);
            setCmaPhase('comps');
            // Keep the merged-boundary source as-is (already populated from the
            // Combine action) — that's the visual subject.
            try {
              const sel = map.current?.getSource('selected-parcels') as mapboxgl.GeoJSONSource | undefined;
              if (sel) sel.setData({ type: 'FeatureCollection', features: [] });
            } catch {}
            // Don't call resetParcelState() — that wipes the merged-boundary too.
            setSelectedParcels([]);
            setTappedParcel(null);
            setMapMode('view');
            toast.success(
              `Subject: ${allParcels.length} parcel${allParcels.length === 1 ? '' : 's'}, ${mergedAcres.toFixed(1)} ac. Tap comp pins.`,
              { duration: 4000 }
            );
          }}
        />
      )}

      {showAddModal && (
        <CompModal
          comp={prefilledComp}
          onClose={() => { setShowAddModal(false); setPrefilledComp(null); }}
          onSave={() => { setShowAddModal(false); setPrefilledComp(null); fetchComps(); toast.success('Comp added from parcel!'); }}
        />
      )}

      {editingComp && (
        <CompModal
          comp={editingComp}
          onClose={() => setEditingComp(null)}
          onSave={() => { setEditingComp(null); setSelectedComp(null); fetchComps(); toast.success('Updated!'); }}
        />
      )}
    </div>
  );
}

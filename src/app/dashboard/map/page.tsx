'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Comp } from '@/types';
import { formatPPA, formatAcres, formatCurrency } from '@/lib/utils';
import { X, Edit, MousePointer } from 'lucide-react';
import mapboxgl from 'mapbox-gl';
import CompModal from '@/components/comp/CompModal';
import {
  ParcelBottomSheet,
  BoundaryCreatedSheet,
  ParcelFeature,
} from '@/components/map/ParcelMerge';
import toast from 'react-hot-toast';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

const STATUS_COLORS: Record<string, string> = {
  Sold: '#34d399',
  Active: '#3b82f6',
  Pending: '#f59e0b',
  Withdrawn: '#6b7280',
};

type MapMode = 'view' | 'parcel_select';
type SheetMode = 'none' | 'parcel' | 'selecting' | 'boundary_created';

export default function MapPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);

  const [comps, setComps] = useState<Comp[]>([]);
  const [selectedComp, setSelectedComp] = useState<Comp | null>(null);
  const [editingComp, setEditingComp] = useState<Comp | null>(null);
  const [mapStyle, setMapStyle] = useState<'satellite' | 'streets' | 'terrain'>('satellite');
  const [mapLoaded, setMapLoaded] = useState(false);

  const [mapMode, setMapMode] = useState<MapMode>('view');
  const [sheetMode, setSheetMode] = useState<SheetMode>('none');
  const [tappedParcel, setTappedParcel] = useState<ParcelFeature | null>(null);
  const [selectedParcels, setSelectedParcels] = useState<ParcelFeature[]>([]);
  const [mergedAcres, setMergedAcres] = useState(0);

  const [showAddModal, setShowAddModal] = useState(false);
  const [prefilledComp, setPrefilledComp] = useState<any>(null);

  const supabase = createClient();

  const STYLE_URLS = {
    satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
    streets: 'mapbox://styles/mapbox/dark-v11',
    terrain: 'mapbox://styles/mapbox/outdoors-v12',
  };

  const resetParcelState = useCallback(() => {
    setSelectedParcels([]);
    setTappedParcel(null);
    setMergedAcres(0);
    setMapMode('view');
    if (map.current && mapLoaded) {
      try {
        const src1 = map.current.getSource('selected-parcels') as mapboxgl.GeoJSONSource;
        const src2 = map.current.getSource('merged-boundary') as mapboxgl.GeoJSONSource;
        if (src1) src1.setData({ type: 'FeatureCollection', features: [] });
        if (src2) src2.setData({ type: 'FeatureCollection', features: [] });
      } catch (e) {}
    }
  }, [mapLoaded]);

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

    map.current.on('load', () => {
      // Selected parcels layer
      map.current!.addSource('selected-parcels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.current!.addLayer({
        id: 'selected-parcel-fill',
        type: 'fill',
        source: 'selected-parcels',
        paint: { 'fill-color': '#34d399', 'fill-opacity': 0.12 },
      });
      map.current!.addLayer({
        id: 'selected-parcel-outline',
        type: 'line',
        source: 'selected-parcels',
        paint: { 'line-color': '#34d399', 'line-width': 2 },
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
        paint: { 'fill-color': '#34d399', 'fill-opacity': 0.2 },
      });
      map.current!.addLayer({
        id: 'merged-outline',
        type: 'line',
        source: 'merged-boundary',
        paint: { 'line-color': '#34d399', 'line-width': 3 },
      });

      setMapLoaded(true);
    });

    // Map click — fetch parcel info
    map.current.on('click', async (e) => {
      const { lng, lat } = e.lngLat;
      try {
        const res = await fetch(`/api/parcel?lat=${lat}&lng=${lng}`);
        const parcel: ParcelFeature = await res.json();
        parcel.latitude = lat;
        parcel.longitude = lng;

        if (mapMode === 'parcel_select') {
          handleAddParcelToSelection(parcel);
        } else {
          setTappedParcel(parcel);
          setSheetMode('parcel');
          setSelectedComp(null);
        }
      } catch {}
    });

    return () => {
      if (map.current) { map.current.remove(); map.current = null; }
    };
  }, []);

  // Update map mode ref for click handler
  const mapModeRef = useRef(mapMode);
  useEffect(() => { mapModeRef.current = mapMode; }, [mapMode]);

  const handleAddParcelToSelection = useCallback((parcel: ParcelFeature) => {
    setSelectedParcels(prev => {
      if (prev.some(p => p.parcel_id === parcel.parcel_id)) {
        toast('Already selected', { duration: 1000 });
        return prev;
      }
      const next = [...prev, parcel];

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
      toast.success(`Added: ${parcel.owner_name || 'Parcel'}`, { duration: 1200 });
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

  // Comp markers
  useEffect(() => {
    if (!map.current || !mapLoaded) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    comps.forEach(comp => {
      if (!comp.latitude || !comp.longitude) return;
      const ppa = comp.ppa_land_only || comp.price_per_acre || 0;
      const color = STATUS_COLORS[comp.status] || '#94a3b8';

      const el = document.createElement('div');
      el.style.cssText = `
        background:#0b0f14;border:2px solid ${color};border-radius:20px;
        padding:4px 9px;font-family:'DM Mono',monospace;font-size:11px;
        font-weight:700;color:${color};cursor:pointer;white-space:nowrap;
        box-shadow:0 2px 8px rgba(0,0,0,.5);transition:transform .15s;
      `;
      el.textContent = `$${Math.round(ppa / 1000)}k`;
      el.addEventListener('mouseenter', () => { el.style.transform = 'scale(1.2)'; });
      el.addEventListener('mouseleave', () => { el.style.transform = 'scale(1)'; });
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        setSelectedComp(comp);
        setSheetMode('none');
        setTappedParcel(null);
        map.current?.flyTo({ center: [comp.longitude!, comp.latitude!], zoom: 12, duration: 800 });
      });

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([comp.longitude!, comp.latitude!])
        .addTo(map.current!);
      markersRef.current.push(marker);
    });
  }, [comps, mapLoaded]);

  const handleCreateBoundary = useCallback((parcels: ParcelFeature[]) => {
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
  }, [mapLoaded]);

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

  const changeStyle = (style: 'satellite' | 'streets' | 'terrain') => {
    if (!map.current) return;
    setMapStyle(style);
    setMapLoaded(false);
    map.current.setStyle(STYLE_URLS[style]);
    map.current.once('style.load', () => setMapLoaded(true));
  };

  const allParcels = selectedParcels.length > 0 ? selectedParcels : tappedParcel ? [tappedParcel] : [];

  return (
    <div className="flex h-full bg-night">
      <div className="flex-1 relative">
        <div
          ref={mapContainer}
          className="w-full h-full"
          style={{ cursor: mapMode === 'parcel_select' ? 'crosshair' : 'default' }}
        />

        {/* Map controls */}
        <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
          {/* Style switcher */}
          <div className="bg-panel/90 backdrop-blur-sm border border-border rounded-xl overflow-hidden flex">
            {(['satellite', 'streets', 'terrain'] as const).map(s => (
              <button key={s} onClick={() => changeStyle(s)}
                className={`px-3 py-2 text-xs font-bold capitalize transition-colors ${
                  mapStyle === s ? 'bg-sage/20 text-sage' : 'text-slate-400 hover:text-white'
                }`}
              >{s === 'streets' ? 'Dark' : s}</button>
            ))}
          </div>

          {/* Parcel mode button */}
          {mapMode === 'view' && (
            <button
              onClick={() => {
                setMapMode('parcel_select');
                setSheetMode('selecting');
                setSelectedComp(null);
                setTappedParcel(null);
                toast('Tap parcels on the map to select them', { icon: '🗺️', duration: 2500 });
              }}
              className="bg-panel/90 backdrop-blur-sm border border-border hover:border-sage rounded-xl px-3 py-2 text-xs font-bold text-slate-300 hover:text-sage transition-colors flex items-center gap-1.5"
            >
              <MousePointer size={12} />
              Select Parcels
            </button>
          )}

          {mapMode === 'parcel_select' && (
            <div className="bg-sage/10 border border-sage/30 rounded-xl px-3 py-2 text-xs font-bold text-sage flex items-center gap-1.5">
              <MousePointer size={12} />
              Tap to select parcels
            </div>
          )}
        </div>

        {/* Stats bar */}
        <div className="absolute bottom-8 left-3 z-10">
          <div className="bg-panel/90 backdrop-blur-sm border border-border rounded-xl px-3 py-2 flex gap-4">
            <div>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">On Map</p>
              <p className="text-sm font-bold text-sage font-mono">
                {comps.filter(c => c.latitude && c.longitude).length}
              </p>
            </div>
            <div>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Total Comps</p>
              <p className="text-sm font-bold text-white font-mono">{comps.length}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Comp detail panel */}
      {selectedComp && (
        <div className="hidden md:flex w-80 bg-panel border-l border-border flex-col overflow-y-auto">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <span className="font-bold text-sm">Comp Detail</span>
            <button onClick={() => setSelectedComp(null)} className="text-slate-500 hover:text-white">
              <X size={16} />
            </button>
          </div>
          <div className="p-4 space-y-4">
            <div>
              <h2 className="text-lg font-bold">{selectedComp.property_name || `${selectedComp.county} County`}</h2>
              <p className="text-sm text-slate-400">{selectedComp.county}, {selectedComp.state} · {formatAcres(selectedComp.acres)}</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-3">
              <p className="text-2xl font-bold text-emerald-400 font-mono">
                {formatPPA(selectedComp.ppa_land_only || selectedComp.price_per_acre || 0)}
              </p>
              <p className="text-sm text-slate-500 font-mono">{formatCurrency(selectedComp.sale_price)}</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'Water', value: selectedComp.water },
                { label: 'Road', value: selectedComp.road_frontage },
                { label: 'Dev', value: selectedComp.dev_potential },
                { label: 'Minerals', value: selectedComp.minerals_sold || 'N/A' },
              ].map(({ label, value }) => (
                <div key={label} className="bg-card border border-border rounded-lg p-2">
                  <p className="text-[9px] font-bold text-slate-500 uppercase">{label}</p>
                  <p className="text-xs font-bold text-white mt-0.5">{value}</p>
                </div>
              ))}
            </div>
            {selectedComp.description && (
              <p className="text-xs text-slate-400 leading-relaxed line-clamp-4">{selectedComp.description}</p>
            )}
            <button onClick={() => setEditingComp(selectedComp)}
              className="w-full py-2.5 bg-card border border-border hover:border-sage text-sm font-bold text-slate-300 hover:text-white rounded-xl transition-colors flex items-center justify-center gap-2">
              <Edit size={14} /> Edit Comp
            </button>
          </div>
        </div>
      )}

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

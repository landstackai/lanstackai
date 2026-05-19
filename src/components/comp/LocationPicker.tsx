'use client';

import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { X, MapPin } from 'lucide-react';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

interface LocationPickerProps {
  /** Initial map center (optional — falls back to Texas-wide). */
  initialLat?: number | null;
  initialLng?: number | null;
  /** County name to center on when no explicit lat/lng — uses Mapbox geocoding. */
  county?: string | null;
  state?: string | null;
  /** Comp ID — if provided, we'll fetch the AI location hint to auto-fly. */
  compId?: string | null;
  /** Description text shown alongside the map for visual matching. */
  description?: string | null;
  /** Address narrative shown alongside the map. */
  address?: string | null;
  /** Property name for the title bar. */
  propertyName?: string | null;
  onPick: (lat: number, lng: number) => void;
  onClose: () => void;
}

/**
 * Satellite-map picker for setting a comp's location by click. Used as a
 * fallback when an appraiser's rural address can't be geocoded automatically.
 * Click anywhere on the map → pin drops → confirm to save.
 */
export default function LocationPicker({
  initialLat,
  initialLng,
  county,
  state,
  compId,
  description,
  address,
  propertyName,
  onPick,
  onClose,
}: LocationPickerProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const [pickedLat, setPickedLat] = useState<number | null>(initialLat ?? null);
  const [pickedLng, setPickedLng] = useState<number | null>(initialLng ?? null);
  const [searchQuery, setSearchQuery] = useState('');

  // Initialize the map once on mount. Center logic:
  //   1. initialLat/Lng if provided (editing a comp that already has coords)
  //   2. Geocoded county centroid if we have county + state
  //   3. Texas-wide fallback
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const fallbackCenter: [number, number] = [-99.5, 31.0]; // central TX
    const initialCenter: [number, number] =
      initialLng != null && initialLat != null
        ? [initialLng, initialLat]
        : fallbackCenter;
    const initialZoom = initialLat != null && initialLng != null ? 14 : 6;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: initialCenter,
      zoom: initialZoom,
    });
    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

    // Place initial marker if we have coords.
    if (initialLat != null && initialLng != null) {
      const el = document.createElement('div');
      el.style.cssText = `
        background:#34d399;border:3px solid #0b0f14;border-radius:50%;
        width:22px;height:22px;
        box-shadow:0 0 0 4px rgba(52,211,153,.4), 0 4px 14px rgba(0,0,0,.6);
      `;
      markerRef.current = new mapboxgl.Marker({ element: el })
        .setLngLat([initialLng, initialLat])
        .addTo(map.current);
    }

    // Click anywhere to drop / move the marker.
    map.current.on('click', (e) => {
      const { lng, lat } = e.lngLat;
      setPickedLat(lat);
      setPickedLng(lng);
      if (markerRef.current) {
        markerRef.current.setLngLat([lng, lat]);
      } else {
        const el = document.createElement('div');
        el.style.cssText = `
          background:#34d399;border:3px solid #0b0f14;border-radius:50%;
          width:22px;height:22px;
          box-shadow:0 0 0 4px rgba(52,211,153,.4), 0 4px 14px rgba(0,0,0,.6);
        `;
        markerRef.current = new mapboxgl.Marker({ element: el })
          .setLngLat([lng, lat])
          .addTo(map.current!);
      }
    });

    // Fly to county centroid as the starting point. Broker uses the search
    // bar or the description panel on the left to find the actual property,
    // then clicks on the satellite to drop the pin.
    if (initialLat == null && county && state) {
      const q = `${county} County, ${state}`;
      fetch(
        `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}` +
          `&access_token=${mapboxgl.accessToken}&country=us&limit=1`
      )
        .then((r) => r.json())
        .then((data) => {
          const coords = data?.features?.[0]?.geometry?.coordinates;
          if (Array.isArray(coords) && coords.length >= 2 && map.current) {
            map.current.flyTo({ center: coords as [number, number], zoom: 10, duration: 800 });
          }
        })
        .catch(() => {});
    }

    return () => {
      markerRef.current?.remove();
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Address search to quickly fly to a starting point.
  const searchAddress = async () => {
    if (!searchQuery.trim() || !map.current) return;
    try {
      const res = await fetch(
        `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(searchQuery)}` +
          `&access_token=${mapboxgl.accessToken}&country=us&limit=1`
      );
      const data = await res.json();
      const coords = data?.features?.[0]?.geometry?.coordinates;
      if (Array.isArray(coords) && coords.length >= 2) {
        map.current.flyTo({ center: coords as [number, number], zoom: 13, duration: 800 });
      }
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex flex-col">
      {/* Top bar */}
      <div className="bg-white border-b border-beige px-5 py-3 flex items-center justify-between gap-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <MapPin size={16} className="text-olive-2" />
          <p className="font-bold text-ink text-sm">Set Property Location</p>
          <p className="text-[11px] text-ink-3 hidden md:inline">Click on the map where the property is.</p>
        </div>
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                searchAddress();
              }
            }}
            placeholder="Search address or place to fly to…"
            className="flex-1 bg-cream border border-beige rounded-lg px-3 py-1.5 text-xs text-ink outline-none focus:border-olive"
          />
          <button
            onClick={searchAddress}
            className="px-3 py-1.5 bg-cream border border-beige rounded-lg text-xs font-bold text-ink-2 hover:text-ink hover:border-olive transition-colors"
          >
            Go
          </button>
        </div>
        <button onClick={onClose} className="text-ink-3 hover:text-ink">
          <X size={18} />
        </button>
      </div>

      {/* Main work area: side-by-side description panel + satellite map */}
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT: appraiser context panel — description / address / AI hint */}
        {(description || address || propertyName) && (
          <div className="hidden lg:block w-80 flex-shrink-0 bg-white border-r border-beige overflow-y-auto">
            <div className="px-4 py-4 space-y-3">
              {propertyName && (
                <div>
                  <p className="text-[10px] font-bold text-ink-3 uppercase tracking-wider mb-1">Property</p>
                  <p className="text-sm font-bold text-ink">{propertyName}</p>
                </div>
              )}
              {address && (
                <div>
                  <p className="text-[10px] font-bold text-ink-3 uppercase tracking-wider mb-1">Address</p>
                  <p className="text-xs text-ink leading-relaxed">{address}</p>
                </div>
              )}
              {description && (
                <div>
                  <p className="text-[10px] font-bold text-ink-3 uppercase tracking-wider mb-1">Description from appraiser</p>
                  <p className="text-xs text-ink-2 leading-relaxed whitespace-pre-wrap">{description}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* RIGHT: the satellite map */}
        <div className="flex-1 relative">
          <div ref={mapContainer} className="absolute inset-0" />

          {/* Picked-coordinates badge */}
          {pickedLat != null && pickedLng != null && (
            <div className="absolute top-4 left-4 bg-white/95 backdrop-blur-sm border border-olive-border rounded-xl px-4 py-3 shadow-2xl">
              <p className="text-[10px] font-bold text-olive-2 uppercase tracking-wider mb-1">Picked location</p>
              <p className="text-sm font-mono text-ink">
                {pickedLat.toFixed(6)}, {pickedLng.toFixed(6)}
              </p>
            </div>
          )}

          {/* Initial helper */}
          {pickedLat == null && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-white/95 backdrop-blur-sm border border-beige rounded-xl px-4 py-2 shadow-2xl">
              <p className="text-xs text-ink-2">
                Compare to the description on the left, then click the property on this map.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom action bar */}
      <div className="bg-white border-t border-beige px-5 py-3 flex items-center justify-end gap-2 flex-shrink-0">
        <button
          onClick={onClose}
          className="px-4 py-2 text-xs font-bold text-ink-2 hover:text-ink transition-colors"
        >
          Cancel
        </button>
        <button
          disabled={pickedLat == null || pickedLng == null}
          onClick={() => {
            if (pickedLat != null && pickedLng != null) onPick(pickedLat, pickedLng);
          }}
          className="px-4 py-2 bg-olive hover:bg-olive-2 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold transition-colors"
        >
          Save Location
        </button>
      </div>
    </div>
  );
}

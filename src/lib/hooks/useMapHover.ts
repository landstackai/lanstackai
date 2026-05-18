'use client';

// ─────────────────────────────────────────────────────────────────────────
// useMapHover — shared parcel-style hover tooltip for any Mapbox layer.
//
// The id.land-style pattern: cursor over a polygon → small dark tooltip
// follows with whatever the caller wants to surface (owner name, acreage,
// status tag). Centralized here so:
//   - One popup ref per map → no chance of stacked tooltips during fast
//     layer/mode transitions.
//   - Consistent visual style (the .parcel-hover-popup class in
//     globals.css carries the dark background, no tip, 11px text).
//   - Adding hover to a new surface is a one-liner — call attach with the
//     layer id and an HTML-string builder, capture the returned cleanup
//     and run it from your effect teardown.
//
// First consumer: the per-comp review page (/dashboard/review/[compId]).
// Second consumer: the main /dashboard/map page across its vector parcel
// + boundary + selection + owner-search layers.
// ─────────────────────────────────────────────────────────────────────────

import { useCallback, useRef } from 'react';
import mapboxgl from 'mapbox-gl';

/**
 * Lightweight HTML-escape for values pulled out of GeoJSON feature
 * properties before injection via Popup.setHTML. Parcel owner_name comes
 * from third-party datasets (TxGIO / CAD imports) — we don't fully
 * control what's in those strings, so a malicious record could otherwise
 * smuggle a <script> tag through the popup.
 */
export function escHtml(s: any): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Hook returning an `attach(map, layerId, getContent)` function. Call
 * once per component, then call `attach` from each effect that adds a
 * hoverable layer; store the returned function and call it in the
 * effect's cleanup so the listeners detach when the layer goes away.
 *
 * `getContent(feature)` returns an HTML string. The caller is
 * responsible for HTML-escaping any feature-derived text via `escHtml`.
 *
 * The popup ref is shared across all attached layers, so cursor moves
 * between layers smoothly swap content rather than stacking two
 * tooltips. `removePopup` is exposed for unmount paths that want to
 * force-clear the tooltip (e.g. mode changes mid-hover).
 */
export function useMapHover() {
  const popupRef = useRef<mapboxgl.Popup | null>(null);

  const attach = useCallback(
    (
      m: mapboxgl.Map,
      layerId: string,
      getContent: (feature: any) => string
    ) => {
      const onMove = (e: any) => {
        const feature = e.features?.[0];
        if (!feature) return;
        try {
          if (m.getCanvas()) m.getCanvas().style.cursor = 'pointer';
        } catch { /* destroyed map; fall through to setHTML/no-op */ }

        const html = getContent(feature);
        if (!popupRef.current) {
          popupRef.current = new mapboxgl.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: 12,
            className: 'parcel-hover-popup',
            // Default 240px squashes our two-line owner+acres layout when
            // owner_name is long ("CHARLES & MARGARET HARRINGTON TRUST").
            // Let the inner content size itself.
            maxWidth: '300px',
          });
        }
        try {
          popupRef.current.setLngLat(e.lngLat).setHTML(html).addTo(m);
        } catch {
          // Popup couldn't attach (map destroyed mid-render). Drop the
          // ref so the next mousemove builds a fresh popup.
          popupRef.current = null;
        }
      };
      const onLeave = () => {
        try {
          if (m.getCanvas()) m.getCanvas().style.cursor = '';
        } catch {}
        try { popupRef.current?.remove(); } catch {}
      };

      m.on('mousemove', layerId, onMove);
      m.on('mouseleave', layerId, onLeave);

      return () => {
        try { m.off('mousemove', layerId, onMove); } catch {}
        try { m.off('mouseleave', layerId, onLeave); } catch {}
      };
    },
    []
  );

  const removePopup = useCallback(() => {
    try { popupRef.current?.remove(); } catch {}
  }, []);

  return { attach, removePopup };
}

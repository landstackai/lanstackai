'use client';

import { useState, useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { CMA, Comp } from '@/types';
import { formatPPA, formatAcres, formatCurrency } from '@/lib/utils';
import { MapPin, Download, Phone, ThumbsUp, ThumbsDown, HelpCircle, Layers } from 'lucide-react';
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
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
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

  useEffect(() => {
    if (!mapContainer.current || map.current || !cma) return;

    const texasCenter: [number, number] = [-99.5, 30.2];
    const hasLocations = comps.some(c => c.latitude && c.longitude);

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: hasLocations
        ? [comps.find(c => c.longitude)?.longitude || texasCenter[0], comps.find(c => c.latitude)?.latitude || texasCenter[1]]
        : texasCenter,
      zoom: hasLocations ? 9 : 6,
    });

    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.current.on('load', () => {
      comps.forEach((comp, i) => {
        if (!comp.latitude || !comp.longitude) return;

        const el = document.createElement('div');
        el.style.cssText = `
          background: #0b0f14;
          border: 2px solid #34d399;
          border-radius: 20px;
          padding: 4px 8px;
          font-family: 'DM Mono', monospace;
          font-size: 11px;
          font-weight: 700;
          color: #34d399;
          cursor: pointer;
          white-space: nowrap;
          box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        `;
        el.textContent = `$${Math.round((comp.ppa_land_only || comp.price_per_acre || 0) / 1000)}k`;

        el.addEventListener('click', () => setSelectedComp(comp));

        new mapboxgl.Marker({ element: el })
          .setLngLat([comp.longitude, comp.latitude])
          .addTo(map.current!);
      });
    });
  }, [cma, comps]);

  const handleReaction = (compId: string, reaction: 'relevant' | 'question' | 'not_comparable') => {
    setReactions(prev => ({ ...prev, [compId]: reaction }));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-night flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-sage border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!cma) {
    return (
      <div className="min-h-screen bg-night flex items-center justify-center text-center p-4">
        <div>
          <div className="text-4xl mb-4">🔒</div>
          <h1 className="text-xl font-bold mb-2">Report Not Found</h1>
          <p className="text-slate-400 text-sm">This link may have expired or been revoked.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-night flex flex-col">
      {/* Header */}
      <div className="bg-panel border-b border-border px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-sage to-sage2 flex items-center justify-center">
            <Layers size={12} className="text-black" />
          </div>
          <span className="font-bold text-sm">landstack<span className="text-sage">.ai</span></span>
        </div>
        <div className="text-xs text-slate-500">
          {cma.client_name ? `For ${cma.client_name}` : 'Property Valuation Report'}
        </div>
      </div>

      {/* Split layout */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        {/* Map - left on desktop, top on mobile */}
        <div className="h-64 md:h-auto md:flex-1 relative">
          <div ref={mapContainer} className="w-full h-full" />
        </div>

        {/* Report - right on desktop, bottom on mobile */}
        <div className="w-full md:w-96 bg-panel border-l border-border flex flex-col overflow-y-auto">
          {/* Subject */}
          <div className="p-5 border-b border-border">
            <h1 className="text-xl font-bold text-white mb-1">{cma.subject_name}</h1>
            <div className="flex items-center gap-1.5 text-sm text-slate-400">
              <MapPin size={12} />
              <span>{cma.subject_county}, {cma.subject_state}</span>
              <span className="mx-1">·</span>
              <span className="font-mono">{formatAcres(cma.subject_acres)}</span>
            </div>
          </div>

          {/* Value range */}
          {cma.value_mid && (
            <div className="p-5 border-b border-border bg-sage/5">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                Estimated Value Range
              </p>
              <div className="flex items-center justify-between mb-2">
                <div className="text-center">
                  <p className="text-[10px] text-slate-500">Low</p>
                  <p className="text-sm font-bold text-white font-mono">{formatCurrency(cma.value_low || 0)}</p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-slate-500">Mid Estimate</p>
                  <p className="text-2xl font-bold text-sage font-mono">{formatCurrency(cma.value_mid)}</p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-slate-500">High</p>
                  <p className="text-sm font-bold text-white font-mono">{formatCurrency(cma.value_high || 0)}</p>
                </div>
              </div>
              <p className="text-xs text-center text-slate-500">
                Based on {comps.length} comparable sales
              </p>
            </div>
          )}

          {/* Comps */}
          <div className="flex-1 p-4 space-y-3">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              Comparable Sales
            </p>

            {comps.map((comp, i) => (
              <div
                key={comp.id}
                onClick={() => {
                  setSelectedComp(comp);
                  if (comp.latitude && comp.longitude && map.current) {
                    map.current.flyTo({ center: [comp.longitude, comp.latitude], zoom: 12 });
                  }
                }}
                className={`bg-card border rounded-xl p-3 cursor-pointer transition-all ${
                  selectedComp?.id === comp.id ? 'border-sage' : 'border-border hover:border-sage/40'
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <p className="text-sm font-bold text-white">
                      {comp.property_name || `${comp.county} County`}
                    </p>
                    <p className="text-xs text-slate-400">
                      {formatAcres(comp.acres)} · {comp.county}, {comp.state}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-emerald-400 font-mono">
                      {formatPPA(comp.ppa_land_only || comp.price_per_acre || 0)}
                    </p>
                    <p className="text-xs text-slate-500 font-mono">
                      {formatCurrency(comp.sale_price)}
                    </p>
                  </div>
                </div>

                {/* Reaction buttons */}
                <div className="flex gap-1.5 pt-2 border-t border-border">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleReaction(comp.id, 'relevant'); }}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold transition-colors ${
                      reactions[comp.id] === 'relevant'
                        ? 'bg-emerald-400/20 text-emerald-400'
                        : 'bg-card text-slate-500 hover:text-emerald-400'
                    }`}
                  >
                    <ThumbsUp size={9} /> Relevant
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleReaction(comp.id, 'question'); }}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold transition-colors ${
                      reactions[comp.id] === 'question'
                        ? 'bg-amber-400/20 text-amber-400'
                        : 'bg-card text-slate-500 hover:text-amber-400'
                    }`}
                  >
                    <HelpCircle size={9} /> Question
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleReaction(comp.id, 'not_comparable'); }}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold transition-colors ${
                      reactions[comp.id] === 'not_comparable'
                        ? 'bg-red-400/20 text-red-400'
                        : 'bg-card text-slate-500 hover:text-red-400'
                    }`}
                  >
                    <ThumbsDown size={9} /> Not Comparable
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Broker notes */}
          {cma.broker_notes && (
            <div className="p-4 border-t border-border">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Broker Analysis</p>
              <p className="text-xs text-slate-300 leading-relaxed">{cma.broker_notes}</p>
            </div>
          )}

          {/* Footer */}
          <div className="p-4 border-t border-border">
            <p className="text-[10px] text-center text-slate-600">
              Powered by <span className="text-sage font-bold">landstack.ai</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

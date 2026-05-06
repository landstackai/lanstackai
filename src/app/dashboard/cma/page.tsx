'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Comp, CMA } from '@/types';
import { formatPPA, formatAcres, formatCurrency } from '@/lib/utils';
import { FileText, Share2, Download, Plus, Check, ChevronRight, ChevronLeft } from 'lucide-react';
import CompCard from '@/components/comp/CompCard';
import toast from 'react-hot-toast';

export default function CMAPage() {
  const [step, setStep] = useState(1);
  const [comps, setComps] = useState<Comp[]>([]);
  const [selectedCompIds, setSelectedCompIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [savedCMA, setSavedCMA] = useState<CMA | null>(null);
  const supabase = createClient();

  const [subject, setSubject] = useState({
    name: '',
    address: '',
    county: '',
    state: 'TX',
    acres: '',
    description: '',
    client_name: '',
    broker_notes: '',
    cma_mode: 'land_only' as 'land_only' | 'improved' | 'both',
  });

  useEffect(() => {
    const fetchComps = async () => {
      const { data } = await supabase
        .from('comps')
        .select('*')
        .eq('status', 'Sold')
        .order('sale_date', { ascending: false });
      if (data) setComps(data as Comp[]);
    };
    fetchComps();
  }, [supabase]);

  const selectedComps = comps.filter(c => selectedCompIds.includes(c.id));

  // Calculate value range
  const ppas = selectedComps.map(c =>
    subject.cma_mode === 'land_only' && c.ppa_land_only ? c.ppa_land_only : (c.price_per_acre || 0)
  ).filter(p => p > 0);

  const acres = parseFloat(subject.acres) || 0;
  const ppaLow = ppas.length > 0 ? Math.min(...ppas) : 0;
  const ppaMid = ppas.length > 0 ? ppas.reduce((a, b) => a + b, 0) / ppas.length : 0;
  const ppaHigh = ppas.length > 0 ? Math.max(...ppas) : 0;
  const valueLow = ppaLow * acres;
  const valueMid = ppaMid * acres;
  const valueHigh = ppaHigh * acres;

  const toggleComp = (id: string) => {
    setSelectedCompIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const saveCMA = async () => {
    if (!subject.name || !subject.county || !subject.acres) {
      toast.error('Subject property name, county, and acres are required');
      return;
    }
    setLoading(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data, error } = await supabase
      .from('cmas')
      .insert({
        created_by: user.id,
        subject_name: subject.name,
        subject_address: subject.address || null,
        subject_county: subject.county,
        subject_state: subject.state,
        subject_acres: acres,
        subject_description: subject.description || null,
        client_name: subject.client_name || null,
        cma_mode: subject.cma_mode,
        broker_notes: subject.broker_notes || null,
        value_low: valueLow || null,
        value_mid: valueMid || null,
        value_high: valueHigh || null,
        ppa_low: ppaLow || null,
        ppa_mid: ppaMid || null,
        ppa_high: ppaHigh || null,
        selected_comp_ids: selectedCompIds,
      })
      .select()
      .single();

    if (error) {
      toast.error('Failed to save CMA');
      setLoading(false);
    } else {
      setSavedCMA(data as CMA);
      setStep(4);
      toast.success('CMA saved!');
      setLoading(false);
    }
  };

  const copyShareLink = () => {
    if (!savedCMA?.share_token) return;
    const url = `${window.location.origin}/report/${savedCMA.share_token}`;
    navigator.clipboard.writeText(url);
    toast.success('Share link copied!');
  };

  const inputClass = "w-full bg-card border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-sage transition-colors";
  const labelClass = "block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5";

  return (
    <div className="flex flex-col h-full bg-night">
      {/* Header */}
      <div className="flex-shrink-0 bg-panel border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <FileText size={18} className="text-sage" />
          <h1 className="font-bold text-base">CMA Builder</h1>
          <div className="flex items-center gap-1 ml-auto">
            {[1, 2, 3].map(s => (
              <div key={s} className={`h-1.5 w-12 rounded-full transition-colors ${s <= step ? 'bg-sage' : 'bg-border'}`} />
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* STEP 1: Subject Property */}
        {step === 1 && (
          <div className="max-w-2xl mx-auto space-y-4">
            <div>
              <h2 className="text-lg font-bold mb-1">Subject Property</h2>
              <p className="text-sm text-slate-400">Enter the property you're valuing</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className={labelClass}>Property Name *</label>
                <input value={subject.name} onChange={e => setSubject({...subject, name: e.target.value})}
                  placeholder="Elk Ridge Ranch" className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>County *</label>
                <input value={subject.county} onChange={e => setSubject({...subject, county: e.target.value})}
                  placeholder="Real" className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Acres *</label>
                <input type="number" value={subject.acres}
                  onChange={e => setSubject({...subject, acres: e.target.value})}
                  placeholder="455" className={`${inputClass} font-mono`} />
              </div>
              <div className="col-span-2">
                <label className={labelClass}>Client Name</label>
                <input value={subject.client_name} onChange={e => setSubject({...subject, client_name: e.target.value})}
                  placeholder="Robert Harrington" className={inputClass} />
              </div>
              <div className="col-span-2">
                <label className={labelClass}>Property Description</label>
                <textarea value={subject.description}
                  onChange={e => setSubject({...subject, description: e.target.value})}
                  placeholder="Describe the subject property..."
                  rows={3}
                  className={`${inputClass} resize-none`}
                />
              </div>
            </div>

            {/* CMA mode */}
            <div>
              <label className={labelClass}>Valuation Mode</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { value: 'land_only', label: 'Land Only', desc: 'Strips improvements' },
                  { value: 'improved', label: 'Improved', desc: 'Total property value' },
                  { value: 'both', label: 'Both', desc: 'Full advisory view' },
                ].map(m => (
                  <button key={m.value} onClick={() => setSubject({...subject, cma_mode: m.value as any})}
                    className={`p-3 rounded-xl border text-left transition-colors ${
                      subject.cma_mode === m.value
                        ? 'border-sage bg-sage/10'
                        : 'border-border hover:border-slate-500'
                    }`}
                  >
                    <p className={`text-xs font-bold ${subject.cma_mode === m.value ? 'text-sage' : 'text-white'}`}>
                      {m.label}
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">{m.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => setStep(2)}
              disabled={!subject.name || !subject.county || !subject.acres}
              className="w-full py-3 bg-sage hover:bg-sage2 text-black font-bold rounded-xl transition-colors disabled:opacity-50"
            >
              Select Comps →
            </button>
          </div>
        )}

        {/* STEP 2: Select Comps */}
        {step === 2 && (
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold">Select Comparables</h2>
                <p className="text-sm text-slate-400">Choose comps to include in this CMA</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-500">{selectedCompIds.length} selected</p>
                {ppaMid > 0 && (
                  <p className="text-sm font-bold text-sage font-mono">{formatPPA(ppaMid)}</p>
                )}
              </div>
            </div>

            {/* Live value bar */}
            {selectedCompIds.length > 0 && acres > 0 && (
              <div className="bg-card border border-sage/20 rounded-xl p-4">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                  Live Value Range ({selectedCompIds.length} comps)
                </p>
                <div className="flex items-center gap-3">
                  <div className="text-center">
                    <p className="text-[10px] text-slate-500">Low</p>
                    <p className="text-sm font-bold text-white font-mono">{formatCurrency(valueLow)}</p>
                  </div>
                  <div className="flex-1 h-1.5 bg-border rounded-full relative">
                    <div className="absolute inset-0 bg-gradient-to-r from-amber-400 via-sage to-emerald-400 rounded-full" />
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-slate-500">High</p>
                    <p className="text-sm font-bold text-white font-mono">{formatCurrency(valueHigh)}</p>
                  </div>
                </div>
                <div className="text-center mt-2">
                  <p className="text-lg font-bold text-sage font-mono">{formatCurrency(valueMid)}</p>
                  <p className="text-xs text-slate-500">Mid estimate · {formatPPA(ppaMid)}</p>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {comps.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <p className="text-sm">No sold comps in your vault yet.</p>
                  <p className="text-xs mt-1">Add comps or import from a PDF first.</p>
                </div>
              ) : (
                comps.map(comp => (
                  <div key={comp.id} className="relative">
                    {selectedCompIds.includes(comp.id) && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 z-10">
                        <div className="w-5 h-5 rounded-full bg-sage flex items-center justify-center">
                          <Check size={11} className="text-black" />
                        </div>
                      </div>
                    )}
                    <CompCard
                      comp={comp}
                      onEdit={() => {}}
                      onDelete={() => {}}
                      viewMode="list"
                      isSelected={selectedCompIds.includes(comp.id)}
                      onSelect={() => toggleComp(comp.id)}
                    />
                  </div>
                ))
              )}
            </div>

            <div className="flex gap-2 pt-2">
              <button onClick={() => setStep(1)}
                className="flex items-center gap-1.5 px-4 py-2.5 border border-border rounded-xl text-sm font-bold text-slate-400 hover:text-white transition-colors">
                <ChevronLeft size={14} /> Back
              </button>
              <button
                onClick={() => setStep(3)}
                disabled={selectedCompIds.length === 0}
                className="flex-1 py-2.5 bg-sage hover:bg-sage2 text-black font-bold rounded-xl transition-colors disabled:opacity-50"
              >
                Review CMA →
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: Review */}
        {step === 3 && (
          <div className="max-w-2xl mx-auto space-y-4">
            <div>
              <h2 className="text-lg font-bold">Review & Export</h2>
              <p className="text-sm text-slate-400">Review your CMA before sharing</p>
            </div>

            {/* Subject summary */}
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Subject Property</p>
              <h3 className="font-bold text-white text-lg">{subject.name}</h3>
              <p className="text-sm text-slate-400">{subject.county}, {subject.state} · {subject.acres} acres</p>
              {subject.client_name && (
                <p className="text-xs text-slate-500 mt-1">Prepared for: {subject.client_name}</p>
              )}
            </div>

            {/* Value range */}
            {ppaMid > 0 && (
              <div className="bg-sage/5 border border-sage/20 rounded-xl p-4 text-center">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Estimated Value Range</p>
                <div className="flex items-center justify-center gap-4 mb-2">
                  <div>
                    <p className="text-xs text-slate-500">Low</p>
                    <p className="text-lg font-bold text-white font-mono">{formatCurrency(valueLow)}</p>
                    <p className="text-xs text-slate-500 font-mono">{formatPPA(ppaLow)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-slate-500">Mid</p>
                    <p className="text-2xl font-bold text-sage font-mono">{formatCurrency(valueMid)}</p>
                    <p className="text-xs text-sage font-mono">{formatPPA(ppaMid)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">High</p>
                    <p className="text-lg font-bold text-white font-mono">{formatCurrency(valueHigh)}</p>
                    <p className="text-xs text-slate-500 font-mono">{formatPPA(ppaHigh)}</p>
                  </div>
                </div>
                <p className="text-xs text-slate-500">Based on {selectedCompIds.length} comparable sales</p>
              </div>
            )}

            {/* Broker notes */}
            <div>
              <label className={labelClass}>Broker Analysis / Notes</label>
              <textarea
                value={subject.broker_notes}
                onChange={e => setSubject({...subject, broker_notes: e.target.value})}
                placeholder="Add your market analysis and recommendations..."
                rows={4}
                className={`${inputClass} resize-none`}
              />
            </div>

            {/* Selected comps summary */}
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                {selectedComps.length} Comparable Sales
              </p>
              <div className="space-y-1.5">
                {selectedComps.map(comp => (
                  <div key={comp.id} className="flex items-center justify-between bg-card border border-border rounded-lg px-3 py-2">
                    <div>
                      <p className="text-xs font-bold text-white">
                        {comp.property_name || `${comp.county} County`}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {formatAcres(comp.acres)} · {comp.sale_date ? new Date(comp.sale_date).toLocaleDateString('en-US', {month:'short', year:'numeric'}) : ''}
                      </p>
                    </div>
                    <span className="text-xs font-bold text-emerald-400 font-mono">
                      {formatPPA(comp.ppa_land_only || comp.price_per_acre || 0)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button onClick={() => setStep(2)}
                className="flex items-center gap-1.5 px-4 py-2.5 border border-border rounded-xl text-sm font-bold text-slate-400 hover:text-white transition-colors">
                <ChevronLeft size={14} /> Back
              </button>
              <button
                onClick={saveCMA}
                disabled={loading}
                className="flex-1 py-2.5 bg-sage hover:bg-sage2 text-black font-bold rounded-xl transition-colors disabled:opacity-50"
              >
                {loading ? 'Saving...' : 'Save & Share CMA →'}
              </button>
            </div>
          </div>
        )}

        {/* STEP 4: Share */}
        {step === 4 && savedCMA && (
          <div className="max-w-md mx-auto text-center space-y-6 py-8">
            <div className="w-16 h-16 rounded-2xl bg-sage/10 border border-sage/20 flex items-center justify-center mx-auto">
              <Check size={28} className="text-sage" />
            </div>

            <div>
              <h2 className="text-xl font-bold mb-2">CMA Ready to Share</h2>
              <p className="text-sm text-slate-400">
                Your client will see an interactive report with the map, comps, and value range.
              </p>
            </div>

            <div className="bg-card border border-border rounded-xl p-4 text-left">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Share Link</p>
              <code className="text-xs text-sage font-mono break-all">
                {typeof window !== 'undefined' ? window.location.origin : ''}/report/{savedCMA.share_token}
              </code>
            </div>

            <div className="flex gap-2">
              <button
                onClick={copyShareLink}
                className="flex-1 py-3 flex items-center justify-center gap-2 bg-sage hover:bg-sage2 text-black font-bold rounded-xl transition-colors"
              >
                <Share2 size={16} />
                Copy Share Link
              </button>
            </div>

            <button
              onClick={() => {
                setStep(1);
                setSavedCMA(null);
                setSelectedCompIds([]);
                setSubject({ name: '', address: '', county: '', state: 'TX', acres: '', description: '', client_name: '', broker_notes: '', cma_mode: 'land_only' });
              }}
              className="text-sm text-slate-400 hover:text-white transition-colors"
            >
              + Create Another CMA
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

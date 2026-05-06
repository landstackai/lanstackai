'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Comp, BestUse, WaterQuality, RoadFrontage, DevPotential } from '@/types';
import { TEXAS_COUNTIES } from '@/lib/utils';
import { X, ChevronRight, ChevronLeft, Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';

interface CompModalProps {
  comp?: Comp | null;
  onClose: () => void;
  onSave: () => void;
}

const BEST_USE_OPTIONS: BestUse[] = ['Recreational', 'Agriculture', 'Investment', 'Development', 'Conservation', 'Timber'];

export default function CompModal({ comp, onClose, onSave }: CompModalProps) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const supabase = createClient();

  const [form, setForm] = useState({
    property_name: '',
    status: 'Sold',
    county: '',
    state: 'TX',
    acres: '',
    sale_price: '',
    improvements_value: '',
    sale_date: '',
    address: '',
    latitude: '',
    longitude: '',
    parcel_id: '',
    water: 'None' as WaterQuality,
    road_frontage: 'None' as RoadFrontage,
    dev_potential: 'Low' as DevPotential,
    best_use: [] as BestUse[],
    topography: '',
    improvements_notes: '',
    minerals_sold: 'Surface only',
    ag_exemption: false,
    wildlife_notes: '',
    flood_plain_pct: '',
    grantor: '',
    grantee: '',
    financing: 'Cash to seller',
    recording_number: '',
    confirmation_source: '',
    description: '',
    source_url: '',
    visibility: 'team',
    confidence: 'Unverified',
    is_company_transaction: false,
    has_improvements: false,
    use_land_only_for_cma: true,
  });

  useEffect(() => {
    if (comp) {
      setForm({
        property_name: comp.property_name || '',
        status: comp.status || 'Sold',
        county: comp.county || '',
        state: comp.state || 'TX',
        acres: comp.acres?.toString() || '',
        sale_price: comp.sale_price?.toString() || '',
        improvements_value: comp.improvements_value?.toString() || '',
        sale_date: comp.sale_date || '',
        address: comp.address || '',
        latitude: comp.latitude?.toString() || '',
        longitude: comp.longitude?.toString() || '',
        parcel_id: comp.parcel_id || '',
        water: comp.water || 'None',
        road_frontage: comp.road_frontage || 'None',
        dev_potential: comp.dev_potential || 'Low',
        best_use: comp.best_use || [],
        topography: comp.topography || '',
        improvements_notes: comp.improvements_notes || '',
        minerals_sold: comp.minerals_sold || 'Surface only',
        ag_exemption: comp.ag_exemption || false,
        wildlife_notes: comp.wildlife_notes || '',
        flood_plain_pct: comp.flood_plain_pct?.toString() || '',
        grantor: comp.grantor || '',
        grantee: comp.grantee || '',
        financing: comp.financing || 'Cash to seller',
        recording_number: comp.recording_number || '',
        confirmation_source: comp.confirmation_source || '',
        description: comp.description || '',
        source_url: comp.source_url || '',
        visibility: comp.visibility || 'team',
        confidence: comp.confidence || 'Unverified',
        is_company_transaction: comp.is_company_transaction || false,
        has_improvements: comp.has_improvements || false,
        use_land_only_for_cma: comp.use_land_only_for_cma !== false,
      });
    }
  }, [comp]);

  const ppa = form.acres && form.sale_price
    ? (parseFloat(form.sale_price) / parseFloat(form.acres)).toFixed(0)
    : null;

  const landOnlyPrice = form.has_improvements && form.improvements_value && form.sale_price
    ? parseFloat(form.sale_price) - parseFloat(form.improvements_value)
    : null;

  const toggleBestUse = (use: BestUse) => {
    setForm(f => ({
      ...f,
      best_use: f.best_use.includes(use)
        ? f.best_use.filter(u => u !== use)
        : [...f.best_use, use]
    }));
  };

  const generateDescription = async () => {
    if (!form.county || !form.acres) {
      toast.error('Add county and acres first');
      return;
    }
    setGenerating(true);
    try {
      const response = await fetch('/api/generate-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (data.description) {
        setForm(f => ({ ...f, description: data.description }));
        toast.success('Description generated!');
      }
    } catch {
      toast.error('Failed to generate description');
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!form.county || !form.acres || !form.sale_price) {
      toast.error('County, acres, and price are required');
      return;
    }
    setLoading(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const payload = {
      created_by: user.id,
      property_name: form.property_name || null,
      status: form.status,
      county: form.county,
      state: form.state,
      acres: parseFloat(form.acres),
      sale_price: parseFloat(form.sale_price),
      improvements_value: form.has_improvements && form.improvements_value
        ? parseFloat(form.improvements_value) : null,
      sale_date: form.sale_date || null,
      address: form.address || null,
      latitude: form.latitude ? parseFloat(form.latitude) : null,
      longitude: form.longitude ? parseFloat(form.longitude) : null,
      parcel_id: form.parcel_id || null,
      water: form.water,
      road_frontage: form.road_frontage,
      dev_potential: form.dev_potential,
      best_use: form.best_use,
      topography: form.topography || null,
      improvements_notes: form.improvements_notes || null,
      minerals_sold: form.minerals_sold || null,
      ag_exemption: form.ag_exemption,
      wildlife_notes: form.wildlife_notes || null,
      flood_plain_pct: form.flood_plain_pct ? parseFloat(form.flood_plain_pct) : null,
      grantor: form.grantor || null,
      grantee: form.grantee || null,
      financing: form.financing || null,
      recording_number: form.recording_number || null,
      confirmation_source: form.confirmation_source || null,
      description: form.description || null,
      source_url: form.source_url || null,
      visibility: form.visibility,
      confidence: form.confidence,
      is_company_transaction: form.is_company_transaction,
      has_improvements: form.has_improvements,
      use_land_only_for_cma: form.use_land_only_for_cma,
      is_draft: false,
    };

    let error;
    if (comp) {
      ({ error } = await supabase.from('comps').update(payload).eq('id', comp.id));
    } else {
      ({ error } = await supabase.from('comps').insert(payload));
    }

    if (error) {
      toast.error('Failed to save comp');
      setLoading(false);
    } else {
      toast.success(comp ? 'Comp updated!' : 'Comp added!');
      onSave();
    }
  };

  const inputClass = "w-full bg-card border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-sage transition-colors";
  const labelClass = "block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5";

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end md:items-center justify-center p-0 md:p-4">
      <div className="w-full md:max-w-2xl bg-panel border border-border md:rounded-2xl overflow-hidden flex flex-col max-h-[95vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div>
            <h2 className="font-bold text-base">{comp ? 'Edit Comp' : 'Add Comp'}</h2>
            <div className="flex items-center gap-1 mt-1">
              {[1, 2, 3].map(s => (
                <div key={s} className={`h-1 w-8 rounded-full transition-colors ${s <= step ? 'bg-sage' : 'bg-border'}`} />
              ))}
              <span className="text-xs text-slate-500 ml-2">Step {step} of 3</span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* STEP 1: Core */}
          {step === 1 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Property Name</label>
                  <input value={form.property_name} onChange={e => setForm({...form, property_name: e.target.value})}
                    placeholder="Rimrock Ranch" className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Status</label>
                  <select value={form.status} onChange={e => setForm({...form, status: e.target.value})} className={inputClass}>
                    {['Sold','Active','Pending','Withdrawn'].map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>County *</label>
                  <input list="counties-modal" value={form.county}
                    onChange={e => setForm({...form, county: e.target.value})}
                    placeholder="Real" className={inputClass} />
                  <datalist id="counties-modal">
                    {TEXAS_COUNTIES.map(c => <option key={c} value={c} />)}
                  </datalist>
                </div>
                <div>
                  <label className={labelClass}>State</label>
                  <input value={form.state} onChange={e => setForm({...form, state: e.target.value})}
                    placeholder="TX" className={inputClass} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Acres *</label>
                  <input type="number" value={form.acres}
                    onChange={e => setForm({...form, acres: e.target.value})}
                    placeholder="455.92" className={`${inputClass} font-mono`} />
                </div>
                <div>
                  <label className={labelClass}>Sale Date</label>
                  <input type="date" value={form.sale_date}
                    onChange={e => setForm({...form, sale_date: e.target.value})}
                    className={inputClass} />
                </div>
              </div>

              <div>
                <label className={labelClass}>Total Sale Price *</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                  <input type="number" value={form.sale_price}
                    onChange={e => setForm({...form, sale_price: e.target.value})}
                    placeholder="3145855" className={`${inputClass} pl-7 font-mono`} />
                </div>
              </div>

              {/* Improvements toggle */}
              <div className="flex items-center justify-between py-2 px-3 bg-card border border-border rounded-lg">
                <div>
                  <p className="text-sm font-bold text-white">Has Improvements</p>
                  <p className="text-xs text-slate-500">Lodge, barn, cabin, etc.</p>
                </div>
                <button
                  onClick={() => setForm(f => ({...f, has_improvements: !f.has_improvements}))}
                  className={`w-11 h-6 rounded-full transition-colors relative ${form.has_improvements ? 'bg-sage' : 'bg-border'}`}
                >
                  <div className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${form.has_improvements ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>

              {form.has_improvements && (
                <div>
                  <label className={labelClass}>Improvements Value (ECV)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                    <input type="number" value={form.improvements_value}
                      onChange={e => setForm({...form, improvements_value: e.target.value})}
                      placeholder="351139" className={`${inputClass} pl-7 font-mono`} />
                  </div>
                  {landOnlyPrice && (
                    <p className="text-xs text-emerald-400 font-mono mt-1">
                      Land-only: ${landOnlyPrice.toLocaleString()} · ${(landOnlyPrice / parseFloat(form.acres || '1')).toFixed(0)}/ac
                    </p>
                  )}
                </div>
              )}

              {ppa && (
                <div className="bg-sage/5 border border-sage/20 rounded-lg px-3 py-2 flex justify-between">
                  <span className="text-xs text-slate-400">Price per acre</span>
                  <span className="text-sage font-bold font-mono text-sm">${parseInt(ppa).toLocaleString()}/ac</span>
                </div>
              )}

              {/* Visibility */}
              <div>
                <label className={labelClass}>Visibility</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 'private', label: '🔒 Private', desc: 'Only you' },
                    { value: 'team', label: '👥 Team', desc: 'Your team' },
                    { value: 'shared', label: '🌐 Shared', desc: 'Everyone' },
                  ].map(v => (
                    <button
                      key={v.value}
                      onClick={() => setForm(f => ({...f, visibility: v.value}))}
                      className={`p-2 rounded-lg border text-left transition-colors ${
                        form.visibility === v.value
                          ? 'border-sage bg-sage/10 text-sage'
                          : 'border-border text-slate-400 hover:border-slate-500'
                      }`}
                    >
                      <div className="text-xs font-bold">{v.label}</div>
                      <div className="text-[10px] opacity-70">{v.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* STEP 2: Location & Value Drivers */}
          {step === 2 && (
            <>
              <div>
                <label className={labelClass}>Address</label>
                <input value={form.address} onChange={e => setForm({...form, address: e.target.value})}
                  placeholder="7899 Rand Road 2631, Barksdale, TX" className={inputClass} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Latitude</label>
                  <input type="number" value={form.latitude}
                    onChange={e => setForm({...form, latitude: e.target.value})}
                    placeholder="29.8484993" className={`${inputClass} font-mono`} />
                </div>
                <div>
                  <label className={labelClass}>Longitude</label>
                  <input type="number" value={form.longitude}
                    onChange={e => setForm({...form, longitude: e.target.value})}
                    placeholder="-99.93340302" className={`${inputClass} font-mono`} />
                </div>
              </div>

              <div>
                <label className={labelClass}>Parcel ID</label>
                <input value={form.parcel_id} onChange={e => setForm({...form, parcel_id: e.target.value})}
                  placeholder="CAD parcel ID" className={inputClass} />
              </div>

              {/* Water */}
              <div>
                <label className={labelClass}>Water</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['None', 'Seasonal', 'Strong'] as WaterQuality[]).map(w => (
                    <button key={w} onClick={() => setForm(f => ({...f, water: w}))}
                      className={`py-2 rounded-lg border text-sm font-bold transition-colors ${
                        form.water === w ? 'border-blue-400 bg-blue-400/10 text-blue-400' : 'border-border text-slate-400'
                      }`}
                    >{w}</button>
                  ))}
                </div>
              </div>

              {/* Road Frontage */}
              <div>
                <label className={labelClass}>Road Frontage</label>
                <div className="grid grid-cols-4 gap-2">
                  {(['None', 'Low', 'Medium', 'High'] as RoadFrontage[]).map(r => (
                    <button key={r} onClick={() => setForm(f => ({...f, road_frontage: r}))}
                      className={`py-2 rounded-lg border text-xs font-bold transition-colors ${
                        form.road_frontage === r ? 'border-sage bg-sage/10 text-sage' : 'border-border text-slate-400'
                      }`}
                    >{r}</button>
                  ))}
                </div>
              </div>

              {/* Dev Potential */}
              <div>
                <label className={labelClass}>Development Potential</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['Low', 'Medium', 'High'] as DevPotential[]).map(d => (
                    <button key={d} onClick={() => setForm(f => ({...f, dev_potential: d}))}
                      className={`py-2 rounded-lg border text-sm font-bold transition-colors ${
                        form.dev_potential === d ? 'border-amber-400 bg-amber-400/10 text-amber-400' : 'border-border text-slate-400'
                      }`}
                    >{d}</button>
                  ))}
                </div>
              </div>

              {/* Best Use */}
              <div>
                <label className={labelClass}>Best Use (select all that apply)</label>
                <div className="flex flex-wrap gap-2">
                  {BEST_USE_OPTIONS.map(u => (
                    <button key={u} onClick={() => toggleBestUse(u)}
                      className={`px-3 py-1.5 rounded-full border text-xs font-bold transition-colors ${
                        form.best_use.includes(u)
                          ? 'border-sage bg-sage/10 text-sage'
                          : 'border-border text-slate-400 hover:border-slate-500'
                      }`}
                    >{u}</button>
                  ))}
                </div>
              </div>

              {/* Texas specific */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Minerals Sold</label>
                  <select value={form.minerals_sold} onChange={e => setForm({...form, minerals_sold: e.target.value})}
                    className={inputClass}>
                    <option>Surface only</option>
                    <option>All minerals</option>
                    <option>None</option>
                    <option>Partial</option>
                    <option>N/A</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Flood Plain %</label>
                  <input type="number" value={form.flood_plain_pct}
                    onChange={e => setForm({...form, flood_plain_pct: e.target.value})}
                    placeholder="0" className={inputClass} />
                </div>
              </div>

              <div>
                <label className={labelClass}>Wildlife Notes</label>
                <input value={form.wildlife_notes} onChange={e => setForm({...form, wildlife_notes: e.target.value})}
                  placeholder="Whitetail, turkey, axis, elk..." className={inputClass} />
              </div>

              <div>
                <label className={labelClass}>Improvements Description</label>
                <input value={form.improvements_notes}
                  onChange={e => setForm({...form, improvements_notes: e.target.value})}
                  placeholder="Main lodge 3,200 SF, horse barn, guest cabin..." className={inputClass} />
              </div>
            </>
          )}

          {/* STEP 3: Transaction & Description */}
          {step === 3 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Grantor (Seller)</label>
                  <input value={form.grantor} onChange={e => setForm({...form, grantor: e.target.value})}
                    placeholder="Sonja R. Klein" className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Grantee (Buyer)</label>
                  <input value={form.grantee} onChange={e => setForm({...form, grantee: e.target.value})}
                    placeholder="Eric & Alissa Copley" className={inputClass} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Financing</label>
                  <select value={form.financing} onChange={e => setForm({...form, financing: e.target.value})}
                    className={inputClass}>
                    <option>Cash to seller</option>
                    <option>Conventional</option>
                    <option>Farm Credit</option>
                    <option>Owner finance</option>
                    <option>Unknown</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Recording Number</label>
                  <input value={form.recording_number}
                    onChange={e => setForm({...form, recording_number: e.target.value})}
                    placeholder="22411" className={inputClass} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Confirmation Source</label>
                  <select value={form.confirmation_source}
                    onChange={e => setForm({...form, confirmation_source: e.target.value})}
                    className={inputClass}>
                    <option value="">Select...</option>
                    <option>Closing Stmt.</option>
                    <option>Contract on File</option>
                    <option>MLS</option>
                    <option>County Records</option>
                    <option>Broker Verified</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Confidence</label>
                  <select value={form.confidence} onChange={e => setForm({...form, confidence: e.target.value})}
                    className={inputClass}>
                    <option value="Verified">Verified</option>
                    <option value="Estimated">Estimated</option>
                    <option value="Unverified">Unverified</option>
                  </select>
                </div>
              </div>

              <div>
                <label className={labelClass}>Source URL / Listing Link</label>
                <input value={form.source_url} onChange={e => setForm({...form, source_url: e.target.value})}
                  placeholder="https://land.com/listing/..." className={inputClass} type="url" />
              </div>

              {/* Description with AI */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className={labelClass + ' mb-0'}>Property Description</label>
                  <button
                    onClick={generateDescription}
                    disabled={generating}
                    className="flex items-center gap-1.5 px-2.5 py-1 bg-sage/10 hover:bg-sage/20 border border-sage/20 text-sage rounded-lg text-xs font-bold transition-colors disabled:opacity-50"
                  >
                    <Sparkles size={11} />
                    {generating ? 'Generating...' : 'AI Generate'}
                  </button>
                </div>
                <textarea
                  value={form.description}
                  onChange={e => setForm({...form, description: e.target.value})}
                  placeholder="Describe the property..."
                  rows={5}
                  className={inputClass + ' resize-none'}
                />
              </div>

              {/* Company transaction flag */}
              <div className="flex items-center gap-3 py-2 px-3 bg-card border border-border rounded-lg">
                <input
                  type="checkbox"
                  id="company-tx"
                  checked={form.is_company_transaction}
                  onChange={e => setForm({...form, is_company_transaction: e.target.checked})}
                  className="w-4 h-4 accent-sage"
                />
                <label htmlFor="company-tx" className="text-sm font-semibold text-slate-300 cursor-pointer">
                  Company Transaction
                </label>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border flex-shrink-0">
          <button
            onClick={() => step > 1 ? setStep(step - 1) : onClose()}
            className="flex items-center gap-1.5 px-4 py-2 border border-border rounded-lg text-sm font-bold text-slate-400 hover:text-white transition-colors"
          >
            <ChevronLeft size={14} />
            {step > 1 ? 'Back' : 'Cancel'}
          </button>

          <div className="flex gap-2">
            {step < 3 ? (
              <button
                onClick={() => setStep(step + 1)}
                className="flex items-center gap-1.5 px-5 py-2 bg-sage hover:bg-sage2 text-black rounded-lg text-sm font-bold transition-colors"
              >
                Next <ChevronRight size={14} />
              </button>
            ) : (
              <button
                onClick={handleSave}
                disabled={loading}
                className="px-6 py-2 bg-sage hover:bg-sage2 text-black rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
              >
                {loading ? 'Saving...' : comp ? 'Save Changes' : 'Add Comp'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

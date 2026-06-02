'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Comp, BestUse, WaterQuality, RoadFrontage, DevPotential } from '@/types';
import { TEXAS_COUNTIES } from '@/lib/utils';
import { normalizeCountyForStorage } from '@/lib/utils/normalizeCounty';
import { X, ChevronRight, ChevronLeft, Sparkles, ChevronDown, ChevronUp, Globe, MapPin } from 'lucide-react';
import LocationPicker from './LocationPicker';
import toast from 'react-hot-toast';

interface CompModalProps {
  comp?: Comp | null;
  onClose: () => void;
  onSave: () => void;
}

const BEST_USE_OPTIONS: BestUse[] = [
  'Recreational',
  'Agriculture',
  'Farm',
  'Vineyard / Orchard',
  'Timber',
  'Conservation',
  'Investment',
  'Development',
  'Single Family Home Development',
  'Multi-Family Development',
  'Rural Land Development',
  'Commercial',
  'Industrial',
  'Data Center',
  'Solar Farm',
  'Wind Farm',
];

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
    transaction_agent_id: null as string | null,
    has_improvements: false,
    use_land_only_for_cma: true,
    // Value-driver flags. The first two render purple pills across all comp
    // surfaces; has_water_rights is collected and searchable but no pill.
    has_live_water: false,
    has_irrigated_farm: false,
    // 3-state: true (Yes) / false (No) / null (N/A — unknown or not applicable).
    has_water_rights: null as boolean | null,
    irrigation: 'None' as 'None' | 'Medium' | 'Strong',
    flood_plain: null as 'Yes' | 'Partial' | 'No' | null,
    // Adjusted Land Value (optional)
    improvement_value: '' as string,
    improvement_source: '' as '' | 'appraiser' | 'agent_verified' | 'broker_estimate',
  });
  const [improvementOpen, setImprovementOpen] = useState(false);
  const [findingListing, setFindingListing] = useState(false);
  const [showLocationPicker, setShowLocationPicker] = useState(false);

  // Teammates for the Transaction Agent dropdown (only relevant when the
  // Company Transaction box is checked). Loaded once on mount.
  const [teammates, setTeammates] = useState<{ id: string; full_name: string | null; email: string | null }[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled || !user) return;
      setCurrentUserId(user.id);
      const { data: me } = await supabase
        .from('profiles')
        .select('team_id,full_name,email')
        .eq('id', user.id)
        .maybeSingle();
      if (cancelled) return;
      const myRow = { id: user.id, full_name: (me as any)?.full_name ?? null, email: (me as any)?.email ?? null };
      const tid = (me as any)?.team_id;
      if (tid) {
        const { data: mates } = await supabase
          .from('profiles')
          .select('id,full_name,email')
          .eq('team_id', tid);
        if (cancelled) return;
        const list = ((mates as any) || []).filter((m: any) => m.id !== user.id);
        setTeammates([myRow, ...list]);
      } else {
        setTeammates([myRow]);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const findListing = async () => {
    if (!comp?.id) {
      toast('Save the comp first, then click again to find a listing', { icon: 'ℹ️', duration: 3000 });
      return;
    }
    setFindingListing(true);
    try {
      const res = await fetch(`/api/comp/${comp.id}/find-listing`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Search failed');
        return;
      }
      if (data.url) {
        setForm(f => ({ ...f, source_url: data.url }));
        toast.success('Listing found — review and save the form to keep it');
      } else {
        toast(data.reason || 'No matching listing found', { icon: '🔍', duration: 4000 });
      }
    } catch (e: any) {
      toast.error(e?.message || 'Search failed');
    } finally {
      setFindingListing(false);
    }
  };

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
        transaction_agent_id: (comp as any).transaction_agent_id ?? null,
        has_improvements: comp.has_improvements || false,
        use_land_only_for_cma: comp.use_land_only_for_cma !== false,
        has_live_water: (comp as any).has_live_water || false,
        has_irrigated_farm: (comp as any).has_irrigated_farm || false,
        // Preserve null (N/A) when loading — don't coerce to false.
        has_water_rights:
          (comp as any).has_water_rights === true ? true
          : (comp as any).has_water_rights === false ? false
          : null,
        irrigation: ((comp as any).irrigation as any) || 'None',
        flood_plain:
          (comp as any).flood_plain === 'Yes' ? 'Yes'
          : (comp as any).flood_plain === 'Partial' ? 'Partial'
          : (comp as any).flood_plain === 'No' ? 'No'
          : null,
        improvement_value: comp.improvement_value != null ? String(comp.improvement_value) : '',
        improvement_source: (comp.improvement_source as any) || '',
      });
      if (comp.improvement_value != null) setImprovementOpen(true);
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
      // Normalize to canonical storage form (titlecase, no "County"
      // suffix, compounds comma-separated). Applies on every save —
      // catches both manual edits ("frio county") and any non-canonical
      // value that pre-dated the normalizer.
      county: normalizeCountyForStorage(form.county) || form.county,
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
      // Attribution only persists when this is actually a company transaction
      // — otherwise the field is forced back to null so research comps never
      // accidentally get credited as someone's sale.
      transaction_agent_id: form.is_company_transaction ? form.transaction_agent_id : null,
      has_improvements: form.has_improvements,
      use_land_only_for_cma: form.use_land_only_for_cma,
      has_live_water: form.has_live_water,
      has_irrigated_farm: form.has_irrigated_farm,
      has_water_rights: form.has_water_rights,
      irrigation: form.irrigation,
      flood_plain: form.flood_plain,
      improvement_value: form.improvement_value !== '' ? parseFloat(form.improvement_value) : null,
      improvement_source: form.improvement_source || null,
      // Agent-Verified auto-tags the verifier and timestamp (internal audit trail
      // — never shown on the client share report). For appraiser / broker_estimate
      // / cleared, blank out the audit columns.
      improvement_verified_by: form.improvement_source === 'agent_verified' ? user.id : null,
      improvement_verified_at: form.improvement_source === 'agent_verified' ? new Date().toISOString() : null,
      is_draft: false,
    };

    // Defensive scrub: any field whose value is the literal `undefined`
    // (or the STRING "undefined" — leaks in from bad form state where a
    // value got stringified somewhere upstream) gets coerced to null
    // before the save. Postgres UUID columns are the loudest about this:
    // "invalid input syntax for type uuid: 'undefined'" with no hint
    // which column. The self-healing retry below catches missing-column
    // errors but can't recover from UUID format errors mid-payload.
    // Scrubbing once at the top makes the payload safe regardless of
    // where the bad value originated.
    for (const k of Object.keys(payload)) {
      const v = (payload as any)[k];
      if (v === undefined || v === 'undefined') {
        (payload as any)[k] = null;
      }
    }

    // Self-healing save: if a column doesn't exist in the deployed Supabase
    // schema (e.g. a migration hasn't been run yet), strip that field from
    // the payload and retry. Up to 10 retries — covers the case where a
    // payload references several columns from un-run migrations.
    let current: Record<string, any> = { ...payload };
    let lastError: any = null;
    let success = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const { error } = comp
        ? await supabase.from('comps').update(current).eq('id', comp.id)
        : await supabase.from('comps').insert(current);
      if (!error) {
        success = true;
        break;
      }
      lastError = error;
      const msg = String(error.message || '');
      const m = msg.match(/Could not find the '([\w_]+)' column/);
      if (!m) break;
      const missingCol = m[1];
      if (!(missingCol in current)) break;
      console.warn(`[CompModal] schema missing '${missingCol}' — retrying without it`);
      delete current[missingCol];
    }

    if (!success) {
      const detail = lastError?.message || lastError?.details || 'unknown error';
      // Log the full payload alongside the error so next time we hit
      // a Postgres type error we can grep the console for which field
      // had the bad value (e.g. transaction_agent_id: "undefined").
      console.error('[CompModal] save failed:', lastError, { payload: current });
      toast.error(`Save failed: ${detail}`, { duration: 6000 });
      setLoading(false);
    } else {
      toast.success(comp ? 'Comp updated!' : 'Comp added!');
      onSave();
    }
  };

  const inputClass = "w-full bg-cream border border-beige rounded-lg px-3 py-2.5 text-sm text-ink placeholder-ink-3 outline-none focus:border-olive transition-colors";
  const labelClass = "block text-xs font-bold text-ink-2 uppercase tracking-wider mb-1.5";

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end md:items-center justify-center p-0 md:p-4">
      <div className="w-full md:max-w-2xl bg-white border border-beige md:rounded-2xl overflow-hidden flex flex-col max-h-[95vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-beige flex-shrink-0">
          <div>
            <h2 className="font-bold text-base">{comp ? 'Edit Comp' : 'Add Comp'}</h2>
            <div className="flex items-center gap-1 mt-1">
              {[1, 2, 3].map(s => (
                <div key={s} className={`h-1 w-8 rounded-full transition-colors ${s <= step ? 'bg-olive' : 'bg-beige'}`} />
              ))}
              <span className="text-xs text-ink-3 ml-2">Step {step} of 3</span>
            </div>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink transition-colors">
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
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-2 text-sm">$</span>
                  <input type="number" value={form.sale_price}
                    onChange={e => setForm({...form, sale_price: e.target.value})}
                    placeholder="3145855" className={`${inputClass} pl-7 font-mono`} />
                </div>
              </div>

              {/* Improvements toggle */}
              <div className="flex items-center justify-between py-2 px-3 bg-cream border border-beige rounded-lg">
                <div>
                  <p className="text-sm font-bold text-ink">Has Improvements</p>
                  <p className="text-xs text-ink-3">Lodge, barn, cabin, etc.</p>
                </div>
                <button
                  onClick={() => setForm(f => ({...f, has_improvements: !f.has_improvements}))}
                  className={`w-11 h-6 rounded-full transition-colors relative ${form.has_improvements ? 'bg-olive' : 'bg-beige'}`}
                >
                  <div className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${form.has_improvements ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>

              {form.has_improvements && (
                <div>
                  <label className={labelClass}>Improvements Value (ECV)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-2 text-sm">$</span>
                    <input type="number" value={form.improvements_value}
                      onChange={e => setForm({...form, improvements_value: e.target.value})}
                      placeholder="351139" className={`${inputClass} pl-7 font-mono`} />
                  </div>
                  {landOnlyPrice && (
                    <p className="text-xs text-olive font-mono mt-1">
                      Land-only: ${landOnlyPrice.toLocaleString()} · ${(landOnlyPrice / parseFloat(form.acres || '1')).toFixed(0)}/ac
                    </p>
                  )}
                </div>
              )}


              {ppa && (
                <div className="bg-olive-tint border border-olive-border rounded-lg px-3 py-2 flex justify-between">
                  <span className="text-xs text-ink-2">Price per acre</span>
                  <span className="text-olive-2 font-bold font-mono text-sm">${parseInt(ppa).toLocaleString()}/ac</span>
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
                          ? 'border-olive bg-olive-tint text-olive-2'
                          : 'border-beige text-ink-2 hover:border-beige-2'
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
              {/* Map picker — opens a satellite map for click-to-set when the
                  address can't be geocoded (rural land typical). */}
              <button
                type="button"
                onClick={() => setShowLocationPicker(true)}
                className="flex items-center justify-center gap-1.5 w-full py-2 border border-olive-border bg-olive-tint hover:bg-olive-tint text-olive-2 rounded-lg text-xs font-bold transition-colors"
              >
                <MapPin size={12} />
                {form.latitude && form.longitude ? 'Adjust Location on Map' : 'Set Location on Map'}
              </button>

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
                        form.water === w ? 'border-olive bg-olive-tint text-olive-2' : 'border-beige text-ink-2'
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
                        form.road_frontage === r ? 'border-olive bg-olive-tint text-olive-2' : 'border-beige text-ink-2'
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
                        form.dev_potential === d ? 'border-amber-500/60 bg-amber-50 text-amber-600' : 'border-beige text-ink-2'
                      }`}
                    >{d}</button>
                  ))}
                </div>
              </div>

              {/* Irrigation — 3-tier enum, slots in alongside Water/Road/Dev.
                  "Strong" triggers the purple IRRIGATION pill on comp surfaces;
                  all tiers display in the chip grid. */}
              <div>
                <label className={labelClass}>Irrigation</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['None', 'Medium', 'Strong'] as const).map(i => (
                    <button
                      key={i}
                      onClick={() => setForm(f => ({...f, irrigation: i}))}
                      className={`py-2 rounded-lg border text-sm font-bold transition-colors ${
                        form.irrigation === i
                          ? 'border-olive-border bg-olive-tint text-olive'
                          : 'border-beige text-ink-2 hover:border-beige-2'
                      }`}
                    >{i}</button>
                  ))}
                </div>
                <p className="text-[10px] text-ink-3 mt-1.5 leading-relaxed">
                  Strong = active center pivot, drip, or current row crops. Medium = partial irrigation. None = dry land. Strong triggers the IRRIGATION pill on comp cards.
                </p>
              </div>

              {/* Best Use */}
              <div>
                <label className={labelClass}>Best Use (select all that apply)</label>
                <div className="flex flex-wrap gap-2">
                  {BEST_USE_OPTIONS.map(u => (
                    <button key={u} onClick={() => toggleBestUse(u)}
                      className={`px-3 py-1.5 rounded-full border text-xs font-bold transition-colors ${
                        form.best_use.includes(u)
                          ? 'border-olive bg-olive-tint text-olive-2'
                          : 'border-beige text-ink-2 hover:border-beige-2'
                      }`}
                    >{u}</button>
                  ))}
                </div>
              </div>

              {/* Texas specific — Minerals + Water Rights live together
                  (both are "what rights transfer with the sale" questions),
                  with Flood Plain % below. */}
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
                  <label className={labelClass}>Commercial Water Rights</label>
                  <select
                    value={
                      form.has_water_rights === true ? 'Yes'
                      : form.has_water_rights === false ? 'No'
                      : 'N/A'
                    }
                    onChange={e => {
                      const v = e.target.value;
                      setForm({
                        ...form,
                        has_water_rights: v === 'Yes' ? true : v === 'No' ? false : null,
                      });
                    }}
                    className={inputClass}
                  >
                    <option>N/A</option>
                    <option>No</option>
                    <option>Yes</option>
                  </select>
                  <p className="text-[10px] text-ink-3 mt-1">Well allocation, groundwater rights — distinct from live water.</p>
                </div>
              </div>

              <div>
                <label className={labelClass}>Flood Plain</label>
                <select
                  value={form.flood_plain ?? ''}
                  onChange={e => {
                    const v = e.target.value;
                    setForm({
                      ...form,
                      flood_plain: v === '' ? null : (v as 'Yes' | 'Partial' | 'No'),
                    });
                  }}
                  className={inputClass}
                >
                  <option value="">—</option>
                  <option value="No">No</option>
                  <option value="Partial">Partial</option>
                  <option value="Yes">Yes</option>
                </select>
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
                <div className="flex items-center justify-between mb-1.5">
                  <label className={labelClass + ' mb-0'}>Source URL / Listing Link</label>
                  <button
                    type="button"
                    onClick={findListing}
                    disabled={findingListing}
                    className="flex items-center gap-1.5 px-2.5 py-1 bg-purple-500/15 hover:bg-purple-500/25 border border-purple-400/30 hover:border-purple-400 text-purple-200 rounded-lg text-xs font-bold transition-colors disabled:opacity-50"
                    title="Search Zillow / Realtor / Land for a matching listing"
                  >
                    <Globe size={11} />
                    {findingListing ? 'Searching…' : 'Find Online'}
                  </button>
                </div>
                <input value={form.source_url} onChange={e => setForm({...form, source_url: e.target.value})}
                  placeholder="https://zillow.com/homedetails/..." className={inputClass} type="url" />
              </div>

              {/* Description with AI */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className={labelClass + ' mb-0'}>Property Description</label>
                  <button
                    onClick={generateDescription}
                    disabled={generating}
                    className="flex items-center gap-1.5 px-2.5 py-1 bg-olive-tint hover:bg-olive-tint border border-olive-border text-olive-2 rounded-lg text-xs font-bold transition-colors disabled:opacity-50"
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

              {/* Company transaction flag + Transaction Agent attribution.
                  The agent dropdown only shows when the box is checked.
                  Defaults to the current user; can be changed to a teammate
                  if it was their deal. Cleared when the box is unchecked. */}
              <div className="bg-cream border border-beige rounded-lg overflow-hidden">
                <div className="flex items-center gap-3 py-2 px-3">
                  <input
                    type="checkbox"
                    id="company-tx"
                    checked={form.is_company_transaction}
                    onChange={e => {
                      const checked = e.target.checked;
                      setForm(f => ({
                        ...f,
                        is_company_transaction: checked,
                        // Default the agent to the current user the first time the box
                        // is checked. Clear it when unchecked.
                        transaction_agent_id: checked
                          ? (f.transaction_agent_id ?? currentUserId)
                          : null,
                      }));
                    }}
                    className="w-4 h-4 accent-olive"
                  />
                  <label htmlFor="company-tx" className="text-sm font-semibold text-ink cursor-pointer">
                    Company Transaction
                  </label>
                </div>
                {form.is_company_transaction && (
                  <div className="px-3 pb-3 pt-1 border-t border-beige">
                    <label className={labelClass}>Transaction Agent</label>
                    <select
                      value={form.transaction_agent_id ?? ''}
                      onChange={e => setForm({...form, transaction_agent_id: e.target.value || null})}
                      className={inputClass}
                    >
                      <option value="">— No specific agent —</option>
                      {teammates.map(m => {
                        const label = (m.full_name || m.email || 'Teammate') + (m.id === currentUserId ? ' (you)' : '');
                        return <option key={m.id} value={m.id}>{label}</option>;
                      })}
                    </select>
                    <p className="text-[10px] text-ink-3 mt-1">
                      Defaults to you. Pick a teammate if it was their deal. Drives the map's "My Sales" filter.
                    </p>
                  </div>
                )}
              </div>

              {/* Improvement Adjustment (optional, collapsible) */}
              <div className="bg-cream border border-beige rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setImprovementOpen(o => !o)}
                  className="w-full flex items-center justify-between px-3 py-2.5 text-left"
                >
                  <div>
                    <p className="text-sm font-bold text-ink">Improvement Adjustment <span className="text-ink-3 font-normal">(optional)</span></p>
                    <p className="text-[10px] text-ink-3">Used to compute land-only price for CMAs.</p>
                  </div>
                  {improvementOpen ? <ChevronUp size={14} className="text-ink-3" /> : <ChevronDown size={14} className="text-ink-3" />}
                </button>
                {improvementOpen && (
                  <div className="px-3 pb-3 pt-1 space-y-3 border-t border-beige">
                    <div>
                      <label className={labelClass}>Improvement Value</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-2 text-sm">$</span>
                        <input
                          type="number"
                          value={form.improvement_value}
                          onChange={e => setForm({...form, improvement_value: e.target.value})}
                          placeholder="e.g. 350000"
                          className={`${inputClass} pl-7 font-mono`}
                        />
                      </div>
                    </div>
                    <div>
                      <label className={labelClass}>Source</label>
                      <select
                        value={form.improvement_source}
                        onChange={e => setForm({...form, improvement_source: e.target.value as any})}
                        className={inputClass}
                      >
                        <option value="">Select…</option>
                        <option value="appraiser">Appraiser Report</option>
                        <option value="agent_verified">Agent-Verified (listing/buyer's agent)</option>
                        <option value="broker_estimate">Broker Estimate</option>
                      </select>
                    </div>
                    <p className="text-[10px] text-ink-3 leading-relaxed">
                      Leaving these blank keeps the comp behaving exactly as before. Agent-Verified
                      means you (or a teammate) had first-hand knowledge of the transaction —
                      the client sees a green badge but never your name. Broker estimates are
                      flagged for client disclosure.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-beige flex-shrink-0">
          <button
            onClick={() => step > 1 ? setStep(step - 1) : onClose()}
            className="flex items-center gap-1.5 px-4 py-2 border border-beige rounded-lg text-sm font-bold text-ink-2 hover:text-ink transition-colors"
          >
            <ChevronLeft size={14} />
            {step > 1 ? 'Back' : 'Cancel'}
          </button>

          <div className="flex gap-2">
            {step < 3 ? (
              <button
                onClick={() => setStep(step + 1)}
                className="flex items-center gap-1.5 px-5 py-2 bg-olive hover:bg-olive-2 text-white rounded-lg text-sm font-bold transition-colors"
              >
                Next <ChevronRight size={14} />
              </button>
            ) : (
              <button
                onClick={handleSave}
                disabled={loading}
                className="px-6 py-2 bg-olive hover:bg-olive-2 text-white rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
              >
                {loading ? 'Saving...' : comp ? 'Save Changes' : 'Add Comp'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Location picker — overlay on top of the comp modal.
          Pass description + address + propertyName + compId so the picker
          shows the appraiser's prose alongside the satellite, and auto-flies
          to the AI-extracted hint area for a 15-second visual match. */}
      {showLocationPicker && (
        <LocationPicker
          initialLat={form.latitude ? parseFloat(form.latitude) : null}
          initialLng={form.longitude ? parseFloat(form.longitude) : null}
          county={form.county || null}
          state={form.state || 'TX'}
          compId={comp?.id || null}
          description={form.description || null}
          address={form.address || null}
          propertyName={form.property_name || null}
          onPick={async (lat, lng) => {
            setForm({ ...form, latitude: lat.toString(), longitude: lng.toString() });
            setShowLocationPicker(false);
            toast.success('Location set');
            // Bump location_confidence to 'verified' — broker has confirmed
            // by clicking the actual property on the satellite map.
            if (comp?.id) {
              try {
                await supabase
                  .from('comps')
                  .update({
                    latitude: lat,
                    longitude: lng,
                    location_confidence: 'verified',
                  })
                  .eq('id', comp.id);
              } catch {
                // Non-fatal — the form-save below will still write the coords.
              }
              // Learning loop — record manual correction as an exemplar update.
              try {
                await supabase
                  .from('import_exemplars')
                  .update({
                    final_lat: lat,
                    final_lng: lng,
                    was_manually_fixed: true,
                    fixed_at: new Date().toISOString(),
                  })
                  .eq('comp_id', comp.id);
              } catch (e) {
                // Silent — exemplar tracking is best-effort.
              }
            }
          }}
          onClose={() => setShowLocationPicker(false)}
        />
      )}
    </div>
  );
}

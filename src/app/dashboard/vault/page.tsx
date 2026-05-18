'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Comp, CompFilters } from '@/types';
import { Search, Filter, Grid, List, SlidersHorizontal, Plus, FileText, ArrowUp, ArrowDown, Edit, Trash2, AlertTriangle, Clock, MapPinOff } from 'lucide-react';
import CompCard from '@/components/comp/CompCard';
import CompModal from '@/components/comp/CompModal';
import QuickCapture from '@/components/comp/QuickCapture';
import { useSearchParams } from 'next/navigation';
import { formatPPA, formatAcres, formatCurrency } from '@/lib/utils';
import toast from 'react-hot-toast';

// Heuristic city extractor — comps store free-text "address" (e.g.
// "E/S of Ranch Rd 336, Leakey, TX 78873"). City is the segment immediately
// before the state. Returns null if the address doesn't fit the pattern.
function extractCity(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  // Last segment usually contains "ST 12345" or "ST" — the one before it is city.
  // Validate the last segment looks state-like (2 letters maybe + zip).
  const last = parts[parts.length - 1];
  if (!/^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/i.test(last)) {
    // No clean state pattern — try the second-to-last anyway.
    return parts[parts.length - 2] || null;
  }
  return parts[parts.length - 2] || null;
}

type SortKey = 'county' | 'city' | 'acres' | 'sale_price' | 'ppa_total' | 'ppa_adjusted' | 'improved';
type SortDir = 'asc' | 'desc';

const defaultFilters: CompFilters = {
  search: '',
  county: '',
  status: '',
  min_acres: '',
  max_acres: '',
  min_ppa: '',
  max_ppa: '',
  water: '',
  dev_potential: '',
  visibility: '',
  is_company_transaction: null,
  scope: 'all',
};

export default function VaultPage() {
  const [comps, setComps] = useState<Comp[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<CompFilters>(defaultFilters);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showQuickCapture, setShowQuickCapture] = useState(false);
  const [editingComp, setEditingComp] = useState<Comp | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [stats, setStats] = useState({ total: 0, sold: 0, avgPPA: 0 });
  // Sort state for the new table view. Default: most recently sold first
  // (proxy via sale_price desc → switch this to sale_date desc later if we
  // expose date as a sortable column).
  const [sortKey, setSortKey] = useState<SortKey>('county');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  // "Needs Location" filter — show only comps with missing coordinates. Useful
  // after batch imports where rural addresses didn't geocode.
  const [needsLocationOnly, setNeedsLocationOnly] = useState(false);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const supabase = createClient();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get('add') === 'true') {
      setShowQuickCapture(true);
    }
  }, [searchParams]);

  const fetchComps = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('comps')
        .select('*')
        .order('created_at', { ascending: false });

      if (filters.search) {
        query = query.or(`property_name.ilike.%${filters.search}%,county.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
      }
      if (filters.county) query = query.ilike('county', `%${filters.county}%`);
      if (filters.status) query = query.eq('status', filters.status);
      if (filters.water) query = query.eq('water', filters.water);
      if (filters.min_acres) query = query.gte('acres', parseFloat(filters.min_acres));
      if (filters.max_acres) query = query.lte('acres', parseFloat(filters.max_acres));
      if (filters.visibility) query = query.eq('visibility', filters.visibility);

      const { data, error } = await query;

      if (error) throw error;

      const compData = data as Comp[];
      setComps(compData);

      // Calculate stats
      const sold = compData.filter(c => c.status === 'Sold');
      const avgPPA = sold.length > 0
        ? sold.reduce((sum, c) => sum + (c.ppa_land_only || c.price_per_acre || 0), 0) / sold.length
        : 0;

      setStats({
        total: compData.length,
        sold: sold.length,
        avgPPA,
      });
    } catch (error) {
      console.error('Error fetching comps:', error);
      toast.error('Failed to load comps');
    } finally {
      setLoading(false);
    }
  }, [filters, supabase]);

  useEffect(() => {
    fetchComps();
  }, [fetchComps]);

  const handleDeleteComp = async (id: string) => {
    const { error } = await supabase.from('comps').delete().eq('id', id);
    if (error) {
      toast.error('Failed to delete comp');
    } else {
      toast.success('Comp deleted');
      fetchComps();
    }
  };

  return (
    <div className="flex flex-col h-full bg-night">
      {/* Header */}
      <div className="flex-shrink-0 bg-panel border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search comps..."
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              className="w-full bg-card border border-border rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-sage transition-colors"
            />
          </div>

          {/* Scope tabs */}
          <div className="hidden md:flex bg-card border border-border rounded-lg p-0.5">
            {(['all', 'mine', 'team'] as const).map((scope) => (
              <button
                key={scope}
                onClick={() => setFilters({ ...filters, scope })}
                className={`px-3 py-1.5 rounded-md text-xs font-bold capitalize transition-all ${
                  filters.scope === scope
                    ? 'bg-sage/10 text-sage'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {scope}
              </button>
            ))}
          </div>

          {/* Filter toggle */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border transition-colors ${
              showFilters
                ? 'bg-sage/10 border-sage/20 text-sage'
                : 'bg-card border-border text-slate-400 hover:text-slate-200'
            }`}
          >
            <SlidersHorizontal size={13} />
            <span className="hidden md:inline">Filter</span>
          </button>

          {/* View mode */}
          <div className="hidden md:flex bg-card border border-border rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'text-sage bg-sage/10' : 'text-slate-400'}`}
            >
              <List size={14} />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'text-sage bg-sage/10' : 'text-slate-400'}`}
            >
              <Grid size={14} />
            </button>
          </div>

          {/* Add buttons */}
          <button
            onClick={() => setShowQuickCapture(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-card border border-border rounded-lg text-xs font-bold text-slate-300 hover:text-white transition-colors"
          >
            <Plus size={13} />
            <span className="hidden md:inline">Quick</span>
          </button>

          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-sage hover:bg-sage2 text-black rounded-lg text-xs font-bold transition-colors"
          >
            <Plus size={13} />
            <span className="hidden md:inline">Add Comp</span>
          </button>
        </div>

        {/* Stats bar */}
        <div className="flex items-center gap-4 mt-2">
          <span className="text-xs text-slate-500">
            <span className="text-white font-bold">{stats.total}</span> comps
          </span>
          <span className="text-xs text-slate-500">
            <span className="text-white font-bold">{stats.sold}</span> sold
          </span>
          {stats.avgPPA > 0 && (
            <span className="text-xs text-slate-500">
              Avg <span className="text-sage font-bold font-mono">{formatPPA(stats.avgPPA)}</span>
            </span>
          )}
        </div>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="flex-shrink-0 bg-panel border-b border-border px-4 py-3">
          <div className="flex flex-wrap gap-3">
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value as any })}
              className="bg-card border border-border rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-sage"
            >
              <option value="">All Status</option>
              <option value="Sold">Sold</option>
              <option value="Active">Active</option>
              <option value="Pending">Pending</option>
              <option value="Withdrawn">Withdrawn</option>
            </select>

            <select
              value={filters.water}
              onChange={(e) => setFilters({ ...filters, water: e.target.value as any })}
              className="bg-card border border-border rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-sage"
            >
              <option value="">All Water</option>
              <option value="Strong">Strong</option>
              <option value="Seasonal">Seasonal</option>
              <option value="None">None</option>
            </select>

            <select
              value={filters.visibility}
              onChange={(e) => setFilters({ ...filters, visibility: e.target.value as any })}
              className="bg-card border border-border rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-sage"
            >
              <option value="">All Visibility</option>
              <option value="private">Private</option>
              <option value="team">Team</option>
              <option value="shared">Shared</option>
            </select>

            <input
              type="number"
              placeholder="Min acres"
              value={filters.min_acres}
              onChange={(e) => setFilters({ ...filters, min_acres: e.target.value })}
              className="w-28 bg-card border border-border rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-sage"
            />
            <input
              type="number"
              placeholder="Max acres"
              value={filters.max_acres}
              onChange={(e) => setFilters({ ...filters, max_acres: e.target.value })}
              className="w-28 bg-card border border-border rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-sage"
            />

            {/* "Needs Location" toggle — finds comps where lat/lng failed
                to geocode after import. Tap any in the table → opens the
                map picker so the broker can click to set the real location. */}
            <button
              onClick={() => setNeedsLocationOnly((v) => !v)}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-colors ${
                needsLocationOnly
                  ? 'border-amber-400 bg-amber-400/10 text-amber-400'
                  : 'border-border text-slate-400 hover:text-white hover:border-slate-500'
              }`}
            >
              {needsLocationOnly ? '✓ ' : ''}Needs Location
            </button>

            {/* Cleanup tool — clears coords on comps stuck at the county
                centroid (from imports before we removed that fallback). After
                running, those comps land in the "Needs Location" filter so
                you can fix them manually. */}
            <button
              onClick={async () => {
                if (!confirm('This finds comps stuck at the county centroid (wrong location pins) and clears their coordinates so you can fix them manually. Proceed?')) return;
                try {
                  const { data: { session } } = await supabase.auth.getSession();
                  const res = await fetch('/api/comps/clear-bad-coordinates', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
                  });
                  const data = await res.json();
                  if (!res.ok) {
                    toast.error(data.error || 'Cleanup failed');
                    return;
                  }
                  toast.success(`Checked ${data.checked} comps, cleared ${data.cleared} bad pins`);
                  fetchComps();
                  if (data.cleared > 0) setNeedsLocationOnly(true);
                } catch (e: any) {
                  toast.error(e?.message || 'Cleanup failed');
                }
              }}
              className="px-3 py-1.5 text-xs font-bold rounded-lg border border-purple-400/40 bg-purple-500/10 text-purple-200 hover:bg-purple-500/20 transition-colors"
              title="Find comps pinned at county centroid (wrong location) and clear their coords"
            >
              Fix Bad Pins
            </button>


            <button
              onClick={() => setFilters(defaultFilters)}
              className="px-3 py-1.5 text-xs text-slate-400 hover:text-white border border-border rounded-lg"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Comp list */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-sage border-t-transparent rounded-full animate-spin" />
          </div>
        ) : comps.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <div className="w-12 h-12 rounded-xl bg-card border border-border flex items-center justify-center mb-3">
              <FileText size={20} className="text-slate-500" />
            </div>
            <p className="text-sm font-semibold text-slate-300 mb-1">No comps yet</p>
            <p className="text-xs text-slate-500 mb-4">
              Add your first comp or import from a PDF
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowQuickCapture(true)}
                className="px-4 py-2 bg-card border border-border text-xs font-bold text-white rounded-lg hover:border-sage transition-colors"
              >
                Quick Add
              </button>
              <button
                onClick={() => setShowAddModal(true)}
                className="px-4 py-2 bg-sage text-black text-xs font-bold rounded-lg hover:bg-sage2 transition-colors"
              >
                Add Comp
              </button>
            </div>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {comps.map((comp) => (
              <CompCard
                key={comp.id}
                comp={comp}
                onEdit={() => {
                  setEditingComp(comp);
                  setShowAddModal(true);
                }}
                onDelete={() => handleDeleteComp(comp.id)}
                viewMode="grid"
              />
            ))}
          </div>
        ) : (
          /* TABLE VIEW — 7 columns: County · City · Acres · Total Price ·
             Per Acre (Total $/Ac) · Adjusted ($/Ac) · Improved.
             Click any column header to sort. Row click opens edit modal. */
          (() => {
            // Apply "Needs Location" filter first, then sort.
            const filtered = needsLocationOnly
              ? comps.filter((c) => c.latitude == null || c.longitude == null)
              : comps;
            const sorted = [...filtered].sort((a, b) => {
              const mul = sortDir === 'asc' ? 1 : -1;
              const cityA = extractCity(a.address) || '';
              const cityB = extractCity(b.address) || '';
              const ppaA = a.price_per_acre || 0;
              const ppaB = b.price_per_acre || 0;
              const adjA = a.ppa_land_only || 0;
              const adjB = b.ppa_land_only || 0;
              const impA = a.has_improvements ? 1 : 0;
              const impB = b.has_improvements ? 1 : 0;
              switch (sortKey) {
                case 'county': return (a.county || '').localeCompare(b.county || '') * mul;
                case 'city': return cityA.localeCompare(cityB) * mul;
                case 'acres': return ((a.acres || 0) - (b.acres || 0)) * mul;
                case 'sale_price': return ((a.sale_price || 0) - (b.sale_price || 0)) * mul;
                case 'ppa_total': return (ppaA - ppaB) * mul;
                case 'ppa_adjusted': return (adjA - adjB) * mul;
                case 'improved': return (impA - impB) * mul;
                default: return 0;
              }
            });
            const SortHeader = ({ k, label, align = 'left' }: { k: SortKey; label: string; align?: 'left' | 'right' | 'center' }) => (
              <th
                onClick={() => toggleSort(k)}
                className={`py-2.5 px-3 text-${align} text-[10px] font-bold text-slate-500 uppercase tracking-wider cursor-pointer hover:text-slate-200 transition-colors select-none`}
              >
                <span className="inline-flex items-center gap-1">
                  {label}
                  {sortKey === k && (sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                </span>
              </th>
            );
            return (
              <div className="bg-panel border border-border rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-night/40 border-b border-border sticky top-0 z-10">
                      <tr>
                        <SortHeader k="county" label="County" />
                        <SortHeader k="city" label="City" />
                        <SortHeader k="acres" label="Acres" align="right" />
                        <SortHeader k="sale_price" label="Total Price" align="right" />
                        <SortHeader k="ppa_total" label="Per Acre" align="right" />
                        <SortHeader k="ppa_adjusted" label="Adjusted" align="right" />
                        <SortHeader k="improved" label="Improved" align="center" />
                        <th className="w-16"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((comp) => {
                        const city = extractCity(comp.address);
                        const totalPpa = comp.price_per_acre || 0;
                        const adjustedPpa = comp.ppa_land_only || 0;
                        const hasAdjustment = adjustedPpa > 0 && Math.abs(totalPpa - adjustedPpa) > 1;
                        return (
                          <tr
                            key={comp.id}
                            onClick={() => {
                              setEditingComp(comp);
                              setShowAddModal(true);
                            }}
                            className="border-b border-border last:border-b-0 hover:bg-sage/5 cursor-pointer group transition-colors"
                          >
                            {/* County (with property name as subtext if set).
                                Three possible badges, any combination:
                                  📍❌ red    — comp has no latitude/longitude
                                                at all (autoLocate returned
                                                null and broker hasn't placed
                                                manually yet). Most urgent.
                                  ⚠ amber    — math identity gate flagged this
                                                comp at extraction time (acres
                                                × ppa didn't match sale_price)
                                  🕐 gray    — location wasn't visually
                                                verified by the broker via the
                                                import verification screen.
                                                The pin exists but hasn't been
                                                confirmed.
                                Red sorts first because it's the most actionable:
                                you literally cannot show this comp on a map
                                until someone places it. */}
                            <td className="py-2.5 px-3">
                              <div className="text-sm font-bold text-white flex items-center gap-1.5">
                                {(comp.latitude == null || comp.longitude == null) && (
                                  <span
                                    title="No map location set. Open this comp to place a pin manually via the location picker."
                                    className="inline-flex items-center"
                                  >
                                    <MapPinOff className="w-3.5 h-3.5 text-red-400" />
                                  </span>
                                )}
                                {(comp as any).needs_extraction_review && (
                                  <span
                                    title="Extracted acres × $/acre doesn't match the sale price. At least one of these values is likely wrong — verify before using this comp in a CMA."
                                    className="inline-flex items-center"
                                  >
                                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                                  </span>
                                )}
                                {(comp as any).needs_location_review
                                  && comp.latitude != null
                                  && comp.longitude != null && (
                                  <span
                                    title="Location wasn't visually verified at import. Open this comp to confirm the pin is on the correct parcel."
                                    className="inline-flex items-center"
                                  >
                                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                                  </span>
                                )}
                                <span>{comp.county || '—'}</span>
                              </div>
                              {comp.property_name && (
                                <div className="text-[10px] text-slate-500 truncate max-w-[180px]">
                                  {comp.property_name}
                                </div>
                              )}
                            </td>
                            {/* City */}
                            <td className="py-2.5 px-3 text-sm text-slate-300">
                              {city || <span className="text-slate-600">—</span>}
                              {comp.state && city && (
                                <span className="text-[10px] text-slate-500 ml-1">{comp.state}</span>
                              )}
                            </td>
                            {/* Acres */}
                            <td className="py-2.5 px-3 text-right text-sm font-mono text-white">
                              {formatAcres(comp.acres)}
                            </td>
                            {/* Total Price */}
                            <td className="py-2.5 px-3 text-right text-sm font-mono text-white font-bold">
                              {formatCurrency(comp.sale_price)}
                            </td>
                            {/* Total Per Acre — emerald */}
                            <td className="py-2.5 px-3 text-right text-sm font-mono text-emerald-400 font-bold">
                              {totalPpa > 0 ? formatPPA(totalPpa) : '—'}
                            </td>
                            {/* Adjusted Per Acre — amber, or em-dash when no adjustment */}
                            <td className={`py-2.5 px-3 text-right text-sm font-mono font-bold ${hasAdjustment ? 'text-amber-300' : 'text-slate-600'}`}>
                              {hasAdjustment ? formatPPA(adjustedPpa) : '—'}
                            </td>
                            {/* Improved badge */}
                            <td className="py-2.5 px-3 text-center">
                              {comp.has_improvements ? (
                                <span className="inline-block text-[9px] font-bold px-1.5 py-0.5 bg-purple-400/10 text-purple-400 rounded">
                                  ✓
                                </span>
                              ) : (
                                <span className="text-slate-700">—</span>
                              )}
                            </td>
                            {/* Hover actions */}
                            <td className="py-2.5 px-3 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingComp(comp);
                                    setShowAddModal(true);
                                  }}
                                  title="Edit"
                                  className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/5"
                                >
                                  <Edit size={12} />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteComp(comp.id);
                                  }}
                                  title="Delete"
                                  className="p-1 rounded text-slate-400 hover:text-red-400 hover:bg-red-400/10"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()
        )}
      </div>

      {/* Quick Capture Modal */}
      {showQuickCapture && (
        <QuickCapture
          onClose={() => setShowQuickCapture(false)}
          onSave={() => {
            setShowQuickCapture(false);
            fetchComps();
            toast.success('Comp saved!');
          }}
        />
      )}

      {/* Full Add/Edit Modal */}
      {showAddModal && (
        <CompModal
          comp={editingComp}
          onClose={() => {
            setShowAddModal(false);
            setEditingComp(null);
          }}
          onSave={() => {
            setShowAddModal(false);
            setEditingComp(null);
            fetchComps();
          }}
        />
      )}
    </div>
  );
}

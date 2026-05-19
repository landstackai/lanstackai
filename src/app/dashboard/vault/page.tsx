'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Comp, CompFilters } from '@/types';
import { Search, Filter, Grid, List, SlidersHorizontal, Plus, FileText, ArrowUp, ArrowDown, Edit, Trash2, AlertTriangle, Clock, MapPinOff, ChevronDown, ChevronUp, ShieldQuestion } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { reverseGeocodeCity } from '@/lib/utils/reverseGeocode';
import CompCard from '@/components/comp/CompCard';
import CompModal from '@/components/comp/CompModal';
import QuickCapture from '@/components/comp/QuickCapture';
import { useSearchParams } from 'next/navigation';
import { formatPPA, formatAcres, formatCurrency } from '@/lib/utils';
import toast from 'react-hot-toast';

// Heuristic city extractor — comps store free-text "address" (e.g.
// "E/S of Ranch Rd 336, Leakey, TX 78873"). City is the segment
// immediately before the state. Returns null if the candidate doesn't
// look like a real city — many appraisal addresses are directional
// descriptors ("East side of CR 2875"), county references
// ("Frio County, TX"), or distance phrases ("approximately 11 miles
// northeast of Pleasanton") that should NOT render in the City column.
//
// Patterns recognized as "not a city" and returned as null:
//   - Contains "County" (it's a county name, not a city)
//   - Road designators: Road / Rd / Hwy / FM / CR / RR / Ranch Road /
//                       Highway / Trail / Loop / Drive / Lane
//   - Directional descriptors: "north/south/east/west side of",
//                              "north of", "south of", etc.
//   - Distance phrases: "approximately X miles", "X miles to the..."
//   - Pure ordinal/section descriptors: "End of...", "Side of..."
function extractCity(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  // Last segment usually contains "ST 12345" or "ST" — the one before
  // it is the city candidate.
  const last = parts[parts.length - 1];
  const stateLike = /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/i.test(last);
  const candidate = (stateLike ? parts[parts.length - 2] : parts[parts.length - 1]) || '';
  if (!candidate) return null;

  // "Not a city" filter — patterns that indicate the candidate is
  // really a road / direction / county / distance descriptor, not a
  // place name. Conservative: better to show "—" than to show a junk
  // "city" that confuses brokers scanning the column.
  const NOT_A_CITY = /\b(?:county|road|rd|highway|hwy|fm|fm\.|cr|c\.r\.|rr|r\.r\.|ranch\s+road|loop|trail|trl|drive|dr|lane|ln|boulevard|blvd|parkway|pkwy|court|ct|street|st\.|avenue|ave|way|side\s+of|miles?|approximately|approx|near|north\s+of|south\s+of|east\s+of|west\s+of|northeast\s+of|northwest\s+of|southeast\s+of|southwest\s+of|end\s+of|community\s+of|outside\s+of)\b/i;
  if (NOT_A_CITY.test(candidate)) return null;

  // Additionally reject candidates that are mostly numbers (e.g.
  // "Highway 281" — already caught by the regex, but defense in depth)
  // or contain a typical road/highway number signature.
  if (/\b\d{2,4}\b/.test(candidate)) return null;

  return candidate;
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
  // Collapsible "Needs review" section at top of vault. Defaults to open
  // when there are items to review, closed when there aren't (handled in
  // the render — this state only stores the user's manual toggle).
  const [needsReviewOpen, setNeedsReviewOpen] = useState(true);

  const router = useRouter();

  // Classify a comp's review urgency. Most pressing reason wins when a
  // comp qualifies under multiple categories. Returns null when no
  // review needed (comp is clean).
  type ReviewReason = {
    key: 'no_location' | 'math' | 'flagged' | 'low_confidence';
    label: string;
    icon: 'red' | 'amber' | 'gray' | 'sky';
  };
  const classifyReview = (c: Comp): ReviewReason | null => {
    if (c.latitude == null || c.longitude == null) {
      return { key: 'no_location', label: 'No location pin', icon: 'red' };
    }
    if ((c as any).needs_extraction_review) {
      return { key: 'math', label: "Math doesn't add up", icon: 'amber' };
    }
    if ((c as any).needs_location_review) {
      return { key: 'flagged', label: 'Marked for review', icon: 'gray' };
    }
    if (c.confidence === 'Unverified') {
      return { key: 'low_confidence', label: 'Low confidence', icon: 'sky' };
    }
    return null;
  };

  // Split a comp's compound county into one virtual row per county.
  // "Atascosa, Frio" → two display rows ({_displayCounty: 'Atascosa',
  // _alsoIn: ['Frio']} and {_displayCounty: 'Frio', _alsoIn: ['Atascosa']}).
  // The underlying comp.id is unchanged so map/CMA/click-through all
  // reference the same comp — only the LIST display is split.
  type CompRow = Comp & { _displayCounty: string; _alsoIn: string[]; _rowKey: string };
  const splitCountyRows = (list: Comp[]): CompRow[] => {
    const rows: CompRow[] = [];
    for (const c of list) {
      const raw = (c.county || '').trim();
      if (!raw) {
        rows.push({ ...c, _displayCounty: '', _alsoIn: [], _rowKey: c.id });
        continue;
      }
      const parts = raw.split(/,\s*/).filter(Boolean);
      if (parts.length <= 1) {
        rows.push({ ...c, _displayCounty: parts[0] || raw, _alsoIn: [], _rowKey: c.id });
      } else {
        for (const cy of parts) {
          rows.push({
            ...c,
            _displayCounty: cy,
            _alsoIn: parts.filter((x) => x !== cy),
            _rowKey: `${c.id}::${cy}`,
          });
        }
      }
    }
    return rows;
  };

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

  // Lazy city backfill — for any comp missing comp.city but with valid
  // coords, reverse-geocode the nearest city and write it back. Runs
  // once per render of new comps; results cache permanently in the DB
  // so subsequent renders are instant.
  //
  // Why client-side (not a DB migration): the geocode API requires HTTP
  // access we can't do from inside Postgres. Spreading the cost across
  // normal browsing keeps things simple — first vault load might take
  // an extra few seconds; afterwards everything's instant.
  //
  // RLS limits this to comps the user owns (created_by = auth.uid()).
  // Comps owned by teammates that need backfill will get filled when
  // their owner browses the vault.
  useEffect(() => {
    if (!comps || comps.length === 0) return;
    const needsBackfill = comps.filter(
      (c) =>
        !(c as any).city &&
        typeof c.latitude === 'number' &&
        typeof c.longitude === 'number'
    );
    if (needsBackfill.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const c of needsBackfill) {
        if (cancelled) return;
        const city = await reverseGeocodeCity(c.latitude!, c.longitude!);
        if (!city || cancelled) continue;
        const { error } = await supabase
          .from('comps')
          .update({ city })
          .eq('id', c.id);
        if (error) {
          // RLS blocks updates on comps the user doesn't own — silently
          // skip. Teammate's comp; they'll backfill it themselves.
          continue;
        }
        // Patch local state so the row updates without a full refetch
        setComps((prev) =>
          prev.map((x) => (x.id === c.id ? ({ ...x, city } as any) : x))
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [comps, supabase]);

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
    <div className="flex flex-col h-full bg-gray-50">
      {/* ─── Header: page title + stats + actions ───────────────────────
          Two-row design for visual hierarchy. Top row owns the page
          identity (title, total count, primary CTAs). Second row is
          the working surface (search, filters, view mode). Sticky on
          scroll with a subtle shadow when not at top. */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-6 pt-5 pb-3 shadow-sm">
        {/* Row 1 — title + key stats + primary actions */}
        <div className="flex items-end justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight leading-tight">
              Comp Vault
            </h1>
            <div className="flex items-center gap-5 mt-1.5 text-sm">
              <span className="text-gray-500">
                <span className="font-bold text-gray-900 font-mono tabular-nums">{stats.total}</span>
                {' '}comps
              </span>
              <span className="text-gray-300">·</span>
              <span className="text-gray-500">
                <span className="font-bold text-gray-900 font-mono tabular-nums">{stats.sold}</span>
                {' '}sold
              </span>
              {stats.avgPPA > 0 && (
                <>
                  <span className="text-gray-300">·</span>
                  <span className="text-gray-500">
                    avg{' '}
                    <span className="font-bold text-emerald-700 font-mono tabular-nums">
                      {formatPPA(stats.avgPPA)}
                    </span>
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowQuickCapture(true)}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50 hover:border-gray-400 transition-colors shadow-sm"
            >
              <Plus size={14} />
              Quick
            </button>
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold transition-colors shadow-sm"
            >
              <Plus size={14} />
              Add Comp
            </button>
          </div>
        </div>

        {/* Row 2 — search + filter + view mode */}
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search by property name, address, or county…"
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              className="w-full bg-white border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 transition-all"
            />
          </div>

          {/* Scope tabs */}
          <div className="hidden md:flex bg-gray-50 border border-gray-200 rounded-lg p-0.5">
            {(['all', 'mine', 'team'] as const).map((scope) => (
              <button
                key={scope}
                onClick={() => setFilters({ ...filters, scope })}
                className={`px-3 py-1.5 rounded-md text-xs font-bold capitalize transition-all ${
                  filters.scope === scope
                    ? 'bg-sage/10 text-sage'
                    : 'text-gray-600 hover:text-gray-800'
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
                : 'bg-gray-50 border-gray-200 text-gray-600 hover:text-gray-800'
            }`}
          >
            <SlidersHorizontal size={13} />
            <span className="hidden md:inline">Filter</span>
          </button>

          {/* View mode */}
          <div className="hidden md:flex bg-gray-50 border border-gray-200 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'text-sage bg-sage/10' : 'text-gray-600'}`}
            >
              <List size={14} />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'text-sage bg-sage/10' : 'text-gray-600'}`}
            >
              <Grid size={14} />
            </button>
          </div>

        </div>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-3">
          <div className="flex flex-wrap gap-3">
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value as any })}
              className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-900 outline-none focus:border-sage"
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
              className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-900 outline-none focus:border-sage"
            >
              <option value="">All Water</option>
              <option value="Strong">Strong</option>
              <option value="Seasonal">Seasonal</option>
              <option value="None">None</option>
            </select>

            <select
              value={filters.visibility}
              onChange={(e) => setFilters({ ...filters, visibility: e.target.value as any })}
              className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-900 outline-none focus:border-sage"
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
              className="w-28 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-900 outline-none focus:border-sage"
            />
            <input
              type="number"
              placeholder="Max acres"
              value={filters.max_acres}
              onChange={(e) => setFilters({ ...filters, max_acres: e.target.value })}
              className="w-28 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-900 outline-none focus:border-sage"
            />

            {/* "Needs Location" toggle — finds comps where lat/lng failed
                to geocode after import. Tap any in the table → opens the
                map picker so the broker can click to set the real location. */}
            <button
              onClick={() => setNeedsLocationOnly((v) => !v)}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-colors ${
                needsLocationOnly
                  ? 'border-amber-400 bg-amber-400/10 text-amber-400'
                  : 'border-gray-200 text-gray-600 hover:text-gray-900 hover:border-slate-500'
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
              className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Comp list */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-sage border-t-transparent rounded-full animate-spin" />
          </div>
        ) : comps.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <div className="w-12 h-12 rounded-xl bg-gray-50 border border-gray-200 flex items-center justify-center mb-3">
              <FileText size={20} className="text-gray-500" />
            </div>
            <p className="text-sm font-semibold text-gray-700 mb-1">No comps yet</p>
            <p className="text-xs text-gray-500 mb-4">
              Add your first comp or import from a PDF
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowQuickCapture(true)}
                className="px-4 py-2 bg-gray-50 border border-gray-200 text-xs font-bold text-gray-900 rounded-lg hover:border-sage transition-colors"
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
             Click any column header to sort. Row click opens edit modal.

             Multi-county comps (e.g. "Atascosa, Frio") expand into one row
             per county so they're findable when sorted by county or
             filtered to a single county — but the click-through still
             goes to the same comp.id and they remain one pin on the map. */
          (() => {
            // Apply "Needs Location" filter first, then sort, then split
            // compound counties.
            const filtered = needsLocationOnly
              ? comps.filter((c) => c.latitude == null || c.longitude == null)
              : comps;
            // ─── Compute review-needed comps (separate from main list) ───
            // Sorted newest first (created_at desc) so the most recent
            // imports surface immediately for triage.
            const reviewComps = [...comps]
              .filter((c) => classifyReview(c) !== null)
              .sort((a, b) => {
                const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
                const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
                return tb - ta;
              });
            const sortedBase = [...filtered].sort((a, b) => {
              const mul = sortDir === 'asc' ? 1 : -1;
              // Sort uses the same priority chain as the row render:
              // comp.city → extractCity heuristic → empty string.
              const cityA = (a as any).city || extractCity(a.address) || '';
              const cityB = (b as any).city || extractCity(b.address) || '';
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
            // Split compound counties into virtual rows. Done AFTER sort so
            // each split row sorts by its own _displayCounty when county is
            // the active sort key.
            const sorted = (() => {
              const splitRows = splitCountyRows(sortedBase);
              if (sortKey === 'county') {
                return [...splitRows].sort((a, b) =>
                  a._displayCounty.localeCompare(b._displayCounty) * (sortDir === 'asc' ? 1 : -1)
                );
              }
              return splitRows;
            })();
            const SortHeader = ({ k, label, align = 'left' }: { k: SortKey; label: string; align?: 'left' | 'right' | 'center' }) => (
              <th
                onClick={() => toggleSort(k)}
                className={`py-2.5 px-3 text-${align} text-[10px] font-bold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-800 transition-colors select-none`}
              >
                <span className="inline-flex items-center gap-1">
                  {label}
                  {sortKey === k && (sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                </span>
              </th>
            );
            // Icon helper for the review section — color comes from the
            // classifyReview() icon field.
            const reviewIcon = (icon: ReviewReason['icon']) => {
              const cls = 'w-3.5 h-3.5';
              if (icon === 'red') return <MapPinOff className={`${cls} text-red-400`} />;
              if (icon === 'amber') return <AlertTriangle className={`${cls} text-amber-400`} />;
              if (icon === 'sky') return <ShieldQuestion className={`${cls} text-sky-400`} />;
              return <Clock className={`${cls} text-gray-600`} />;
            };
            return (
              <>
                {/* ─── Needs review section (collapsible) ──────────────
                    Surfaces comps that need attention — no pin, math
                    issues, low confidence — above the main vault list so
                    they don't get lost in a long-scroll. Sorted newest
                    first so the most recent imports route to triage
                    immediately. Click any row to open the per-comp
                    review page. */}
                {reviewComps.length > 0 && (
                  <div className="bg-white border border-gray-200 rounded-xl mb-4 overflow-hidden shadow-sm relative">
                    {/* Amber left-edge accent — semantic alert color. Same
                        pattern as Stripe / Linear / Notion inline alerts. */}
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber-500" />
                    <button
                      onClick={() => setNeedsReviewOpen((v) => !v)}
                      className="w-full flex items-center justify-between pl-5 pr-4 py-3.5 hover:bg-amber-50/50 transition-colors"
                      aria-expanded={needsReviewOpen}
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="flex items-center justify-center w-6 h-6 bg-amber-100 rounded-full">
                          <AlertTriangle size={12} className="text-amber-700" />
                        </div>
                        <span className="text-sm font-semibold text-gray-900">
                          {reviewComps.length} {reviewComps.length === 1 ? 'property needs' : 'properties need'} review
                        </span>
                        <span className="text-xs text-gray-500">— click any row to fix</span>
                      </div>
                      {needsReviewOpen ? <ChevronUp size={16} className="text-gray-600" /> : <ChevronDown size={16} className="text-gray-600" />}
                    </button>
                    {needsReviewOpen && (
                      <div className="border-t border-gray-200">
                        <table className="w-full">
                          <tbody>
                            {reviewComps.map((c) => {
                              const r = classifyReview(c);
                              if (!r) return null;
                              const compCounty = (c.county || '').split(',')[0]?.trim() || '—';
                              return (
                                <tr
                                  key={c.id}
                                  onClick={() => router.push(`/dashboard/review/${c.id}`)}
                                  className="border-b border-gray-200 last:border-b-0 hover:bg-amber-50 cursor-pointer transition-colors"
                                >
                                  <td className="py-2.5 px-4 w-7">
                                    {reviewIcon(r.icon)}
                                  </td>
                                  <td className="py-2.5 px-2 text-sm text-gray-900 font-bold">
                                    {c.property_name || `${compCounty} comp`}
                                  </td>
                                  <td className="py-2.5 px-2 text-xs text-gray-600 whitespace-nowrap">
                                    {c.county || '—'} {c.acres ? `· ${formatAcres(c.acres)}` : ''}
                                  </td>
                                  <td className="py-2.5 px-2 text-xs text-gray-700 whitespace-nowrap">
                                    {r.label}
                                  </td>
                                  <td className="py-2.5 px-4 text-right text-[10px] text-gray-500 whitespace-nowrap">
                                    {c.created_at ? new Date(c.created_at).toLocaleDateString() : ''}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
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
                        // City resolution priority:
                        //   1. comp.city — structured column, set by the lazy
                        //      reverse-geocode backfill or future import flow
                        //   2. extractCity(comp.address) — heuristic on the
                        //      address string for comps that have clean
                        //      "Street, City, ST Zip" addresses
                        //   3. null → render as '—'
                        const city =
                          (comp as any).city || extractCity(comp.address);
                        const totalPpa = comp.price_per_acre || 0;
                        const adjustedPpa = comp.ppa_land_only || 0;
                        const hasAdjustment = adjustedPpa > 0 && Math.abs(totalPpa - adjustedPpa) > 1;
                        // Multi-county: row's display county is _displayCounty;
                        // _alsoIn lists the other counties this comp is in.
                        const displayCounty = comp._displayCounty || comp.county || '—';
                        const alsoIn = comp._alsoIn || [];
                        return (
                          <tr
                            key={comp._rowKey || comp.id}
                            onClick={() => {
                              setEditingComp(comp);
                              setShowAddModal(true);
                            }}
                            className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50 cursor-pointer group transition-colors"
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
                            <td className="py-3.5 px-3">
                              <div className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
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
                                    <Clock className="w-3.5 h-3.5 text-gray-600" />
                                  </span>
                                )}
                                <span>{displayCounty}</span>
                                {alsoIn.length > 0 && (
                                  <span
                                    className="text-[9px] uppercase tracking-wide text-gray-500 bg-gray-100 border border-gray-300 rounded px-1 py-px"
                                    title={`This comp spans multiple counties. Also in: ${alsoIn.join(', ')}`}
                                  >
                                    +{alsoIn.length}
                                  </span>
                                )}
                              </div>
                              {comp.property_name && (
                                <div className="text-[10px] text-gray-500 truncate max-w-[180px]">
                                  {comp.property_name}
                                </div>
                              )}
                              {alsoIn.length > 0 && (
                                <div className="text-[9px] text-gray-400 mt-0.5">
                                  Also in {alsoIn.join(', ')}
                                </div>
                              )}
                            </td>
                            {/* City */}
                            <td className="py-3.5 px-3 text-sm text-gray-700">
                              {city || <span className="text-gray-300">—</span>}
                              {comp.state && city && (
                                <span className="text-[10px] text-gray-400 ml-1">{comp.state}</span>
                              )}
                            </td>
                            {/* Acres */}
                            <td className="py-3.5 px-3 text-right text-sm font-mono tabular-nums text-gray-900">
                              {formatAcres(comp.acres)}
                            </td>
                            {/* Total Price */}
                            <td className="py-3.5 px-3 text-right text-sm font-mono tabular-nums text-gray-900 font-bold">
                              {formatCurrency(comp.sale_price)}
                            </td>
                            {/* Total Per Acre — emerald */}
                            <td className="py-3.5 px-3 text-right text-sm font-mono tabular-nums text-emerald-700 font-bold">
                              {totalPpa > 0 ? formatPPA(totalPpa) : '—'}
                            </td>
                            {/* Adjusted Per Acre — amber, or em-dash when no adjustment */}
                            <td className={`py-3.5 px-3 text-right text-sm font-mono tabular-nums font-bold ${hasAdjustment ? 'text-amber-700' : 'text-gray-300'}`}>
                              {hasAdjustment ? formatPPA(adjustedPpa) : '—'}
                            </td>
                            {/* Improved badge — Stripe/Linear pattern: subtle bg, bold text, rounded pill */}
                            <td className="py-3.5 px-3 text-center">
                              {comp.has_improvements ? (
                                <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 bg-purple-50 text-purple-700 border border-purple-200 rounded-full">
                                  Improved
                                </span>
                              ) : (
                                <span className="text-gray-300">—</span>
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
                                  className="p-1 rounded text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                                >
                                  <Edit size={12} />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteComp(comp.id);
                                  }}
                                  title="Delete"
                                  className="p-1 rounded text-gray-600 hover:text-red-400 hover:bg-red-400/10"
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
              </>
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

'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Comp, CompFilters } from '@/types';
import { Search, Filter, Grid, List, SlidersHorizontal, Plus, FileText, ArrowUp, ArrowDown, Edit, AlertTriangle, Clock, MapPinOff, ChevronDown, ChevronUp, ShieldQuestion, Sparkles, X, Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { reverseGeocodeCity } from '@/lib/utils/reverseGeocode';
import CompCard from '@/components/comp/CompCard';
import CompModal from '@/components/comp/CompModal';
import QuickCapture from '@/components/comp/QuickCapture';
import DeleteConfirmButton from '@/components/ui/DeleteConfirmButton';
import { useSearchParams } from 'next/navigation';
import { formatPPA, formatAcres, formatCurrency } from '@/lib/utils';
import { getRegionForCounty, getRegionsInDisplayOrder, UNASSIGNED_REGION } from '@/lib/utils/texasRegions';
import { findDuplicateClusters, type DuplicateCluster } from '@/lib/utils/findDuplicates';
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

  // ─── AI search state ────────────────────────────────────────────────
  // The vault's search bar is AI-powered: broker types natural language
  // ("Live Water, Kerr, Kendall, Comal county" or "500+ acre Frio comps
  // sold last year") and the same /api/ai-search endpoint that backs the
  // map's search parses it into structured filter criteria.
  //
  // Behavior:
  //   1. On Enter → POST /api/ai-search with the query
  //   2. If response.mode === 'filter' → set aiCriteria, table re-filters
  //   3. If response.mode === 'unknown' → fall back to plain text search
  //      via the existing filters.search field
  //   4. If response.mode === 'location' → toast (the vault doesn't fly)
  //
  // Filter chips below the search bar show what the AI understood; click
  // X on any chip to remove that criterion. "Clear all" wipes the AI
  // filter entirely.
  const [aiQuery, setAiQuery] = useState('');
  const [aiCriteria, setAiCriteria] = useState<any>(null);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [askingAi, setAskingAi] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showQuickCapture, setShowQuickCapture] = useState(false);
  const [editingComp, setEditingComp] = useState<Comp | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  // Vault-level KPIs displayed in dashboard tiles above the table.
  // Same pattern Stripe / QuickBooks / Google Analytics use to anchor
  // a data view — broker sees the headline numbers before they have to
  // read a single row.
  const [stats, setStats] = useState({
    total: 0,
    sold: 0,
    avgPPA: 0,
    totalVolume: 0,           // sum of all sold sale_prices
    recentSales: 0,           // count of sales in the last 90 days
    avgAcres: 0,              // average property size
  });
  // Sort state for the new table view. Default: most recently sold first
  // (proxy via sale_price desc → switch this to sale_date desc later if we
  // expose date as a sortable column).
  const [sortKey, setSortKey] = useState<SortKey>('county');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  // ─── Group-by mode ─────────────────────────────────────────────
  // The vault renders the comp list grouped — county or region. The
  // group header rows show "Totals · N" in the City column with the
  // aggregate values aligned under each data column (Acres, Total,
  // Per Acre, Adjusted). The toggle lives in a slim header bar on
  // the table card itself, right above the column headers.
  //
  //   'alphabetical' — county group headers in alphabetical order
  //                    (Atascosa → Blanco → Comal …) with per-county
  //                    aggregate stats above each group
  //   'regional'     — region group headers (Hill Country / South
  //                    Texas / etc.) with county sub-groups inside.
  //                    Falls back to a single 'Unassigned' bucket
  //                    until the county→region map in
  //                    src/lib/utils/texasRegions.ts is populated.
  //
  // The previous 'none' / Flat mode was removed — column-sort headers
  // still work WITHIN groups, so brokers who want "biggest at top"
  // get it without needing an ungrouped view.
  type GroupBy = 'alphabetical' | 'regional';
  const [groupBy, setGroupBy] = useState<GroupBy>('alphabetical');
  // "Needs Location" filter — show only comps with missing coordinates. Useful
  // after batch imports where rural addresses didn't geocode.
  const [needsLocationOnly, setNeedsLocationOnly] = useState(false);
  // Collapsible "Needs review" section at top of vault. Defaults to open
  // when there are items to review, closed when there aren't (handled in
  // the render — this state only stores the user's manual toggle).
  const [needsReviewOpen, setNeedsReviewOpen] = useState(true);

  // Pairs the broker has explicitly marked as "not duplicates."
  // Persists across reloads in localStorage so we don't keep nagging
  // them about the same false positive. Key format:
  // "smallerId|largerId" so dismissals are order-independent.
  const [dismissedDupePairs, setDismissedDupePairs] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem('landstack:dismissedDupePairs');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) setDismissedDupePairs(new Set(arr));
      }
    } catch {}
  }, []);
  const dismissPair = useCallback((idA: string, idB: string) => {
    const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
    setDismissedDupePairs((prev) => {
      const next = new Set(prev);
      next.add(key);
      try {
        localStorage.setItem('landstack:dismissedDupePairs', JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  }, []);
  // For a cluster: dismiss every pair in it (broker said "these are
  // all different properties"). Easier than asking them to dismiss
  // each pair individually.
  const dismissCluster = useCallback((ids: string[]) => {
    setDismissedDupePairs((prev) => {
      const next = new Set(prev);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i], b = ids[j];
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          next.add(key);
        }
      }
      try {
        localStorage.setItem('landstack:dismissedDupePairs', JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  }, []);

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

      // Calculate KPIs for the dashboard tiles.
      const sold = compData.filter(c => c.status === 'Sold');
      const avgPPA = sold.length > 0
        ? sold.reduce((sum, c) => sum + (c.ppa_land_only || c.price_per_acre || 0), 0) / sold.length
        : 0;
      const totalVolume = sold.reduce((sum, c) => sum + (c.sale_price || 0), 0);
      const avgAcres = sold.length > 0
        ? sold.reduce((sum, c) => sum + (c.acres || 0), 0) / sold.length
        : 0;
      // Recent activity — sales in the last 90 days. Anchors the broker
      // to "how active is this market lately."
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const recentSales = sold.filter((c) => {
        if (!c.sale_date) return false;
        try {
          return new Date(c.sale_date).getTime() >= ninetyDaysAgo.getTime();
        } catch {
          return false;
        }
      }).length;

      setStats({
        total: compData.length,
        sold: sold.length,
        avgPPA,
        totalVolume,
        recentSales,
        avgAcres,
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

  // ─── AI search handlers ──────────────────────────────────────────────
  // POST the user's query to /api/ai-search. The endpoint returns
  // {mode, message, criteria, location} — same shape used by the map's
  // search. Translate the response into local state that the table can
  // filter against.
  const askAi = useCallback(async () => {
    const q = aiQuery.trim();
    if (!q || askingAi) return;
    setAskingAi(true);
    try {
      const res = await fetch('/api/ai-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error || 'AI search failed');
        return;
      }
      if (data.mode === 'filter' && data.criteria) {
        setAiCriteria(data.criteria);
        setAiMessage(data.message || null);
        // Clear the existing text-search filter when AI takes over —
        // otherwise both would try to filter and one would suppress
        // matches the other expected.
        setFilters((f) => ({ ...f, search: '' }));
      } else if (data.mode === 'location') {
        // Locations are a map-page concept; the vault doesn't fly.
        toast(`"${data.location?.name}" is a place — use the map page to fly there.`, { duration: 3500, icon: '📍' });
      } else {
        // mode === 'unknown' or unparseable → fall back to plain text
        // search via the existing filters.search column.
        setFilters((f) => ({ ...f, search: q }));
        setAiCriteria(null);
        setAiMessage(null);
        toast(`Using plain text search for "${q}"`, { duration: 2500 });
      }
    } catch (e: any) {
      toast.error(e?.message || 'AI search failed');
    } finally {
      setAskingAi(false);
    }
  }, [aiQuery, askingAi]);

  const clearAiFilter = () => {
    setAiCriteria(null);
    setAiMessage(null);
    setAiQuery('');
  };

  // Remove a single criterion from aiCriteria. Used by the X on each
  // filter chip. Counties + water are arrays (remove one entry);
  // min_acres / max_acres / has_improvements / etc. are scalars (set
  // to null). When the criteria object becomes empty, clear it entirely
  // so the chip row hides.
  const removeAiCriterion = (key: string, value?: any) => {
    setAiCriteria((prev: any) => {
      if (!prev) return null;
      const next = { ...prev };
      if (value != null && Array.isArray(next[key])) {
        next[key] = (next[key] as any[]).filter((v) => v !== value);
        if (next[key].length === 0) delete next[key];
      } else {
        delete next[key];
      }
      // If everything's gone, clear the whole thing
      const remaining = Object.keys(next).filter((k) => next[k] != null && (!Array.isArray(next[k]) || next[k].length > 0));
      if (remaining.length === 0) {
        setAiMessage(null);
        return null;
      }
      return next;
    });
  };

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
    <div className="flex flex-col h-full bg-cream">
      {/* ─── Header: page title + stats + actions ───────────────────────
          Two-row design for visual hierarchy. Top row owns the page
          identity (title, total count, primary CTAs). Second row is
          the working surface (search, filters, view mode). Sticky on
          scroll with a subtle shadow when not at top. */}
      <div className="flex-shrink-0 bg-white border-b border-beige px-8 pt-7 pb-5">
        {/* Row 1 — page title + primary actions. Restrained typography:
            font-semibold (not bold), tracking-tight for premium feel,
            text-2xl as the upper limit for page titles in a B2B tool.
            Subtitle is text-[13px] in gray-500 — Apple/Stripe convention.
            More horizontal padding (px-8) so the header has room to breathe. */}
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-ink tracking-tight leading-none">
              Comp Vault
            </h1>
            <p className="text-[13px] text-ink-2 mt-2 font-normal">
              {(() => {
                // stats.total reflects the CURRENT QUERY result, which
                // shrinks as filters are applied. Showing "0 properties
                // in your land sales database" when the database has
                // comps but a filter excluded them is misleading — looks
                // like the vault is broken.
                //
                // When filters are active, qualify the count: "N matches
                // in your land sales database" instead of "N properties."
                const hasFilter = !!(
                  filters.search || filters.county || filters.status || filters.water ||
                  filters.min_acres || filters.max_acres || filters.visibility || aiQuery || aiCriteria
                );
                const n = stats.total.toLocaleString();
                if (hasFilter) {
                  return stats.total === 1
                    ? '1 match in your current filter.'
                    : `${n} matches in your current filter.`;
                }
                return stats.total === 1
                  ? 'One property in your land sales database.'
                  : `${n} properties in your land sales database.`;
              })()}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Secondary actions: subtle white with thin gray border.
                Apple/Stripe convention — secondaries should NOT compete
                with primary. font-medium not font-semibold. */}
            <button
              onClick={() => {
                toast('Export coming soon — CSV / PDF support', { icon: '📤' });
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-beige rounded-lg text-[13px] font-medium text-ink/80 hover:bg-cream hover:border-beige-2 transition-colors"
              title="Export comps as CSV or PDF"
            >
              <FileText size={13} />
              Export
            </button>
            <button
              onClick={() => setShowQuickCapture(true)}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-beige rounded-lg text-[13px] font-medium text-ink/80 hover:bg-cream hover:border-beige-2 transition-colors"
            >
              <Plus size={13} />
              Quick
            </button>
            {/* Primary action: solid olive, white text. Olive instead of
                emerald — pale dusty olive ties the brand to land &
                agriculture, calmer than saturated SaaS green. */}
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-olive hover:bg-olive-2 text-white rounded-lg text-[13px] font-medium transition-all shadow-sm hover:shadow"
            >
              <Plus size={13} />
              Add Comp
            </button>
          </div>
        </div>

        {/* Row 2 — AI search + filter + view mode */}
        <div className="flex items-center gap-3 mt-5">
          {/* AI-powered search. Natural-language queries are parsed via
              /api/ai-search into structured filter criteria. Plain text
              (property names, owners) falls back to the existing
              substring search.

              Layout: sparkle icon (left) · input · clear-X (right, when
              text present) · Ask button (right, primary emerald). Same
              pattern Linear / Notion / Raycast use for command-bar
              inputs — primary action is always visible on the right. */}
          <div className="relative flex-1 max-w-2xl">
            <Sparkles size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-olive pointer-events-none" />
            <input
              type="text"
              placeholder='Ask: "Live water Kerr, Kendall, Comal" or "500+ acres in Frio County"'
              value={aiQuery || filters.search}
              onChange={(e) => {
                // Type into the AI bar without committing a filter. The
                // ask-AI handler (Enter / Ask button) decides whether the
                // text becomes structured aiCriteria OR a plain-text
                // filters.search — based on what /api/ai-search returns.
                //
                // Why we don't mirror to filters.search on every keystroke:
                // typing "500+" or "live water Frio" was firing a literal
                // ILIKE substring search BEFORE the AI parser saw the
                // string. None of those substrings exist in any
                // property_name / county / description, so the query
                // returned zero rows and the UI rendered "0 properties in
                // your database" + "No comps yet" — even though the vault
                // was full and the user just hadn't pressed Enter yet.
                setAiQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  askAi();
                }
              }}
              disabled={askingAi}
              className="w-full bg-white border border-beige-2 rounded-lg pl-9 pr-28 py-2.5 text-sm text-ink placeholder-ink-3 outline-none focus:border-olive focus:ring-2 focus:ring-olive/20 transition-all disabled:opacity-60"
            />
            {/* Clear-input X — appears only when there's text. Resets
                the query AND any active AI criteria (clean slate). */}
            {(aiQuery || filters.search) && !askingAi && (
              <button
                type="button"
                onClick={() => {
                  setAiQuery('');
                  setFilters((f) => ({ ...f, search: '' }));
                  clearAiFilter();
                }}
                title="Clear search"
                className="absolute right-[74px] top-1/2 -translate-y-1/2 p-1 rounded text-ink-3 hover:text-ink hover:bg-cream transition-colors"
              >
                <X size={13} />
              </button>
            )}
            {/* Ask button — primary "send to AI" action, anchored inside
                the input. Uses iMessage blue (Apple system #007AFF)
                because brokers have hit this color thousands of times on
                their phones — universal "send chat" affordance. Olive
                stays for creation/state (Add Comp, filter chips); blue
                is reserved for the conversational action. Leading
                Sparkle stays olive — it's the AI "badge," not the CTA. */}
            <button
              type="button"
              onClick={askAi}
              disabled={askingAi || !(aiQuery || filters.search).trim()}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-imsg hover:bg-imsg-2 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[12px] font-medium rounded-md transition-all shadow-sm min-w-[56px] inline-flex items-center justify-center gap-1.5"
            >
              {askingAi ? (
                <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <Sparkles size={11} />
                  Ask
                </>
              )}
            </button>
          </div>

          {/* Scope tabs */}
          <div className="hidden md:flex bg-cream border border-beige rounded-lg p-0.5">
            {(['all', 'mine', 'team'] as const).map((scope) => (
              <button
                key={scope}
                onClick={() => setFilters({ ...filters, scope })}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold capitalize transition-all ${
                  filters.scope === scope
                    ? 'bg-olive-tint text-olive-2'
                    : 'text-ink-2 hover:text-ink'
                }`}
              >
                {scope}
              </button>
            ))}
          </div>

          {/* Filter toggle */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
              showFilters
                ? 'bg-olive-tint border-olive-border text-olive-2'
                : 'bg-cream border-beige text-ink-2 hover:text-ink'
            }`}
          >
            <SlidersHorizontal size={13} />
            <span className="hidden md:inline">Filter</span>
          </button>

          {/* View mode */}
          <div className="hidden md:flex bg-cream border border-beige rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'text-olive-2 bg-olive-tint' : 'text-ink-2'}`}
            >
              <List size={14} />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'text-olive-2 bg-olive-tint' : 'text-ink-2'}`}
            >
              <Grid size={14} />
            </button>
          </div>

        </div>

        {/* Group-by toggle moved out of the toolbar — see the slim
            header bar on the table card below. The toggle controls
            the TABLE, so it lives next to the table. */}

        {/* ─── AI filter chips row ─────────────────────────────────────
            Renders one chip per active criterion from aiCriteria. Click
            an X on any chip to remove just that criterion (table re-
            filters live). "Clear all" wipes the whole AI filter. The
            AI's parse message ("Searching for live water Kerr + Kendall
            + Comal County") sits to the right as quiet gray text — a
            human-readable receipt of what the AI heard. */}
        {(aiCriteria || aiMessage) && (() => {
          // Flatten aiCriteria into renderable chips. Arrays produce
          // one chip per entry (each removable individually); scalars
          // produce one chip (removable wipes the whole key).
          const chips: Array<{ key: string; value?: any; label: string }> = [];
          if (aiCriteria) {
            if (Array.isArray(aiCriteria.counties)) {
              for (const c of aiCriteria.counties) chips.push({ key: 'counties', value: c, label: c });
            }
            if (Array.isArray(aiCriteria.water)) {
              for (const w of aiCriteria.water) chips.push({ key: 'water', value: w, label: `${w} water` });
            }
            if (Array.isArray(aiCriteria.irrigation)) {
              for (const v of aiCriteria.irrigation) chips.push({ key: 'irrigation', value: v, label: `${v} irrigation` });
            }
            if (Array.isArray(aiCriteria.road_frontage)) {
              for (const v of aiCriteria.road_frontage) chips.push({ key: 'road_frontage', value: v, label: `${v} road` });
            }
            if (Array.isArray(aiCriteria.dev_potential)) {
              for (const v of aiCriteria.dev_potential) chips.push({ key: 'dev_potential', value: v, label: `${v} dev potential` });
            }
            if (Array.isArray(aiCriteria.best_use)) {
              for (const v of aiCriteria.best_use) chips.push({ key: 'best_use', value: v, label: v });
            }
            if (Array.isArray(aiCriteria.keywords_in_description)) {
              for (const v of aiCriteria.keywords_in_description) chips.push({ key: 'keywords_in_description', value: v, label: `"${v}"` });
            }
            if (aiCriteria.min_acres != null) chips.push({ key: 'min_acres', label: `≥ ${aiCriteria.min_acres.toLocaleString()} ac` });
            if (aiCriteria.max_acres != null) chips.push({ key: 'max_acres', label: `≤ ${aiCriteria.max_acres.toLocaleString()} ac` });
            if (aiCriteria.min_ppa != null) chips.push({ key: 'min_ppa', label: `≥ $${aiCriteria.min_ppa.toLocaleString()}/ac` });
            if (aiCriteria.max_ppa != null) chips.push({ key: 'max_ppa', label: `≤ $${aiCriteria.max_ppa.toLocaleString()}/ac` });
            if (aiCriteria.sold_after_date) chips.push({ key: 'sold_after_date', label: `sold after ${aiCriteria.sold_after_date}` });
            if (aiCriteria.sold_before_date) chips.push({ key: 'sold_before_date', label: `sold before ${aiCriteria.sold_before_date}` });
            if (aiCriteria.has_improvements === true) chips.push({ key: 'has_improvements', label: 'improved' });
            if (aiCriteria.has_improvements === false) chips.push({ key: 'has_improvements', label: 'unimproved' });
            if (aiCriteria.has_water_rights === true) chips.push({ key: 'has_water_rights', label: 'water rights' });
            if (aiCriteria.has_water_rights === false) chips.push({ key: 'has_water_rights', label: 'no water rights' });
          }
          if (chips.length === 0 && !aiMessage) return null;
          return (
            <div className="flex items-center flex-wrap gap-2 mt-3">
              {chips.length > 0 && (
                <>
                  <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2">
                    Filtering by
                  </span>
                  {chips.map((chip, idx) => (
                    <span
                      key={`${chip.key}-${chip.value ?? idx}`}
                      className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 bg-olive-tint border border-olive-border rounded-full text-[12px] font-medium text-olive-2"
                    >
                      {chip.label}
                      <button
                        type="button"
                        onClick={() => removeAiCriterion(chip.key, chip.value)}
                        title={`Remove ${chip.label}`}
                        className="p-0.5 rounded-full text-olive hover:bg-white/60 hover:text-olive-2 transition-colors"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={clearAiFilter}
                    className="text-[12px] font-medium text-ink-2 hover:text-ink underline-offset-2 hover:underline transition-colors"
                  >
                    Clear all
                  </button>
                </>
              )}
              {aiMessage && (
                <span className="text-[12px] text-ink-2 italic ml-auto">
                  {aiMessage}
                </span>
              )}
            </div>
          );
        })()}
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="flex-shrink-0 bg-white border-b border-beige px-4 py-3">
          <div className="flex flex-wrap gap-3">
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value as any })}
              className="bg-cream border border-beige rounded-lg px-3 py-1.5 text-xs text-ink outline-none focus:border-olive"
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
              className="bg-cream border border-beige rounded-lg px-3 py-1.5 text-xs text-ink outline-none focus:border-olive"
            >
              <option value="">All Water</option>
              <option value="Strong">Strong</option>
              <option value="Seasonal">Seasonal</option>
              <option value="None">None</option>
            </select>

            <select
              value={filters.visibility}
              onChange={(e) => setFilters({ ...filters, visibility: e.target.value as any })}
              className="bg-cream border border-beige rounded-lg px-3 py-1.5 text-xs text-ink outline-none focus:border-olive"
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
              className="w-28 bg-cream border border-beige rounded-lg px-3 py-1.5 text-xs text-ink outline-none focus:border-olive"
            />
            <input
              type="number"
              placeholder="Max acres"
              value={filters.max_acres}
              onChange={(e) => setFilters({ ...filters, max_acres: e.target.value })}
              className="w-28 bg-cream border border-beige rounded-lg px-3 py-1.5 text-xs text-ink outline-none focus:border-olive"
            />

            {/* "Needs Location" toggle — finds comps where lat/lng failed
                to geocode after import. Tap any in the table → opens the
                map picker so the broker can click to set the real location. */}
            <button
              onClick={() => setNeedsLocationOnly((v) => !v)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                needsLocationOnly
                  ? 'border-amber-500/60 bg-amber-50 text-amber-800'
                  : 'border-beige text-ink-2 hover:text-ink hover:border-beige-2'
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
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-blue/30 bg-slate-blue/5 text-slate-blue hover:bg-slate-blue/10 transition-colors"
              title="Find comps pinned at county centroid (wrong location) and clear their coords"
            >
              Fix Bad Pins
            </button>


            <button
              onClick={() => setFilters(defaultFilters)}
              className="px-3 py-1.5 text-xs text-ink-2 hover:text-ink border border-beige rounded-lg"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Comp list */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* ─── KPI tiles ────────────────────────────────────────────────
            4-card dashboard pattern — Total Volume, Avg $/Acre, Avg
            Acres, Recent Sales. Same convention used by Stripe / Google
            Analytics / QuickBooks. Anchors the broker with the headline
            numbers BEFORE they read any row. Each card has:
              - Tiny uppercase label (gray-500, tracking-wide)
              - Big bold number with tabular figures
              - Subtle subtitle for context
            Grid: 4 cols on desktop, 2x2 on tablet, 1-col on mobile. */}
        {stats.sold > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            {/* KPI tiles — Apple/Stripe convention. Restrained weights:
                font-medium label, font-semibold number (NOT font-bold —
                bold reads as "shouting" in big sizes). Tabular figures.
                Subtle border (gray-200/60), no shadow on rest, faint
                hover lift. Generous interior padding for premium feel. */}
            <div className="bg-white border border-beige rounded-xl p-5 transition-all hover:border-beige-2 hover:shadow-sm">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2">
                Total Volume
              </div>
              <div className="text-[28px] font-semibold text-ink tabular-nums leading-tight mt-2">
                {formatCurrency(stats.totalVolume)}
              </div>
              <div className="text-xs text-ink-2 mt-1.5 font-normal">
                across {stats.sold} {stats.sold === 1 ? 'sale' : 'sales'}
              </div>
            </div>
            <div className="bg-white border border-beige rounded-xl p-5 transition-all hover:border-beige-2 hover:shadow-sm">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2">
                Avg Price / Acre
              </div>
              <div className="text-[28px] font-semibold text-olive-2 tabular-nums leading-tight mt-2">
                {formatPPA(stats.avgPPA)}
              </div>
              <div className="text-xs text-ink-2 mt-1.5 font-normal">
                portfolio-wide average
              </div>
            </div>
            <div className="bg-white border border-beige rounded-xl p-5 transition-all hover:border-beige-2 hover:shadow-sm">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2">
                Avg Property Size
              </div>
              <div className="text-[28px] font-semibold text-ink tabular-nums leading-tight mt-2">
                {formatAcres(stats.avgAcres)}
              </div>
              <div className="text-xs text-ink-2 mt-1.5 font-normal">
                acres per sale
              </div>
            </div>
            <div className="bg-white border border-beige rounded-xl p-5 transition-all hover:border-beige-2 hover:shadow-sm">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2">
                Recent Activity
              </div>
              <div className="text-[28px] font-semibold text-ink tabular-nums leading-tight mt-2">
                {stats.recentSales}
              </div>
              <div className="text-xs text-ink-2 mt-1.5 font-normal">
                {stats.recentSales === 1 ? 'sale' : 'sales'} in last 90 days
              </div>
            </div>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-olive border-t-transparent rounded-full animate-spin" />
          </div>
        ) : comps.length === 0 ? (
          // Distinguish TWO empty states:
          //   • "No matches" — vault has comps but the current filter
          //     produced zero rows. The fix is "clear the filter," NOT
          //     "go add comps." Showing the "Add your first comp" CTA
          //     here was a false-positive — it gaslit users who DO have
          //     comps and just have an active query that excluded them.
          //   • "Truly empty" — the database query came back zero rows
          //     AND no filter / search / AI criteria is active. That's
          //     the real "go add comps" state.
          (filters.search || filters.county || filters.status || filters.water ||
            filters.min_acres || filters.max_acres || filters.visibility || aiQuery || aiCriteria) ? (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <div className="w-12 h-12 rounded-xl bg-cream border border-beige flex items-center justify-center mb-3">
                <Search size={20} className="text-ink-2" />
              </div>
              <p className="text-sm font-semibold text-ink mb-1">No matches</p>
              <p className="text-xs text-ink-2 mb-4">
                Your vault has comps, but none match the current filter.
              </p>
              <button
                onClick={() => {
                  clearAiFilter();
                  setFilters(defaultFilters);
                }}
                className="px-4 py-2 bg-white border border-beige text-xs font-semibold text-ink rounded-lg hover:border-olive transition-colors"
              >
                Clear filter
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <div className="w-12 h-12 rounded-xl bg-cream border border-beige flex items-center justify-center mb-3">
                <FileText size={20} className="text-ink-2" />
              </div>
              <p className="text-sm font-semibold text-ink mb-1">No comps yet</p>
              <p className="text-xs text-ink-2 mb-4">
                Add your first comp or import from a PDF
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowQuickCapture(true)}
                  className="px-4 py-2 bg-white border border-beige text-xs font-semibold text-ink rounded-lg hover:border-olive transition-colors"
                >
                  Quick Add
                </button>
                <button
                  onClick={() => setShowAddModal(true)}
                  className="px-4 py-2 bg-olive text-white text-xs font-semibold rounded-lg hover:bg-olive-2 transition-colors"
                >
                  Add Comp
                </button>
              </div>
            </div>
          )
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
            // Filter pipeline: AI criteria → Needs-Location filter → sort → split counties.
            //
            // AI criteria are applied client-side here (not at the DB
            // query) because they include multi-county / multi-water /
            // range matching that's awkward to translate to a single
            // Supabase query. The comp list is small enough (<1000)
            // that client-side filtering is instant.
            const splitCountiesLocal = (raw: any): string[] => String(raw ?? '')
              .split(/\s+and\s+|\s*&\s*|\s*,\s*/i)
              .map((s) => s.toLowerCase().replace(/\bcounty\b/g, '').trim())
              .filter(Boolean);
            const matchesCounty = (val: any, allowed: string[] | null | undefined) => {
              if (!allowed || allowed.length === 0) return true;
              if (val == null) return false;
              const compCounties = splitCountiesLocal(val);
              return allowed.some((a) => {
                const norm = String(a).toLowerCase().replace(/\bcounty\b/g, '').trim();
                return compCounties.includes(norm);
              });
            };
            const aiFiltered = !aiCriteria ? comps : comps.filter((c) => {
              if (!matchesCounty(c.county, aiCriteria.counties)) return false;
              if (Array.isArray(aiCriteria.water) && aiCriteria.water.length > 0) {
                if (!aiCriteria.water.includes(c.water)) return false;
              }
              if (Array.isArray(aiCriteria.irrigation) && aiCriteria.irrigation.length > 0) {
                const v = (c as any).irrigation;
                if (!v || !aiCriteria.irrigation.includes(v)) return false;
              }
              if (Array.isArray(aiCriteria.road_frontage) && aiCriteria.road_frontage.length > 0) {
                if (!aiCriteria.road_frontage.includes(c.road_frontage)) return false;
              }
              if (Array.isArray(aiCriteria.dev_potential) && aiCriteria.dev_potential.length > 0) {
                if (!aiCriteria.dev_potential.includes(c.dev_potential)) return false;
              }
              if (Array.isArray(aiCriteria.best_use) && aiCriteria.best_use.length > 0) {
                const compUses = Array.isArray((c as any).best_use) ? (c as any).best_use : [];
                if (!aiCriteria.best_use.some((u: string) => compUses.includes(u))) return false;
              }
              if (aiCriteria.has_improvements != null) {
                if (Boolean(c.has_improvements) !== Boolean(aiCriteria.has_improvements)) return false;
              }
              if (aiCriteria.has_water_rights != null) {
                if (Boolean((c as any).has_water_rights) !== Boolean(aiCriteria.has_water_rights)) return false;
              }
              if (aiCriteria.min_acres != null && (c.acres ?? 0) < aiCriteria.min_acres) return false;
              if (aiCriteria.max_acres != null && (c.acres ?? 0) > aiCriteria.max_acres) return false;
              const ppa = c.ppa_land_only || c.price_per_acre || 0;
              if (aiCriteria.min_ppa != null && ppa < aiCriteria.min_ppa) return false;
              if (aiCriteria.max_ppa != null && ppa > aiCriteria.max_ppa) return false;
              if (aiCriteria.sold_after_date && c.sale_date) {
                if (new Date(c.sale_date).getTime() < new Date(aiCriteria.sold_after_date).getTime()) return false;
              }
              if (aiCriteria.sold_before_date && c.sale_date) {
                if (new Date(c.sale_date).getTime() > new Date(aiCriteria.sold_before_date).getTime()) return false;
              }
              if (Array.isArray(aiCriteria.keywords_in_description) && aiCriteria.keywords_in_description.length > 0) {
                const desc = (c.description || '').toLowerCase();
                if (!aiCriteria.keywords_in_description.some((k: string) => desc.includes(String(k).toLowerCase()))) return false;
              }
              return true;
            });

            // Apply "Needs Location" filter on top of AI filter.
            const filtered = needsLocationOnly
              ? aiFiltered.filter((c) => c.latitude == null || c.longitude == null)
              : aiFiltered;
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

            // ─── Duplicate clusters across the WHOLE vault ─────────────
            // Scan EVERY comp, not just the needs-review subset — a comp
            // already in the verified vault can still be the duplicate
            // of a freshly-imported one. The broker needs to see both.
            // Uses the locked rule: same county + acreage ±1% + price
            // ±0.1% + (owner overlap OR no owner data) + (sale_date ±30
            // days OR no date). Dismissed pairs are sticky via
            // localStorage so we don't keep nagging.
            const duplicateClusters: DuplicateCluster[] = findDuplicateClusters(
              comps.map((c) => ({
                id: c.id,
                county: c.county,
                acres: c.acres,
                sale_price: c.sale_price,
                sale_date: c.sale_date,
                grantor: c.grantor,
                grantee: c.grantee,
              })),
              dismissedDupePairs
            );
            // Set of comp ids that appear in ANY cluster — used to
            // suppress the flat needs-review row for these comps so
            // they don't render twice (once in the cluster, once in
            // the flat list below).
            const clusteredCompIds = new Set<string>(
              duplicateClusters.flatMap((cl) => cl.ids)
            );
            // Lookup helper for cluster rendering — map id → comp.
            const compsById = new Map<string, Comp>(comps.map((c) => [c.id, c]));
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
              // Grouping is always active now (county or region) — every
              // render needs rows in county-alphabetical order so the
              // group headers can be deterministically inserted.
              return [...splitRows].sort((a, b) =>
                a._displayCounty.localeCompare(b._displayCounty) * (sortDir === 'asc' ? 1 : -1)
              );
            })();

            // ─── Group rendering — build an interleaved list of group
            // headers + comp rows. Each entry has a `kind` discriminator
            // so the table tbody can render the right component:
            //   'group-region'  → region header row (spans all cols)
            //   'group-county'  → county header row (spans all cols)
            //   'comp'          → actual comp data row
            // groupBy === 'none' produces a flat list with no headers.
            // Group headers carry TWO separate medians so the table columns
            // are summarized accurately:
            //   medianPpaTotal    — median of price_per_acre (Total $/Ac)
            //                       across ALL comps in the group
            //   medianPpaAdjusted — median of ppa_land_only (Adjusted $/Ac)
            //                       across ONLY comps that have an adjustment
            // Previously the header showed a single mixed median (adjusted
            // preferred), which made the value confusing — sometimes total,
            // sometimes adjusted, never explicit which one.
            type GroupHeaderCommon = {
              key: string;
              label: string;
              count: number;
              totalAcres: number;
              totalVolume: number;
              medianPpaTotal: number | null;
              medianPpaAdjusted: number | null;
            };
            type RegionHeaderRow = GroupHeaderCommon & { kind: 'group-region' };
            type CountyHeaderRow = GroupHeaderCommon & { kind: 'group-county' };
            type CompRowEntry = {
              kind: 'comp';
              key: string;
              row: typeof sorted[number];
            };
            type RenderRow = RegionHeaderRow | CountyHeaderRow | CompRowEntry;

            // Helpers — median of a numeric array, group stats from a
            // bag of comps. Used by both county + region grouping.
            const median = (xs: number[]): number | null => {
              const filtered = xs.filter((n) => Number.isFinite(n) && n > 0);
              if (filtered.length === 0) return null;
              filtered.sort((a, b) => a - b);
              const mid = Math.floor(filtered.length / 2);
              return filtered.length % 2 === 0
                ? (filtered[mid - 1] + filtered[mid]) / 2
                : filtered[mid];
            };
            const groupStats = (rows: typeof sorted): {
              count: number;
              totalAcres: number;
              totalVolume: number;
              medianPpaTotal: number | null;
              medianPpaAdjusted: number | null;
            } => {
              const count = rows.length;
              const totalAcres = rows.reduce((s, r) => s + (r.acres || 0), 0);
              const totalVolume = rows.reduce((s, r) => s + (r.sale_price || 0), 0);
              // Total $/Ac median uses price_per_acre across ALL rows
              const totalPpaList = rows.map((r) => r.price_per_acre || 0);
              // Adjusted $/Ac median is computed ONLY from rows that have
              // a real adjustment — skip rows where ppa_land_only is null/0
              // so the median represents actual land-only sales, not a
              // diluted mix of "adjusted" and "no adjustment available."
              const adjPpaList: number[] = [];
              for (const r of rows) {
                const v = r.ppa_land_only;
                if (typeof v === 'number' && v > 0) adjPpaList.push(v);
              }
              return {
                count,
                totalAcres,
                totalVolume,
                medianPpaTotal: median(totalPpaList),
                medianPpaAdjusted: adjPpaList.length > 0 ? median(adjPpaList) : null,
              };
            };

            const renderRows: RenderRow[] = [];

            if (groupBy === 'alphabetical') {
              // County groups, alphabetical. Aggregate stats per county.
              const byCounty = new Map<string, typeof sorted>();
              for (const r of sorted) {
                const c = r._displayCounty || '—';
                if (!byCounty.has(c)) byCounty.set(c, []);
                byCounty.get(c)!.push(r);
              }
              const counties = Array.from(byCounty.keys()).sort((a, b) =>
                a.localeCompare(b) * (sortDir === 'asc' ? 1 : -1)
              );
              for (const c of counties) {
                const rows = byCounty.get(c)!;
                const s = groupStats(rows);
                renderRows.push({
                  kind: 'group-county',
                  key: `cty-${c}`,
                  label: c,
                  count: s.count,
                  totalAcres: s.totalAcres,
                  totalVolume: s.totalVolume,
                  medianPpaTotal: s.medianPpaTotal,
                  medianPpaAdjusted: s.medianPpaAdjusted,
                });
                for (const r of rows) {
                  renderRows.push({ kind: 'comp', key: r._rowKey, row: r });
                }
              }
            } else {
              // Regional — region headers with county sub-groups inside.
              // Uses src/lib/utils/texasRegions.ts; until that map is
              // populated, every comp falls into 'Unassigned' and the
              // view collapses to a single region group (still works).
              const byRegion = new Map<string, Map<string, typeof sorted>>();
              const usedRegions = new Set<string>();
              for (const r of sorted) {
                const region = getRegionForCounty(r._displayCounty);
                usedRegions.add(region);
                if (!byRegion.has(region)) byRegion.set(region, new Map());
                const countyMap = byRegion.get(region)!;
                const c = r._displayCounty || '—';
                if (!countyMap.has(c)) countyMap.set(c, []);
                countyMap.get(c)!.push(r);
              }
              const regionOrder = getRegionsInDisplayOrder(usedRegions);
              for (const region of regionOrder) {
                const countyMap = byRegion.get(region);
                if (!countyMap) continue;
                // Region-level stats — aggregate across all comps in the region
                const allInRegion: typeof sorted = [];
                countyMap.forEach((rows) => allInRegion.push(...rows));
                const regS = groupStats(allInRegion);
                renderRows.push({
                  kind: 'group-region',
                  key: `reg-${region}`,
                  label: region,
                  count: regS.count,
                  totalAcres: regS.totalAcres,
                  totalVolume: regS.totalVolume,
                  medianPpaTotal: regS.medianPpaTotal,
                  medianPpaAdjusted: regS.medianPpaAdjusted,
                });
                // County sub-groups, alphabetical within the region
                const counties = Array.from(countyMap.keys()).sort((a, b) => a.localeCompare(b));
                for (const c of counties) {
                  const rows = countyMap.get(c)!;
                  const s = groupStats(rows);
                  renderRows.push({
                    kind: 'group-county',
                    key: `reg-${region}-cty-${c}`,
                    label: c,
                    count: s.count,
                    totalAcres: s.totalAcres,
                    totalVolume: s.totalVolume,
                    medianPpaTotal: s.medianPpaTotal,
                    medianPpaAdjusted: s.medianPpaAdjusted,
                  });
                  for (const r of rows) {
                    renderRows.push({ kind: 'comp', key: `${region}::${r._rowKey}`, row: r });
                  }
                }
              }
            }
            // Column headers: medium weight, looser tracking — feels
            // like an Excel/CoStar data tool. NOT all caps tracking-wider
            // (that's old-school); use mixed-case font-medium for that
            // calm professional vibe.
            const SortHeader = ({ k, label, align = 'left' }: { k: SortKey; label: string; align?: 'left' | 'right' | 'center' }) => (
              <th
                onClick={() => toggleSort(k)}
                className={`py-3 px-3 text-${align} text-[11px] font-medium text-ink-2 uppercase tracking-[0.06em] cursor-pointer hover:text-ink transition-colors select-none`}
              >
                <span className="inline-flex items-center gap-1">
                  {label}
                  {sortKey === k && (sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                </span>
              </th>
            );
            // Icon helper for the review section — color comes from the
            // classifyReview() icon field. Warm-toned variants match the
            // cream/olive palette (avoid pure red/amber that clash).
            const reviewIcon = (icon: ReviewReason['icon']) => {
              const cls = 'w-3.5 h-3.5';
              if (icon === 'red') return <MapPinOff className={`${cls} text-red-500`} />;
              if (icon === 'amber') return <AlertTriangle className={`${cls} text-amber-600`} />;
              if (icon === 'sky') return <ShieldQuestion className={`${cls} text-slate-blue`} />;
              return <Clock className={`${cls} text-ink-2`} />;
            };
            return (
              <>
                {/* ─── Possible duplicates section ─────────────────────
                    Renders above the needs-review section because a
                    duplicate is more actionable than a missing pin —
                    fixing duplicates often dissolves several needs-
                    review items at once (merge collapses 4 rows into 1
                    that's already cleanly located).
                    Each cluster is a group of comps that look like the
                    same transaction under the locked dedup rule
                    (county + acreage ±1% + price ±0.1% + owner overlap
                    + sale_date ±30 days, skip-missing-field). The
                    broker can merge the cluster into one canonical
                    comp, OR mark "not duplicates" — which is sticky
                    via localStorage so we don't re-suggest the pair. */}
                {duplicateClusters.length > 0 && (
                  <div className="bg-white border border-beige rounded-xl mb-4 overflow-hidden shadow-sm relative">
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-orange-500" />
                    <div className="flex items-center gap-2.5 pl-5 pr-4 py-3.5 border-b border-beige">
                      <div className="flex items-center justify-center w-6 h-6 bg-orange-100 rounded-full">
                        <AlertTriangle size={12} className="text-orange-700" />
                      </div>
                      <span className="text-sm font-semibold text-ink">
                        {duplicateClusters.length} possible duplicate {duplicateClusters.length === 1 ? 'cluster' : 'clusters'}
                      </span>
                      <span className="text-xs text-ink-2">
                        — same county, same acreage, same price (±tolerances)
                      </span>
                    </div>
                    <div className="divide-y divide-beige">
                      {duplicateClusters.map((cluster) => {
                        const members = cluster.ids
                          .map((id) => compsById.get(id))
                          .filter((c): c is Comp => Boolean(c));
                        if (members.length < 2) return null;
                        // Header line: a representative summary so the
                        // broker sees what cluster they're looking at
                        // at a glance ("234.22± ac in Gillespie · $5.30M").
                        const rep = members[0];
                        const acresText = rep.acres ? formatAcres(rep.acres) : '—';
                        const priceText = rep.sale_price ? formatCurrency(rep.sale_price) : '—';
                        const countyText = rep.county || '—';
                        return (
                          <div key={cluster.key} className="bg-orange-50/30">
                            <div className="flex items-center justify-between gap-3 pl-5 pr-4 py-2.5">
                              <div className="text-xs text-ink-2">
                                <span className="font-semibold text-ink">{members.length} rows</span>
                                {' · '}{acresText}{' · '}{countyText}{' · '}{priceText}
                              </div>
                              <button
                                onClick={() => dismissCluster(cluster.ids)}
                                className="text-[11px] text-ink-2 hover:text-ink underline-offset-2 hover:underline transition-colors"
                                title="These are NOT duplicates — never suggest this group again"
                              >
                                Not duplicates
                              </button>
                            </div>
                            {/* Mixed-cluster note — surfaces when the
                                cluster contains at least one verified
                                vault comp alongside needs-review ones.
                                Tells the broker the canonical record
                                already exists so the right action is
                                usually merge-into-vault, not "review and
                                save another copy." */}
                            {(() => {
                              const verifiedCount = members.filter(
                                (m) => classifyReview(m) === null
                              ).length;
                              const reviewCount = members.length - verifiedCount;
                              if (verifiedCount > 0 && reviewCount > 0) {
                                return (
                                  <div className="px-5 pb-2 -mt-1 text-[11px] text-ink-2 italic">
                                    Mixed cluster — {verifiedCount} verified vault comp{verifiedCount === 1 ? '' : 's'} + {reviewCount} needs review. Open a needs-review row to merge it into the verified record.
                                  </div>
                                );
                              }
                              return null;
                            })()}
                            <table className="w-full">
                              <tbody>
                                {members.map((c) => {
                                  const r = classifyReview(c);
                                  const isVerified = r === null;
                                  const compCounty = (c.county || '').split(',')[0]?.trim() || '—';
                                  // Verified comps with a pin: click → map (focused on the
                                  // property, detail panel auto-opened). After review, the
                                  // dominant job is "look it up" not "edit it." The review
                                  // page is still reachable from the map detail panel.
                                  // Anything not-yet-verified or pinless: click → review
                                  // page (edit-first, broker needs to fix something).
                                  const canJumpToMap = isVerified && c.latitude != null && c.longitude != null;
                                  const handleRowClick = () => {
                                    if (canJumpToMap) {
                                      router.push(`/dashboard/map?focus=${c.latitude},${c.longitude},14&compId=${c.id}`);
                                    } else {
                                      router.push(`/dashboard/review/${c.id}`);
                                    }
                                  };
                                  return (
                                    <tr
                                      key={c.id}
                                      onClick={handleRowClick}
                                      className={`border-t border-beige/60 hover:bg-orange-50/60 cursor-pointer transition-colors ${
                                        isVerified ? 'bg-emerald-50/40' : ''
                                      }`}
                                    >
                                      <td className="py-2.5 pl-8 w-7">
                                        {isVerified ? (
                                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                                        ) : (
                                          reviewIcon(r?.icon || 'gray')
                                        )}
                                      </td>
                                      <td className="py-2.5 px-2 text-sm text-ink font-semibold">
                                        {c.property_name || `${compCounty} comp`}
                                        {isVerified && (
                                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-800">
                                            In vault
                                          </span>
                                        )}
                                      </td>
                                      <td className="py-2.5 px-2 text-xs text-ink-2 whitespace-nowrap">
                                        {c.county || '—'} {c.acres ? `· ${formatAcres(c.acres)}` : ''}
                                      </td>
                                      <td className="py-2.5 px-2 text-xs text-ink/80 whitespace-nowrap">
                                        {c.sale_price ? formatCurrency(c.sale_price) : '—'}
                                        {' · '}
                                        {c.sale_date || 'no date'}
                                      </td>
                                      <td className="py-2.5 px-3 text-right whitespace-nowrap w-px">
                                        {/* Verified rows get a muted
                                            delete affordance so brokers
                                            don't nuke their canonical
                                            record while triaging dupes. */}
                                        <div className={isVerified ? 'opacity-30 hover:opacity-100 transition-opacity' : ''}>
                                        <DeleteConfirmButton
                                          variant="icon"
                                          title={isVerified ? 'Delete (verified vault comp)' : 'Delete this comp'}
                                          onConfirm={() => handleDeleteComp(c.id)}
                                        />
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ─── Needs review section (collapsible) ──────────────
                    Surfaces comps that need attention — no pin, math
                    issues, low confidence — above the main vault list so
                    they don't get lost in a long-scroll. Sorted newest
                    first so the most recent imports route to triage
                    immediately. Click any row to open the per-comp
                    review page. Rows that ALSO appear in a duplicate
                    cluster (above) are suppressed here to avoid showing
                    the same comp twice on the page. */}
                {(() => {
                  // Count only review comps NOT already shown in the
                  // duplicate clusters section above, so the header
                  // ("X properties need review") matches what the
                  // broker actually sees in this list.
                  const visibleReviewCount = reviewComps.filter(
                    (c) => !clusteredCompIds.has(c.id)
                  ).length;
                  if (visibleReviewCount === 0) return null;
                  return (
                  <div className="bg-white border border-beige rounded-xl mb-4 overflow-hidden shadow-sm relative">
                    {/* Amber left-edge accent — semantic alert color.
                        Slightly desaturated to fit the warm palette. */}
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber-600" />
                    <button
                      onClick={() => setNeedsReviewOpen((v) => !v)}
                      className="w-full flex items-center justify-between pl-5 pr-4 py-3.5 hover:bg-amber-50/40 transition-colors"
                      aria-expanded={needsReviewOpen}
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="flex items-center justify-center w-6 h-6 bg-amber-100 rounded-full">
                          <AlertTriangle size={12} className="text-amber-700" />
                        </div>
                        <span className="text-sm font-semibold text-ink">
                          {visibleReviewCount} {visibleReviewCount === 1 ? 'property needs' : 'properties need'} review
                        </span>
                        <span className="text-xs text-ink-2">— click any row to fix</span>
                      </div>
                      {needsReviewOpen ? <ChevronUp size={16} className="text-ink-2" /> : <ChevronDown size={16} className="text-ink-2" />}
                    </button>
                    {needsReviewOpen && (
                      <div className="border-t border-beige">
                        <table className="w-full">
                          <tbody>
                            {reviewComps.map((c) => {
                              const r = classifyReview(c);
                              if (!r) return null;
                              // Suppress rows that already appear in
                              // the duplicate cluster section above —
                              // showing the same comp twice on one page
                              // is noise.
                              if (clusteredCompIds.has(c.id)) return null;
                              const compCounty = (c.county || '').split(',')[0]?.trim() || '—';
                              return (
                                <tr
                                  key={c.id}
                                  onClick={() => router.push(`/dashboard/review/${c.id}`)}
                                  className="border-b border-beige last:border-b-0 hover:bg-amber-50/60 cursor-pointer transition-colors"
                                >
                                  <td className="py-2.5 px-4 w-7">
                                    {reviewIcon(r.icon)}
                                  </td>
                                  <td className="py-2.5 px-2 text-sm text-ink font-semibold">
                                    {c.property_name || `${compCounty} comp`}
                                  </td>
                                  <td className="py-2.5 px-2 text-xs text-ink-2 whitespace-nowrap">
                                    {c.county || '—'} {c.acres ? `· ${formatAcres(c.acres)}` : ''}
                                  </td>
                                  <td className="py-2.5 px-2 text-xs text-ink/80 whitespace-nowrap">
                                    {r.label}
                                  </td>
                                  <td className="py-2.5 px-2 text-right text-[10px] text-ink-2 whitespace-nowrap">
                                    {c.created_at ? new Date(c.created_at).toLocaleDateString() : ''}
                                  </td>
                                  {/* Delete affordance — 2-step confirm so brokers
                                      can't nuke a comp by accident while scanning
                                      this list. stopPropagation is baked into
                                      DeleteConfirmButton so the row's onClick
                                      (which navigates to /review/[id]) doesn't fire. */}
                                  <td className="py-2.5 px-3 text-right whitespace-nowrap w-px">
                                    <DeleteConfirmButton
                                      variant="icon"
                                      title="Delete this comp"
                                      onConfirm={() => handleDeleteComp(c.id)}
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  );
                })()}

              <div className="bg-white border border-beige rounded-xl overflow-hidden shadow-sm">
                {/* Table-card header bar — slim row above the column
                    headers. LEFT: County | Region toggle (the primary
                    control, placed where the eye lands first, directly
                    above the County column it controls). RIGHT: calm
                    summary stats giving glanceable shape ("7 counties
                    · 34 properties"). */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-beige bg-cream/30">
                  {/* LEFT — toggle pill. Active state: white bg + olive
                      border, matches the Lump Sum / Land + Improvements
                      toggle pattern from the CMA Opinion of Value
                      section for consistency across the app. */}
                  <div className="inline-flex bg-white border border-beige rounded-lg p-0.5">
                    {([
                      { key: 'alphabetical' as const, label: 'County' },
                      { key: 'regional' as const, label: 'Region' },
                    ]).map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => setGroupBy(key)}
                        className={`px-3 py-1 rounded-md text-[11px] font-semibold transition-all ${
                          groupBy === key
                            ? 'bg-white text-ink shadow-sm border border-beige-2'
                            : 'text-ink-2 hover:text-ink'
                        }`}
                        title={
                          key === 'alphabetical'
                            ? 'Group by county, alphabetical (Atascosa → Wilson)'
                            : 'Group by region (Hill Country / South Texas / …), counties sub-grouped'
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* RIGHT — summary stats. In County mode: counties +
                      properties. In Region mode: also include region
                      count. Computed from the renderRows array since
                      that's already grouped + deduped. */}
                  {(() => {
                    const countyCount = renderRows.filter((r) => r.kind === 'group-county').length;
                    const regionCount = renderRows.filter((r) => r.kind === 'group-region').length;
                    const compCount = renderRows.filter((r) => r.kind === 'comp').length;
                    const parts: string[] = [];
                    if (groupBy === 'regional' && regionCount > 0) {
                      parts.push(`${regionCount} ${regionCount === 1 ? 'region' : 'regions'}`);
                    }
                    parts.push(`${countyCount} ${countyCount === 1 ? 'county' : 'counties'}`);
                    parts.push(`${compCount} ${compCount === 1 ? 'property' : 'properties'}`);
                    return (
                      <span className="text-[11px] text-ink-3 font-mono tabular-nums">
                        {parts.join(' · ')}
                      </span>
                    );
                  })()}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-cream/60 border-b border-beige sticky top-0 z-10">
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
                      {renderRows.map((entry) => {
                        // ─── Region header ────────────────────────────
                        // Full-width banner since regions are macro
                        // groupings — using individual cells would make
                        // the region name look tiny next to the column
                        // grid. Aggregate totals are STILL aligned with
                        // their columns via right-flush positioning that
                        // visually lines up with TOTAL PRICE / PER ACRE.
                        if (entry.kind === 'group-region') {
                          return (
                            <tr key={entry.key} className="bg-cream/80 border-t-2 border-beige-2 first:border-t-0">
                              {/* County column → region name (e.g. "Hill Country") */}
                              <td className="py-3 px-3">
                                <span className="text-[13px] font-semibold text-ink">
                                  {entry.label}
                                </span>
                              </td>
                              {/* City column → "Totals · N" semantic label in bold */}
                              <td className="py-3 px-3">
                                <span className="text-[12px] font-bold text-ink">
                                  Totals
                                </span>
                                <span className="text-[11px] text-ink-3 font-mono tabular-nums ml-1.5">
                                  · {entry.count}
                                </span>
                              </td>
                              {/* Acres column — total acres across region */}
                              <td className="px-3 py-3 text-right">
                                {entry.totalAcres > 0 && (
                                  <span className="text-[12px] font-semibold text-ink font-mono tabular-nums">
                                    {formatAcres(entry.totalAcres)}
                                  </span>
                                )}
                              </td>
                              {/* Total Price column */}
                              <td className="px-3 py-3 text-right">
                                {entry.totalVolume > 0 && (
                                  <span className="text-[12px] font-semibold text-ink font-mono tabular-nums">
                                    {formatCurrency(entry.totalVolume)}
                                  </span>
                                )}
                              </td>
                              {/* Per Acre column — median of price_per_acre
                                  across all comps in the region (olive) */}
                              <td className="px-3 py-3 text-right">
                                {entry.medianPpaTotal != null && (
                                  <span className="text-[12px] font-semibold text-olive-2 font-mono tabular-nums">
                                    {formatPPA(entry.medianPpaTotal)}
                                  </span>
                                )}
                              </td>
                              {/* Adjusted column — median of ppa_land_only
                                  across only comps with an adjustment.
                                  Empty when no comp in the region has
                                  an adjustment so the column isn't noisy. */}
                              <td className="px-3 py-3 text-right">
                                {entry.medianPpaAdjusted != null && (
                                  <span className="text-[12px] font-semibold text-amber-800 font-mono tabular-nums">
                                    {formatPPA(entry.medianPpaAdjusted)}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-3" />
                              <td className="w-16" />
                            </tr>
                          );
                        }
                        // ─── County header ────────────────────────────
                        // Aligns aggregate values with the columns they
                        // represent so the broker can mentally tie the
                        // header values back to the data column they're
                        // summarizing. County name in col 1; total in
                        // Total Price column; median $/ac in Per Acre
                        // column. Other columns left blank.
                        if (entry.kind === 'group-county') {
                          const isNested = groupBy === 'regional';
                          return (
                            <tr key={entry.key} className={`${isNested ? 'bg-cream/40' : 'bg-cream/60'} border-t border-beige`}>
                              {/* County column → county name (matches comp rows
                                  below so the eye reads consistently) */}
                              <td className={`py-2 ${isNested ? 'pl-8 pr-3' : 'px-3'}`}>
                                <span className="text-[12px] font-semibold text-ink">
                                  {entry.label}
                                </span>
                              </td>
                              {/* City column → "Totals · N" semantic label,
                                  bold so the eye reads "this row is the
                                  totals row, not a specific comp." */}
                              <td className="py-2 px-3">
                                <span className="text-[12px] font-bold text-ink">
                                  Totals
                                </span>
                                <span className="text-[11px] text-ink-3 font-mono tabular-nums ml-1.5">
                                  · {entry.count}
                                </span>
                              </td>
                              {/* Acres column — total acres across county */}
                              <td className="px-3 py-2 text-right">
                                {entry.totalAcres > 0 && (
                                  <span className="text-[11px] font-semibold text-ink font-mono tabular-nums">
                                    {formatAcres(entry.totalAcres)}
                                  </span>
                                )}
                              </td>
                              {/* Total Price column */}
                              <td className="px-3 py-2 text-right">
                                {entry.totalVolume > 0 && (
                                  <span className="text-[11px] font-semibold text-ink font-mono tabular-nums">
                                    {formatCurrency(entry.totalVolume)}
                                  </span>
                                )}
                              </td>
                              {/* Per Acre column — median of price_per_acre
                                  across all comps in the county (olive) */}
                              <td className="px-3 py-2 text-right">
                                {entry.medianPpaTotal != null && (
                                  <span className="text-[11px] font-semibold text-olive-2 font-mono tabular-nums">
                                    {formatPPA(entry.medianPpaTotal)}
                                  </span>
                                )}
                              </td>
                              {/* Adjusted column — median of ppa_land_only
                                  across only comps with an adjustment.
                                  Amber-toned to match the comp row's
                                  adjusted value styling. */}
                              <td className="px-3 py-2 text-right">
                                {entry.medianPpaAdjusted != null && (
                                  <span className="text-[11px] font-semibold text-amber-800 font-mono tabular-nums">
                                    {formatPPA(entry.medianPpaAdjusted)}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2" />
                              <td className="w-16" />
                            </tr>
                          );
                        }
                        // Comp row — same rendering as before
                        const comp = entry.row;
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
                            key={entry.key}
                            onClick={() => {
                              setEditingComp(comp);
                              setShowAddModal(true);
                            }}
                            className="border-b border-beige/60 last:border-b-0 hover:bg-cream/60 cursor-pointer group transition-colors"
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
                              <div className="text-sm font-semibold text-ink flex items-center gap-1.5">
                                {(comp.latitude == null || comp.longitude == null) && (
                                  <span
                                    title="No map location set. Open this comp to place a pin manually via the location picker."
                                    className="inline-flex items-center"
                                  >
                                    <MapPinOff className="w-3.5 h-3.5 text-red-500" />
                                  </span>
                                )}
                                {(comp as any).needs_extraction_review && (
                                  <span
                                    title="Check per-acre math: Acres × $/Ac doesn't equal the sale price. Compare these three numbers with the source document — one of them is likely off."
                                    className="inline-flex items-center"
                                  >
                                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                                  </span>
                                )}
                                {(comp as any).needs_location_review
                                  && comp.latitude != null
                                  && comp.longitude != null && (
                                  <span
                                    title="Location wasn't visually verified at import. Open this comp to confirm the pin is on the correct parcel."
                                    className="inline-flex items-center"
                                  >
                                    <Clock className="w-3.5 h-3.5 text-ink-2" />
                                  </span>
                                )}
                                <span>{displayCounty}</span>
                                {alsoIn.length > 0 && (
                                  <span
                                    className="text-[9px] uppercase tracking-wide text-ink-2 bg-cream border border-beige rounded px-1 py-px"
                                    title={`This comp spans multiple counties. Also in: ${alsoIn.join(', ')}`}
                                  >
                                    +{alsoIn.length}
                                  </span>
                                )}
                              </div>
                              {comp.property_name && (
                                <div className="text-[10px] text-ink-2 truncate max-w-[180px]">
                                  {comp.property_name}
                                </div>
                              )}
                              {alsoIn.length > 0 && (
                                <div className="text-[9px] text-ink-3 mt-0.5">
                                  Also in {alsoIn.join(', ')}
                                </div>
                              )}
                            </td>
                            {/* City */}
                            <td className="py-3.5 px-3 text-sm text-ink/80">
                              {city || <span className="text-ink-3">—</span>}
                              {comp.state && city && (
                                <span className="text-[10px] text-ink-3 ml-1">{comp.state}</span>
                              )}
                            </td>
                            {/* Acres */}
                            <td className="py-3.5 px-3 text-right text-sm font-mono tabular-nums text-ink">
                              {formatAcres(comp.acres)}
                            </td>
                            {/* Total Price */}
                            <td className="py-3.5 px-3 text-right text-sm font-mono tabular-nums text-ink font-semibold">
                              {formatCurrency(comp.sale_price)}
                            </td>
                            {/* Total Per Acre — olive (primary accent for headline financial metric) */}
                            <td className="py-3.5 px-3 text-right text-sm font-mono tabular-nums text-olive-2 font-semibold">
                              {totalPpa > 0 ? formatPPA(totalPpa) : '—'}
                            </td>
                            {/* Adjusted Per Acre — amber for the "land only" adjustment story */}
                            <td className={`py-3.5 px-3 text-right text-sm font-mono tabular-nums font-semibold ${hasAdjustment ? 'text-amber-700' : 'text-ink-3'}`}>
                              {hasAdjustment ? formatPPA(adjustedPpa) : '—'}
                            </td>
                            {/* Improved badge — slate-blue pill (secondary accent, distinct from olive) */}
                            <td className="py-3.5 px-3 text-center">
                              {comp.has_improvements ? (
                                <span className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 bg-slate-blue/10 text-slate-blue-2 border border-slate-blue/20 rounded-full">
                                  Improved
                                </span>
                              ) : (
                                <span className="text-ink-3">—</span>
                              )}
                            </td>
                            {/* Row actions — Edit hides until hover (low
                                priority, visual noise otherwise). Delete is
                                ALWAYS visible (subtle text-ink-3 idle state)
                                because: (a) destructive controls shouldn't be
                                hidden behind hover, and (b) the 2-step confirm
                                pill needs to persist even if the user hovers
                                off the row mid-confirmation. */}
                            <td className="py-2.5 px-3 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingComp(comp);
                                    setShowAddModal(true);
                                  }}
                                  title="Edit"
                                  className="p-1 rounded text-ink-2 hover:text-ink hover:bg-cream opacity-0 group-hover:opacity-100 transition-opacity"
                                >
                                  <Edit size={12} />
                                </button>
                                {/* 2-step delete: click trash → "Confirm
                                    delete?" red pill → click again to commit.
                                    Auto-reverts after 5s or on outside click /
                                    Escape. Persists regardless of row hover. */}
                                <DeleteConfirmButton
                                  variant="icon"
                                  title="Delete this comp"
                                  onConfirm={() => handleDeleteComp(comp.id)}
                                  className="opacity-50 group-hover:opacity-100"
                                />
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

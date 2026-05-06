'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Comp, CompFilters } from '@/types';
import { Search, Filter, Grid, List, SlidersHorizontal, Plus, FileText } from 'lucide-react';
import CompCard from '@/components/comp/CompCard';
import CompModal from '@/components/comp/CompModal';
import QuickCapture from '@/components/comp/QuickCapture';
import { useSearchParams } from 'next/navigation';
import { formatPPA, formatAcres, formatCurrency } from '@/lib/utils';
import toast from 'react-hot-toast';

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
        ) : (
          <div className={viewMode === 'grid'
            ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3'
            : 'space-y-2'
          }>
            {comps.map((comp) => (
              <CompCard
                key={comp.id}
                comp={comp}
                onEdit={() => {
                  setEditingComp(comp);
                  setShowAddModal(true);
                }}
                onDelete={() => handleDeleteComp(comp.id)}
                viewMode={viewMode}
              />
            ))}
          </div>
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

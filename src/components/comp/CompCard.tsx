'use client';

import { Comp } from '@/types';
import { formatCurrency, formatPPA, formatAcres, formatDate } from '@/lib/utils';
import { MapPin, Lock, Users, Globe, Edit, Trash2, ChevronRight } from 'lucide-react';
import { useState } from 'react';

interface CompCardProps {
  comp: Comp;
  onEdit: () => void;
  onDelete: () => void;
  viewMode: 'grid' | 'list';
  isSelected?: boolean;
  onSelect?: () => void;
}

const statusColors: Record<string, string> = {
  Sold: 'bg-emerald-400/10 text-emerald-400',
  Active: 'bg-blue-400/10 text-blue-400',
  Pending: 'bg-amber-50 text-amber-600',
  Withdrawn: 'bg-red-400/10 text-red-500',
};

export default function CompCard({ comp, onEdit, onDelete, viewMode, isSelected, onSelect }: CompCardProps) {
  const [showMenu, setShowMenu] = useState(false);

  const displayPPA = comp.use_land_only_for_cma && comp.ppa_land_only
    ? comp.ppa_land_only
    : comp.price_per_acre;

  const VisibilityIcon = comp.visibility === 'private' ? Lock :
    comp.visibility === 'team' ? Users : Globe;

  if (viewMode === 'list') {
    return (
      <div
        className={`flex items-center gap-3 bg-cream border rounded-xl p-3 transition-all group hover:border-olive-border ${
          isSelected ? 'border-olive bg-olive-tint' : 'border-[#1f2d3d]'
        } ${onSelect ? 'cursor-pointer' : ''}`}
        onClick={onSelect}
      >
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
          comp.status === 'Sold' ? 'bg-emerald-400' :
          comp.status === 'Active' ? 'bg-blue-400' :
          comp.status === 'Pending' ? 'bg-amber-400' : 'bg-slate-500'
        }`} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-ink truncate">
              {comp.property_name || `${comp.county} County`}
            </span>
            {comp.is_draft && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 bg-amber-50 text-amber-600 rounded">DRAFT</span>
            )}
            {comp.has_improvements && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 bg-purple-400/10 text-purple-400 rounded">IMPROVED</span>
            )}
            {(comp as any).irrigation === 'Strong' && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 bg-purple-400/10 text-purple-400 rounded">IRRIGATION</span>
            )}
            {comp.improvement_source === 'agent_verified' && (
              <span
                className="text-[9px] font-bold px-1.5 py-0.5 bg-emerald-400/10 border border-emerald-400/30 text-emerald-300 rounded"
                title="An agent involved in this transaction verified the improvement value."
              >
                AGENT-VERIFIED
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-xs text-ink-3 flex items-center gap-1">
              <MapPin size={9} />{comp.county}, {comp.state}
            </span>
            <span className="text-xs text-ink-3 font-mono">{formatAcres(comp.acres)}</span>
            {comp.sale_date && (
              <span className="text-xs text-ink-3">{formatDate(comp.sale_date)}</span>
            )}
          </div>
        </div>

        <div className="text-right flex-shrink-0">
          <div className="text-sm font-bold text-emerald-400 font-mono">
            {formatPPA(displayPPA || 0)}
          </div>
          <div className="text-xs text-ink-3 font-mono">
            {formatCurrency(comp.sale_price)}
          </div>
        </div>

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="p-1.5 rounded-lg hover:bg-white/5 text-ink-2 hover:text-ink transition-colors"
          >
            <Edit size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1.5 rounded-lg hover:bg-red-400/10 text-ink-2 hover:text-red-500 transition-colors"
          >
            <Trash2 size={13} />
          </button>
        </div>

        <VisibilityIcon size={10} className="text-ink-3 flex-shrink-0" />
      </div>
    );
  }

  // Grid view
  return (
    <div
      className={`bg-cream border rounded-xl p-4 transition-all hover:border-olive-border ${
        isSelected ? 'border-olive bg-olive-tint' : 'border-[#1f2d3d]'
      } ${onSelect ? 'cursor-pointer' : ''}`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between mb-3">
        <span className={`text-xs font-bold px-2 py-0.5 rounded ${statusColors[comp.status]}`}>
          {comp.status}
        </span>
        <div className="flex items-center gap-1">
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="p-1 rounded hover:bg-white/5 text-ink-3 hover:text-ink">
            <Edit size={12} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1 rounded hover:bg-red-400/10 text-ink-3 hover:text-red-500">
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      <h3 className="font-bold text-ink text-sm mb-1 truncate">
        {comp.property_name || `${comp.county} County Ranch`}
      </h3>

      <div className="flex items-center gap-1 text-xs text-ink-3 mb-3">
        <MapPin size={10} />
        <span>{comp.county}, {comp.state}</span>
        <span className="mx-1">·</span>
        <span className="font-mono">{formatAcres(comp.acres)}</span>
      </div>

      <div className="flex items-end justify-between">
        <div>
          <div className="text-lg font-bold text-emerald-400 font-mono leading-none">
            {formatPPA(displayPPA || 0)}
          </div>
          <div className="text-xs text-ink-3 font-mono mt-0.5">
            {formatCurrency(comp.sale_price)}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {comp.water === 'Strong' && <span className="text-blue-400 text-xs">💧</span>}
          {comp.has_improvements && <span className="text-xs text-purple-400">🏠</span>}
          <VisibilityIcon size={10} className="text-ink-3" />
        </div>
      </div>
    </div>
  );
}

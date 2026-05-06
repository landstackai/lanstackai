'use client';

import { useState, useCallback } from 'react';
import { X, Plus, Map, Check, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { formatAcres } from '@/lib/utils';

export interface ParcelFeature {
  parcel_id: string;
  owner_name: string | null;
  acres: number | null;
  address: string | null;
  county: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
  geometry: any; // GeoJSON polygon
}

interface ParcelBottomSheetProps {
  parcel: ParcelFeature;
  selectedParcels: ParcelFeature[];
  mode: 'single' | 'selecting';
  onCreateBoundary: (parcels: ParcelFeature[]) => void;
  onSelectMore: () => void;
  onAddParcel: (parcel: ParcelFeature) => void;
  onRemoveParcel: (parcelId: string) => void;
  onCancel: () => void;
}

export function ParcelBottomSheet({
  parcel,
  selectedParcels,
  mode,
  onCreateBoundary,
  onSelectMore,
  onAddParcel,
  onRemoveParcel,
  onCancel,
}: ParcelBottomSheetProps) {
  const [expanded, setExpanded] = useState(false);
  const isSelected = selectedParcels.some(p => p.parcel_id === parcel.parcel_id);
  const totalAcres = selectedParcels.reduce((sum, p) => sum + (p.acres || 0), 0);

  if (mode === 'selecting') {
    return (
      <div className="fixed bottom-0 left-0 right-0 md:left-auto md:right-4 md:bottom-4 md:w-80 z-50 animate-slide-up">
        <div className="bg-panel border border-border md:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden">
          {/* Drag handle */}
          <div className="flex justify-center pt-2 pb-1 md:hidden">
            <div className="w-10 h-1 rounded-full bg-border" />
          </div>

          {/* Header */}
          <div className="px-4 py-3 border-b border-border">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-bold text-sm text-white">Selecting Parcels</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Tap parcels on the map to add them
                </p>
              </div>
              <button onClick={onCancel} className="text-slate-500 hover:text-white transition-colors">
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Selected parcel list */}
          <div className="px-4 py-3 space-y-2 max-h-48 overflow-y-auto">
            {selectedParcels.map((p, i) => (
              <div key={p.parcel_id} className="flex items-center justify-between bg-card border border-border rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className="w-5 h-5 rounded-full bg-sage/10 border border-sage/30 flex items-center justify-center flex-shrink-0">
                    <span className="text-sage text-[9px] font-bold">{i + 1}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-white truncate">
                      {p.owner_name || 'Unknown Owner'}
                    </p>
                    <p className="text-[10px] text-slate-500 font-mono">
                      {p.acres ? formatAcres(p.acres) : '—'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => onRemoveParcel(p.parcel_id)}
                  className="text-slate-500 hover:text-red-400 transition-colors flex-shrink-0 ml-2"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}

            {selectedParcels.length === 0 && (
              <p className="text-xs text-slate-500 text-center py-2">
                No parcels selected yet — tap parcels on the map
              </p>
            )}
          </div>

          {/* Total */}
          {selectedParcels.length > 0 && (
            <div className="px-4 py-2 border-t border-border bg-sage/5">
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-slate-400">
                  {selectedParcels.length} parcels selected
                </span>
                <span className="text-sm font-bold text-sage font-mono">
                  {formatAcres(totalAcres)} total
                </span>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="px-4 py-3 flex gap-2">
            <button
              onClick={onCancel}
              className="flex-1 py-2.5 border border-border rounded-xl text-xs font-bold text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onCreateBoundary(selectedParcels)}
              disabled={selectedParcels.length === 0}
              className="flex-1 py-2.5 bg-sage hover:bg-sage2 text-black rounded-xl text-xs font-bold transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5"
            >
              <Map size={13} />
              Create Boundary
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Single parcel mode (first tap)
  return (
    <div className="fixed bottom-0 left-0 right-0 md:left-auto md:right-4 md:bottom-4 md:w-80 z-50 animate-slide-up">
      <div className="bg-panel border border-border md:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden">
        {/* Drag handle mobile */}
        <div className="flex justify-center pt-2 pb-1 md:hidden">
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>

        {/* Parcel header */}
        <div className="px-4 pt-3 pb-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-base text-white leading-tight truncate">
                {parcel.owner_name || 'Unknown Owner'}
              </h3>
              {parcel.address && (
                <p className="text-xs text-slate-400 mt-0.5 truncate">{parcel.address}</p>
              )}
              {parcel.acres && (
                <p className="text-sm font-bold text-sage font-mono mt-1">
                  {formatAcres(parcel.acres)}
                </p>
              )}
            </div>
            <button onClick={onCancel} className="text-slate-500 hover:text-white transition-colors flex-shrink-0 mt-0.5">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Two main action buttons — exactly like LandID */}
        <div className="px-4 py-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => onCreateBoundary([parcel])}
            className="flex items-center justify-center gap-2 py-3 bg-card border border-border hover:border-sage rounded-xl text-xs font-bold text-white hover:text-sage transition-all"
          >
            <Map size={14} />
            <span>Create Map<br />Boundary</span>
          </button>
          <button
            onClick={() => {
              onAddParcel(parcel);
              onSelectMore();
            }}
            className="flex items-center justify-center gap-2 py-3 bg-card border border-border hover:border-sage rounded-xl text-xs font-bold text-white hover:text-sage transition-all"
          >
            <Plus size={14} />
            <span>Select More<br />Parcels</span>
          </button>
        </div>

        {/* Owner info */}
        <div className="px-4 pb-3 space-y-2 border-t border-border pt-3">
          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Owner Information</p>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-sage/10 flex items-center justify-center flex-shrink-0">
              <span className="text-sage text-xs">👤</span>
            </div>
            <span className="text-sm font-semibold text-white">{parcel.owner_name || 'Unknown'}</span>
          </div>
          {parcel.address && (
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-blue-400/10 flex items-center justify-center flex-shrink-0">
                <span className="text-blue-400 text-xs">📬</span>
              </div>
              <span className="text-xs text-slate-400">{parcel.address}</span>
            </div>
          )}

          {/* Parcel info */}
          {parcel.parcel_id && (
            <div className="mt-2 bg-card border border-border rounded-lg px-3 py-2">
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1">Parcel ID</p>
              <p className="text-xs font-mono text-slate-300">{parcel.parcel_id}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Boundary created confirmation sheet
interface BoundaryCreatedSheetProps {
  parcels: ParcelFeature[];
  totalAcres: number;
  onAddAsNewComp: () => void;
  onAttachToComp: () => void;
  onSaveBoundaryOnly: () => void;
  onClose: () => void;
}

export function BoundaryCreatedSheet({
  parcels,
  totalAcres,
  onAddAsNewComp,
  onAttachToComp,
  onSaveBoundaryOnly,
  onClose,
}: BoundaryCreatedSheetProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 md:left-auto md:right-4 md:bottom-4 md:w-80 z-50 animate-slide-up">
      <div className="bg-panel border border-border md:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden">
        <div className="flex justify-center pt-2 pb-1 md:hidden">
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>

        {/* Success header */}
        <div className="px-4 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-sage/10 border border-sage/20 flex items-center justify-center">
              <Check size={18} className="text-sage" />
            </div>
            <div>
              <p className="font-bold text-white">Boundary Created</p>
              <p className="text-xs text-slate-400 mt-0.5">
                {parcels.length} parcel{parcels.length > 1 ? 's' : ''} · {formatAcres(totalAcres)}
              </p>
            </div>
          </div>
        </div>

        {/* Action options */}
        <div className="px-4 py-3 space-y-2">
          <button
            onClick={onAddAsNewComp}
            className="w-full py-3 bg-sage hover:bg-sage2 text-black rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2"
          >
            <Plus size={15} />
            Add as New Comp
          </button>
          <button
            onClick={onAttachToComp}
            className="w-full py-3 bg-card border border-border hover:border-sage text-white rounded-xl text-sm font-bold transition-colors"
          >
            📎 Attach to Existing Comp
          </button>
          <button
            onClick={onSaveBoundaryOnly}
            className="w-full py-2.5 text-xs text-slate-400 hover:text-white transition-colors"
          >
            💾 Save Boundary Only
          </button>
        </div>

        <div className="px-4 pb-3">
          <button onClick={onClose} className="w-full text-xs text-slate-600 hover:text-slate-400 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

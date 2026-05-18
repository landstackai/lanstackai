'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { TEXAS_COUNTIES } from '@/lib/utils';
import { normalizeCountyForStorage } from '@/lib/utils/normalizeCounty';
import { X, Zap } from 'lucide-react';
import toast from 'react-hot-toast';

interface QuickCaptureProps {
  onClose: () => void;
  onSave: () => void;
}

export default function QuickCapture({ onClose, onSave }: QuickCaptureProps) {
  const [county, setCounty] = useState('');
  const [acres, setAcres] = useState('');
  const [price, setPrice] = useState('');
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const ppa = acres && price
    ? (parseFloat(price.replace(/[^0-9.]/g, '')) / parseFloat(acres)).toFixed(0)
    : null;

  const handleSave = async () => {
    if (!county || !acres || !price) {
      toast.error('County, acres, and price are required');
      return;
    }

    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const priceNum = parseFloat(price.replace(/[^0-9.]/g, ''));
    const acresNum = parseFloat(acres);

    const { error } = await supabase.from('comps').insert({
      created_by: user.id,
      // Normalize to canonical storage form so QuickCapture entries
      // match the same county-name convention as imports and full
      // CompModal saves.
      county: normalizeCountyForStorage(county) || county,
      state: 'TX',
      acres: acresNum,
      sale_price: priceNum,
      status: 'Sold',
      visibility: 'team',
      confidence: 'Unverified',
      is_draft: true,
    });

    if (error) {
      toast.error('Failed to save comp');
      setLoading(false);
    } else {
      onSave();
    }
  };

  const formatPrice = (value: string) => {
    const num = value.replace(/[^0-9]/g, '');
    if (!num) return '';
    return parseInt(num).toLocaleString();
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end md:items-center justify-center p-4">
      <div className="w-full max-w-sm bg-panel border border-border rounded-2xl overflow-hidden animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-sage/10 flex items-center justify-center">
              <Zap size={12} className="text-sage" />
            </div>
            <span className="font-bold text-sm">Quick Capture</span>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* County */}
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">
              County *
            </label>
            <input
              list="counties"
              value={county}
              onChange={(e) => setCounty(e.target.value)}
              placeholder="Real"
              className="w-full bg-card border border-border rounded-lg px-3 py-3 text-base text-white placeholder-slate-500 outline-none focus:border-sage transition-colors"
              autoFocus
            />
            <datalist id="counties">
              {TEXAS_COUNTIES.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>

          {/* Acres */}
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">
              Acres *
            </label>
            <input
              type="number"
              value={acres}
              onChange={(e) => setAcres(e.target.value)}
              placeholder="455"
              inputMode="decimal"
              className="w-full bg-card border border-border rounded-lg px-3 py-3 text-base text-white placeholder-slate-500 outline-none focus:border-sage transition-colors font-mono"
            />
          </div>

          {/* Price */}
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">
              Sale Price *
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
              <input
                type="text"
                value={price}
                onChange={(e) => setPrice(formatPrice(e.target.value))}
                placeholder="3,145,855"
                inputMode="numeric"
                className="w-full bg-card border border-border rounded-lg pl-7 pr-3 py-3 text-base text-white placeholder-slate-500 outline-none focus:border-sage transition-colors font-mono"
              />
            </div>
          </div>

          {/* Live PPA */}
          {ppa && (
            <div className="bg-sage/5 border border-sage/20 rounded-lg px-3 py-2 flex items-center justify-between">
              <span className="text-xs text-slate-400">Price per acre</span>
              <span className="text-sage font-bold font-mono text-sm">
                ${parseInt(ppa).toLocaleString()}/ac
              </span>
            </div>
          )}

          <p className="text-xs text-slate-600">
            ⚡ Saved as draft — complete the details later
          </p>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              className="flex-1 py-3 border border-border rounded-lg text-sm font-bold text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={loading || !county || !acres || !price}
              className="flex-1 py-3 bg-sage hover:bg-sage2 text-black rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
            >
              {loading ? 'Saving...' : 'Save Comp'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { CMA } from '@/types';
import { formatCurrency, formatAcres } from '@/lib/utils';
import { FileText, Plus, MapPin, Trash2, Share2, AlertCircle, Eye, Users } from 'lucide-react';
import toast from 'react-hot-toast';

type CMARow = CMA & {
  id: string;
  subject_name: string;
  subject_county: string;
  subject_state: string;
  subject_acres: number;
  selected_comp_ids: string[] | null;
  comp_adjustments: Record<string, { improvement_value?: number | null; improvement_source?: 'appraiser' | 'agent_verified' | 'broker_estimate' | null }> | null;
  created_by: string | null;
  value_low: number | null;
  value_mid: number | null;
  value_high: number | null;
  share_token: string | null;
  broker_disclosure_acknowledged_at: string | null;
  created_at: string;
};

export default function CMALibraryPage() {
  const [cmas, setCmas] = useState<CMARow[]>([]);
  const [loading, setLoading] = useState(true);
  const [disclosureCMA, setDisclosureCMA] = useState<CMARow | null>(null);
  const [disclosureChecked, setDisclosureChecked] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null);
    });
  }, [supabase]);

  const fetchCMAs = async () => {
    const { data, error } = await supabase
      .from('cmas')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      toast.error(error.message);
    } else {
      setCmas((data || []) as any);
    }
    setLoading(false);
  };

  useEffect(() => { fetchCMAs(); }, []);

  const deleteCMA = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
    const { error } = await supabase.from('cmas').delete().eq('id', id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success('CMA deleted');
    setCmas(prev => prev.filter(c => c.id !== id));
  };

  const performCopyShareLink = async (cma: CMARow) => {
    if (!cma.share_token) {
      toast.error('No share token on this CMA');
      return;
    }
    const url = `${window.location.origin}/report/${cma.share_token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Share link copied');
    } catch {
      toast(url, { duration: 8000 });
    }
  };

  // Returns true if any comp in this CMA has improvement_source='broker_estimate',
  // either via the cma.comp_adjustments map or on the comp record itself.
  const hasBrokerEstimate = async (cma: CMARow): Promise<boolean> => {
    const adj = cma.comp_adjustments || {};
    if (Object.values(adj).some((a) => a?.improvement_source === 'broker_estimate')) return true;
    const ids = cma.selected_comp_ids || [];
    if (ids.length === 0) return false;
    const { data } = await supabase
      .from('comps')
      .select('id,improvement_source')
      .in('id', ids);
    return (data || []).some((c: any) => c.improvement_source === 'broker_estimate');
  };

  const handleShareClick = async (cma: CMARow) => {
    if (cma.broker_disclosure_acknowledged_at) {
      // Already acknowledged for this CMA — copy directly
      performCopyShareLink(cma);
      return;
    }
    const hasEstimate = await hasBrokerEstimate(cma);
    if (!hasEstimate) {
      performCopyShareLink(cma);
      return;
    }
    setDisclosureChecked(false);
    setDisclosureCMA(cma);
  };

  const confirmDisclosure = async () => {
    if (!disclosureCMA || !disclosureChecked) return;
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('cmas')
      .update({ broker_disclosure_acknowledged_at: now })
      .eq('id', disclosureCMA.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    setCmas(prev => prev.map(c => c.id === disclosureCMA.id ? { ...c, broker_disclosure_acknowledged_at: now } : c));
    const cma = disclosureCMA;
    setDisclosureCMA(null);
    performCopyShareLink(cma);
  };

  return (
    <div className="flex flex-col h-full bg-cream overflow-y-auto">
      <div className="flex-shrink-0 bg-white border-b border-beige px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-slate-blue/10 border border-slate-blue/20 flex items-center justify-center">
            <FileText size={16} className="text-slate-blue-2" />
          </div>
          <div>
            <h1 className="font-bold text-base">My CMAs</h1>
            <p className="text-xs text-ink-3">{cmas.length} saved report{cmas.length === 1 ? '' : 's'}</p>
          </div>
        </div>
        <Link
          href="/dashboard/map"
          className="flex items-center gap-1.5 px-3 py-2 bg-olive hover:bg-olive-2 text-white rounded-lg text-xs font-bold transition-colors"
        >
          <Plus size={13} />
          New CMA from Map
        </Link>
      </div>

      <div className="p-5 space-y-3">
        {loading ? (
          <p className="text-sm text-ink-3 text-center py-12">Loading…</p>
        ) : cmas.length === 0 ? (
          <div className="text-center py-16 space-y-3">
            <div className="w-14 h-14 rounded-2xl bg-cream border border-beige flex items-center justify-center mx-auto">
              <FileText size={20} className="text-ink-3" />
            </div>
            <div>
              <p className="font-bold text-ink">No CMAs yet</p>
              <p className="text-xs text-ink-3 mt-1">
                Build your first one from the map: pick a subject parcel, then tap the comps.
              </p>
            </div>
            <Link
              href="/dashboard/map"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-olive hover:bg-olive-2 text-white rounded-lg text-xs font-bold transition-colors"
            >
              <Plus size={13} />
              Build CMA on Map
            </Link>
          </div>
        ) : (
          cmas.map(cma => {
            const compCount = cma.selected_comp_ids?.length || 0;
            const isSharedWithMe = currentUserId != null && cma.created_by != null && cma.created_by !== currentUserId;
            return (
              <div
                key={cma.id}
                className="bg-white border border-beige hover:border-slate-blue/40 rounded-xl p-4 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/dashboard/map?cma=${cma.id}`} className="flex-1 min-w-0 group">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="font-bold text-base text-ink group-hover:text-slate-blue-2 transition-colors truncate">
                        {cma.subject_name || 'Untitled CMA'}
                      </h2>
                      {isSharedWithMe && (
                        <span
                          className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 bg-slate-blue/10 border border-slate-blue/30 text-slate-blue-2 rounded uppercase tracking-wider"
                          title="A teammate added you as a collaborator on this CMA"
                        >
                          <Users size={9} />
                          Shared with you
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-2 mt-1">
                      <span className="text-ink-2">{cma.subject_county}, {cma.subject_state}</span>
                      <span className="text-ink-3 mx-1.5">·</span>
                      {formatAcres(cma.subject_acres)}
                      <span className="text-ink-3 mx-1.5">·</span>
                      {compCount} comp{compCount === 1 ? '' : 's'}
                      <span className="text-ink-3 mx-1.5">·</span>
                      {new Date(cma.created_at).toLocaleDateString()}
                    </p>
                    {cma.value_mid != null && (
                      <p className="text-sm font-bold text-olive-2 font-mono mt-2">
                        {formatCurrency(cma.value_low || 0)} – {formatCurrency(cma.value_high || 0)}
                        <span className="text-ink-3 font-normal text-xs ml-2">
                          (mid {formatCurrency(cma.value_mid)})
                        </span>
                      </p>
                    )}
                  </Link>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Link
                      href={`/dashboard/map?cma=${cma.id}`}
                      className="p-2 text-ink-2 hover:text-slate-blue-2 hover:bg-slate-blue/10 rounded-lg transition-colors"
                      title="Open on map"
                    >
                      <MapPin size={14} />
                    </Link>
                    {cma.share_token && (
                      <a
                        href={`/report/${cma.share_token}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 text-ink-2 hover:text-slate-blue-2 hover:bg-slate-blue/10 rounded-lg transition-colors"
                        title="Preview as client"
                      >
                        <Eye size={14} />
                      </a>
                    )}
                    <button
                      onClick={() => handleShareClick(cma)}
                      className="p-2 text-ink-2 hover:text-olive-2 hover:bg-olive-tint rounded-lg transition-colors"
                      title="Copy share link"
                    >
                      <Share2 size={14} />
                    </button>
                    <button
                      onClick={() => deleteCMA(cma.id, cma.subject_name)}
                      className="p-2 text-ink-2 hover:text-red-500 hover:bg-red-400/10 rounded-lg transition-colors"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Broker-estimate disclosure modal */}
      {disclosureCMA && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white border border-beige rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-beige flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-amber-50 border border-amber-500/60 flex items-center justify-center">
                <AlertCircle size={16} className="text-amber-600" />
              </div>
              <div>
                <p className="font-bold text-ink">Confirm Broker-Estimated Values</p>
                <p className="text-xs text-ink-3">Required before sharing this CMA</p>
              </div>
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-sm text-ink-2 leading-relaxed">
                This CMA includes one or more comps with broker-estimated improvement values.
                These estimates have not been verified by a licensed appraiser, and the client
                report will display them with a "Broker-estimated" badge plus a footer disclosure.
              </p>
              <label className="flex items-start gap-2 text-sm text-ink cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={disclosureChecked}
                  onChange={(e) => setDisclosureChecked(e.target.checked)}
                  className="mt-0.5 accent-amber-400"
                />
                <span>
                  I confirm these improvement values are broker estimates and will be
                  disclosed as such to the client.
                </span>
              </label>
            </div>
            <div className="px-5 py-3 border-t border-beige flex items-center justify-end gap-2">
              <button
                onClick={() => setDisclosureCMA(null)}
                className="px-4 py-2 text-xs font-bold text-ink-2 hover:text-ink transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDisclosure}
                disabled={!disclosureChecked}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-black rounded-lg text-xs font-bold transition-colors"
              >
                Acknowledge & Copy Share Link
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

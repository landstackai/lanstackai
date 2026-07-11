'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { CMA } from '@/types';
import { formatCurrency, formatAcres } from '@/lib/utils';
import { computeCmaAverages, subjectTotals, type CmaComp } from '@/lib/utils/cmaMath';
import { properCase } from '@/lib/utils/properCase';
import { FileText, Plus, MapPin, Trash2, Share2, AlertCircle, Eye, Users, Pencil, Check, X } from 'lucide-react';
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
  // Live comp data keyed by id, used to recompute CMA value ranges
  // on the fly instead of trusting the (often-stale) saved
  // value_low/mid/high snapshot. See computeCmaAverages docstring.
  const [compsById, setCompsById] = useState<Record<string, CmaComp>>({});
  const [disclosureCMA, setDisclosureCMA] = useState<CMARow | null>(null);
  const [disclosureChecked, setDisclosureChecked] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  // Inline rename: which CMA is being edited (null = none) + current input value.
  // Renders an <input> in place of the name in the list row while active.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  // Inline acres edit — same pattern, separate state so both can (in principle)
  // be active on different rows simultaneously without collision.
  const [editingAcresId, setEditingAcresId] = useState<string | null>(null);
  const [acresValue, setAcresValue] = useState('');
  const [acresSaving, setAcresSaving] = useState(false);
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
      const rows = (data || []) as CMARow[];
      setCmas(rows);

      // Batch-fetch ALL comps referenced by ANY CMA in this list. One
      // round trip rather than N. Then we can compute averages live in
      // useMemo per render — saved value_low/mid/high becomes a fallback
      // only used while these are loading.
      const allCompIds = new Set<string>();
      for (const r of rows) {
        (r.selected_comp_ids || []).forEach((id) => id && allCompIds.add(id));
      }
      if (allCompIds.size > 0) {
        const { data: comps } = await supabase
          .from('comps')
          .select('id,acres,sale_price,improvements_value,improvement_value,improvement_source,has_improvements')
          .in('id', Array.from(allCompIds));
        if (comps) {
          const byId: Record<string, CmaComp> = {};
          for (const c of comps as CmaComp[]) byId[c.id] = c;
          setCompsById(byId);
        }
      }
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

  // Start/save/cancel inline rename of a CMA's subject_name. The name shows
  // on the CMA list card and (via `properCase`) on the map view + public
  // report — persisting subject_name updates all of those in one write.
  const startRename = (cma: CMARow) => {
    setRenamingId(cma.id);
    setRenameValue(cma.subject_name || '');
  };
  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };
  const saveRename = async (id: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      toast.error('Name cannot be empty');
      return;
    }
    setRenameSaving(true);
    try {
      const { error } = await supabase
        .from('cmas')
        .update({ subject_name: trimmed })
        .eq('id', id);
      if (error) {
        toast.error(`Rename failed: ${error.message}`);
        return;
      }
      toast.success('Renamed');
      setCmas(prev => prev.map(c => c.id === id ? { ...c, subject_name: trimmed } : c));
      cancelRename();
    } finally {
      setRenameSaving(false);
    }
  };

  // Inline acres edit — direct override for cases where the geometry-computed
  // acres is wrong (partial-parcel sales, carve-outs, county records that
  // disagree with GIS geometry, etc.). Overrides subject_acres directly; does
  // not touch subject_boundary_geojson.
  const startEditAcres = (cma: CMARow) => {
    setEditingAcresId(cma.id);
    setAcresValue(String(cma.subject_acres ?? ''));
  };
  const cancelEditAcres = () => {
    setEditingAcresId(null);
    setAcresValue('');
  };
  const saveEditAcres = async (id: string) => {
    const parsed = parseFloat(acresValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error('Acres must be a positive number');
      return;
    }
    setAcresSaving(true);
    try {
      const { error } = await supabase
        .from('cmas')
        .update({ subject_acres: parsed })
        .eq('id', id);
      if (error) {
        toast.error(`Update failed: ${error.message}`);
        return;
      }
      toast.success('Acres updated');
      setCmas(prev => prev.map(c => c.id === id ? { ...c, subject_acres: parsed } : c));
      cancelEditAcres();
    } finally {
      setAcresSaving(false);
    }
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
            const compIds = cma.selected_comp_ids || [];
            const compCount = compIds.length;
            const isSharedWithMe = currentUserId != null && cma.created_by != null && cma.created_by !== currentUserId;

            // ─── Live recompute of the value range ──────────────────
            // Resolve the CMA's comp IDs against compsById (batch-fetched
            // above). When at least one comp is available, recompute
            // averages + subject totals via the shared cmaMath helpers
            // so the list view ALWAYS agrees with the workspace +
            // printable report. Falls back to the saved value_low/mid/
            // high snapshot only when comps haven't loaded yet (initial
            // render) or when none of the referenced comps still exist
            // (deleted from vault).
            const liveComps = compIds.map((id) => compsById[id]).filter((c): c is CmaComp => Boolean(c));
            const subjAcres = Number(cma.subject_acres) || 0;
            const computed = liveComps.length > 0
              ? subjectTotals(computeCmaAverages(liveComps, cma.comp_adjustments), subjAcres).total
              : null;
            const showLow = computed?.low ?? cma.value_low;
            const showMid = computed?.mid ?? cma.value_mid;
            const showHigh = computed?.high ?? cma.value_high;
            const hasRange = (showMid != null && showMid > 0) || (showLow != null && showLow > 0);

            return (
              <div
                key={cma.id}
                className="bg-white border border-beige hover:border-slate-blue/40 rounded-xl p-4 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  {/* Inline rename mode: input + save/cancel replaces the link
                      wrapper so the broker doesn't accidentally navigate to
                      the map while typing. Enter saves; Escape cancels. */}
                  {renamingId === cma.id ? (
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveRename(cma.id);
                            else if (e.key === 'Escape') cancelRename();
                          }}
                          autoFocus
                          disabled={renameSaving}
                          className="flex-1 min-w-0 font-bold text-base bg-cream border border-slate-blue/40 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-slate-blue/30"
                          placeholder="CMA name"
                        />
                        <button
                          onClick={() => saveRename(cma.id)}
                          disabled={renameSaving}
                          className="p-1.5 text-olive-2 hover:bg-olive-tint rounded disabled:opacity-50"
                          title="Save (Enter)"
                          aria-label="Save rename"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={cancelRename}
                          disabled={renameSaving}
                          className="p-1.5 text-ink-2 hover:text-red-500 hover:bg-red-400/10 rounded disabled:opacity-50"
                          title="Cancel (Esc)"
                          aria-label="Cancel rename"
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <p className="text-xs text-ink-3 mt-1">
                        {properCase(cma.subject_county)}, {cma.subject_state} · {formatAcres(cma.subject_acres)} · {compCount} comp{compCount === 1 ? '' : 's'}
                      </p>
                    </div>
                  ) : (
                  <Link href={`/dashboard/map?cma=${cma.id}`} className="flex-1 min-w-0 group">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="font-bold text-base text-ink group-hover:text-slate-blue-2 transition-colors truncate">
                        {properCase(cma.subject_name) || 'Untitled CMA'}
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
                    <p className="text-xs text-ink-2 mt-1 flex items-center gap-1 flex-wrap">
                      <span className="text-ink-2">{properCase(cma.subject_county)}, {cma.subject_state}</span>
                      <span className="text-ink-3">·</span>
                      {/* Acres — click to edit inline. Overrides subject_acres
                          directly without touching the boundary geometry. */}
                      {editingAcresId === cma.id ? (
                        <span
                          onClick={(e) => e.preventDefault()}
                          className="inline-flex items-center gap-1"
                        >
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={acresValue}
                            onChange={(e) => setAcresValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); saveEditAcres(cma.id); }
                              else if (e.key === 'Escape') { e.preventDefault(); cancelEditAcres(); }
                            }}
                            onClick={(e) => e.preventDefault()}
                            autoFocus
                            disabled={acresSaving}
                            className="w-24 text-xs bg-cream border border-slate-blue/40 rounded px-1.5 py-0.5 focus:outline-none focus:ring-2 focus:ring-slate-blue/30"
                          />
                          <button
                            onClick={(e) => { e.preventDefault(); saveEditAcres(cma.id); }}
                            disabled={acresSaving}
                            className="p-0.5 text-olive-2 hover:bg-olive-tint rounded disabled:opacity-50"
                            title="Save (Enter)"
                            aria-label="Save acres"
                          >
                            <Check size={12} />
                          </button>
                          <button
                            onClick={(e) => { e.preventDefault(); cancelEditAcres(); }}
                            disabled={acresSaving}
                            className="p-0.5 text-ink-2 hover:text-red-500 hover:bg-red-400/10 rounded disabled:opacity-50"
                            title="Cancel (Esc)"
                            aria-label="Cancel"
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={(e) => { e.preventDefault(); startEditAcres(cma); }}
                          className="inline-flex items-center gap-1 hover:text-slate-blue-2 hover:underline decoration-dashed underline-offset-2 transition-colors"
                          title="Click to edit acres"
                        >
                          {formatAcres(cma.subject_acres)}
                          <Pencil size={9} className="opacity-40" />
                        </button>
                      )}
                      <span className="text-ink-3">·</span>
                      {compCount} comp{compCount === 1 ? '' : 's'}
                      <span className="text-ink-3">·</span>
                      {new Date(cma.created_at).toLocaleDateString()}
                    </p>
                    {hasRange ? (
                      <p className="text-sm font-bold text-olive-2 font-mono mt-2">
                        {formatCurrency(showLow || 0)} – {formatCurrency(showHigh || 0)}
                        <span className="text-ink-3 font-normal text-xs ml-2">
                          (mid {formatCurrency(showMid || 0)})
                        </span>
                      </p>
                    ) : (
                      <p className="text-xs text-ink-3 italic mt-2">
                        Value range pending — open the CMA to recompute
                      </p>
                    )}
                  </Link>
                  )}

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {/* Rename button. Hidden while another CMA is being renamed
                        to keep the row's action set unambiguous. */}
                    {renamingId !== cma.id && (
                      <button
                        onClick={() => startRename(cma)}
                        className="p-2 text-ink-2 hover:text-slate-blue-2 hover:bg-slate-blue/10 rounded-lg transition-colors"
                        title="Rename"
                        aria-label="Rename CMA"
                      >
                        <Pencil size={14} />
                      </button>
                    )}
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

'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { ExtractedComp } from '@/types';
import { Upload, Send, FileText, CheckCircle, AlertCircle, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { pdfToImages } from '@/lib/utils/pdfToImages';

// Browser-side auto-locate: uses our cached /api/parcels-by-owner endpoint
// (which the browser CAN cache, unlike Vercel function-to-self calls).
// Mirrors the server-side autoLocateFromMetadata logic but runs in the
// browser context to get the cache hits the manual search bar gets.
//
// Strategy: query by longest single owner-name token (cache-friendly),
// filter client-side for all tokens, cluster spatially, pick the cluster
// whose summed acreage matches the appraisal within 50%.
//
// Returns { latitude, longitude, parcel_id, geometry, match_reason } or null.
async function autoLocateInBrowser(comp: any, _diag?: AutoLocateDiagCollector): Promise<{
  latitude: number;
  longitude: number;
  parcel_id: string | null;
  geometry: any;
  match_reason: string;
  match_confidence: 'high' | 'medium' | 'low';
} | null> {
  const acres = Number(comp?.acres);
  const county = String(comp?.county || '').trim();
  if (!Number.isFinite(acres) || acres <= 0 || !county) {
    if (_diag) _diag.reject_reason = 'missing_acres_or_county';
    return null;
  }

  const ownerSignals = [comp.grantee, comp.grantor, comp.property_name]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  if (ownerSignals.length === 0) {
    if (_diag) _diag.reject_reason = 'no_owner_signals';
    return null;
  }

  // @ts-expect-error — turf v6.5 .d.ts not exposed
  const turf = await import('@turf/turf') as any;

  // Strip more punctuation than before — apostrophes (curly + straight),
  // hyphens, slashes, ampersands all become spaces. Previously only [.,]
  // were stripped, which broke tokenizing for owners like "Turner Kids'"
  // (apostrophe stayed glued to KIDS') and "Smith-Jones" (hyphen kept).
  const normalize = (s: string) => s.toUpperCase()
    .replace(/[.,'’\-\/&]/g, ' ')
    .replace(/\b(LLC|LTD|INC|TRUSTEE|TRUST|FAMILY|REVOCABLE|LIVING|JR|SR)\b/g, '')
    .replace(/\s+/g, ' ').trim();

  // Stop words to drop from token set (super-common short words that
  // would otherwise match everything in a query).
  const CLIENT_STOP_WORDS = new Set(['THE', 'OF', 'AND', 'ET', 'AL']);

  for (const owner of ownerSignals) {
    const normalized = normalize(owner);
    // Keep tokens that are ≥3 chars OR contain a digit (so short LLC
    // prefixes like "9L", "4F", "2L" survive — they're very distinctive
    // and the only way to disambiguate from generic words like "FARMS").
    const allTokens = normalized.split(/\s+/)
      .filter((t) => (t.length >= 3 || /\d/.test(t)) && !CLIENT_STOP_WORDS.has(t));
    if (allTokens.length === 0) continue;
    const longest = [...allTokens].sort((a, b) => b.length - a.length)[0];

    // Hit the cached endpoint. Browser fetch DOES hit the edge cache.
    let features: any[] = [];
    try {
      const url = `/api/parcels-by-owner?q=${encodeURIComponent(longest)}&county=${encodeURIComponent(county)}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      features = Array.isArray(data?.features) ? data.features : [];
    } catch {
      continue;
    }

    // Filter to records that contain every owner token
    const tight = features.filter((f: any) => {
      const own = (f.properties?.owner_name || '').toString().toUpperCase();
      return allTokens.every((t) => own.includes(t));
    });
    console.log(`[client-autoLocate] "${owner}" → ${features.length} raw, ${tight.length} tight`);

    // Per-signal diagnostic capture — useful for analyzing which owner
    // signals (grantee vs grantor vs property_name) tend to find vs fail.
    if (_diag) {
      _diag.owner_search_data = _diag.owner_search_data || [];
      _diag.owner_search_data.push({
        signal: owner,
        tokens: allTokens,
        raw_count: features.length,
        tight_count: tight.length,
      });
    }

    if (tight.length === 0) continue;

    // Cluster by centroid distance (~1mi threshold)
    const GRID_DEG = 0.015;
    const items = tight.map((f: any) => {
      let centroid: [number, number] | null = null;
      try {
        const c = turf.centroid(f);
        const coords = c?.geometry?.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) centroid = [coords[0], coords[1]];
      } catch {}
      return {
        feature: f,
        centroid,
        acres: Number(f.properties?.gis_area) || 0,
      };
    }).filter((i: any) => i.centroid) as Array<{ feature: any; centroid: [number, number]; acres: number }>;

    // FLAG: NEXT_PUBLIC_ADJACENCY_CLUSTERING=1 → use geometric edge-adjacency
    // (2m buffer + intersection check) instead of centroid distance.
    const useAdjacency = process.env.NEXT_PUBLIC_ADJACENCY_CLUSTERING === '1';
    let clusters: Array<{ parcels: any[]; centroid: [number, number]; totalAcres: number }> = [];

    if (useAdjacency) {
      // Buffer each parcel by 2m then connect via union-find on
      // boolean intersection of the buffered polygons.
      const buffered: any[] = items.map((it: any) => {
        try { return turf.buffer(it.feature, 2, { units: 'meters' }); } catch { return null; }
      });
      const parent: number[] = items.map((_: any, i: number) => i);
      const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
      const union = (i: number, j: number) => {
        const ri = find(i), rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      };
      for (let i = 0; i < items.length; i++) {
        if (!buffered[i]) continue;
        for (let j = i + 1; j < items.length; j++) {
          if (!buffered[j]) continue;
          try { if (turf.booleanIntersects(buffered[i], buffered[j])) union(i, j); } catch {}
        }
      }
      const groups = new Map<number, any[]>();
      for (let i = 0; i < items.length; i++) {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r)!.push(items[i]);
      }
      clusters = Array.from(groups.values()).map((groupItems: any[]) => {
        let sx = 0, sy = 0;
        for (const it of groupItems) { sx += it.centroid[0]; sy += it.centroid[1]; }
        return {
          parcels: groupItems.map((it) => it.feature),
          centroid: [sx / groupItems.length, sy / groupItems.length] as [number, number],
          totalAcres: groupItems.reduce((s: number, it: any) => s + it.acres, 0),
        };
      });
    } else {
      // Centroid clustering (current default behavior)
      for (const it of items) {
        let best: typeof clusters[number] | null = null;
        let bestDist = Infinity;
        for (const c of clusters) {
          const d = Math.hypot(it.centroid[0] - c.centroid[0], it.centroid[1] - c.centroid[1]);
          if (d < bestDist && d <= GRID_DEG) { bestDist = d; best = c; }
        }
        if (best) {
          best.parcels.push(it.feature);
          best.totalAcres += it.acres;
          const n = best.parcels.length;
          best.centroid = [
            (best.centroid[0] * (n - 1) + it.centroid[0]) / n,
            (best.centroid[1] * (n - 1) + it.centroid[1]) / n,
          ];
        } else {
          clusters.push({ parcels: [it.feature], centroid: it.centroid, totalAcres: it.acres });
        }
      }
    }

    // Recompute cluster acreage from unioned area (handles TxGIO duplicates)
    for (const c of clusters) {
      if (c.parcels.length > 1) {
        try {
          let u = c.parcels[0];
          for (let i = 1; i < c.parcels.length; i++) {
            try { const next = turf.union(u, c.parcels[i]); if (next) u = next; } catch {}
          }
          if (u?.geometry) {
            const a = turf.area(u) / 4046.8564224;
            if (Number.isFinite(a) && a > 0) c.totalAcres = a;
          }
        } catch {}
      }
    }

    console.log(`[client-autoLocate] clusters:`, clusters.map(c => `${c.totalAcres.toFixed(1)}ac(${c.parcels.length}p)`).join(', '));

    // Find cluster within 50% acreage tolerance, closest delta wins
    const matched = clusters
      .map((c) => ({ c, delta: Math.abs(c.totalAcres - acres) / acres }))
      .filter(({ delta }) => delta <= 0.50)
      .sort((a, b) => a.delta - b.delta);

    if (matched.length === 0) continue;

    const winner = matched[0];
    let merged: any = winner.c.parcels[0];
    for (let i = 1; i < winner.c.parcels.length; i++) {
      try { const u = turf.union(merged, winner.c.parcels[i]); if (u) merged = u; } catch {}
    }

    // Use turf centroid for the pin (more accurate than running average)
    let pinCoords = winner.c.centroid;
    try {
      const c = turf.centroid(merged);
      if (c?.geometry?.coordinates) pinCoords = c.geometry.coordinates;
    } catch {}

    // Capture winning cluster details for diagnostics — useful for
    // "which cluster size wins most often" and "how often does the
    // winning cluster have multiple alternatives within tolerance"
    // type queries.
    if (_diag) {
      _diag.cluster_data = {
        cluster_count: clusters.length,
        picked_parcel_count: winner.c.parcels.length,
        picked_acres: winner.c.totalAcres,
        picked_delta: winner.delta,
        winning_signal: owner,
        alternatives_within_tolerance: matched.length,
      };
    }

    return {
      latitude: pinCoords[1],
      longitude: pinCoords[0],
      parcel_id: winner.c.parcels.map((p: any) => p.properties?.prop_id).filter(Boolean).join(',') || null,
      geometry: merged.geometry || merged,
      match_reason: `Owner "${owner}" → ${winner.c.parcels.length} parcels, ${winner.c.totalAcres.toFixed(1)}ac (target ${acres}, Δ${(winner.delta * 100).toFixed(1)}%)`,
      match_confidence: winner.delta < 0.10 ? 'high' : 'medium',
    };
  }

  return null;
}

// Type for the optional diagnostic collector that autoLocateInBrowser fills
// in as it runs. The wrapper below builds it up + POSTs to the diagnostic
// endpoint at the end of each call.
type AutoLocateDiagCollector = {
  reject_reason?: string;
  owner_search_data?: Array<{
    signal: string;
    tokens: string[];
    raw_count: number;
    tight_count: number;
  }>;
  cluster_data?: {
    cluster_count: number;
    picked_parcel_count: number;
    picked_acres: number;
    picked_delta: number;
    winning_signal: string;
    alternatives_within_tolerance: number;
  };
};

// Wrapper around autoLocateInBrowser that captures input + per-stage data
// + outcome and POSTs a diagnostic row (fire-and-forget). Use this from
// import flows instead of calling autoLocateInBrowser directly.
//
// Hard rule: this function NEVER throws and NEVER blocks. Even if the
// diagnostic POST fails or the wrapped call throws, the user-facing
// pipeline gets back whatever autoLocateInBrowser would have returned
// (or null on error). Observability is invisible to the user.
async function autoLocateInBrowserLogged(comp: any) {
  const diag: AutoLocateDiagCollector = {};
  const startMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let result: Awaited<ReturnType<typeof autoLocateInBrowser>> = null;
  let threw = false;
  try {
    result = await autoLocateInBrowser(comp, diag);
  } catch (e: any) {
    threw = true;
    console.warn('[autoLocate] threw:', e?.message);
  }
  const ms_total = Math.round(
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startMs
  );

  // Decide exit_stage. Order matters — error trumps everything else.
  let exit_stage: string;
  if (threw) {
    exit_stage = 'error';
  } else if (result) {
    exit_stage = 'owner_search_cluster';
  } else if (diag.reject_reason) {
    exit_stage = 'manual_placeholder';
  } else {
    exit_stage = 'owner_search_null';
  }

  const payload = {
    input_acres: Number(comp?.acres) || null,
    input_sale_price: Number(comp?.sale_price) || null,
    input_ppa: Number(comp?.price_per_acre) || null,
    input_grantee: comp?.grantee || null,
    input_grantor: comp?.grantor || null,
    input_property_name: comp?.property_name || null,
    input_county: comp?.county || null,
    input_lat: typeof comp?.latitude === 'number' ? comp.latitude : null,
    input_lng: typeof comp?.longitude === 'number' ? comp.longitude : null,
    input_has_aerial: Boolean(comp?.aerialImage),
    input_has_description: Boolean(
      typeof comp?.description === 'string' && comp.description.trim().length > 0
    ),
    exit_stage,
    owner_search_data: diag.owner_search_data || null,
    cluster_data: diag.cluster_data || null,
    final_pin_lat: result?.latitude ?? null,
    final_pin_lng: result?.longitude ?? null,
    final_parcel_ids: result?.parcel_id
      ? String(result.parcel_id).split(',').filter(Boolean)
      : null,
    final_cluster_acres: diag.cluster_data?.picked_acres ?? null,
    final_confidence: result?.match_confidence ?? null,
    final_match_reason: result?.match_reason ?? null,
    ms_total,
  };

  // Fire-and-forget. NEVER await, NEVER throw upward.
  try {
    void fetch('/api/diagnostics/autolocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true, // survives the page-navigation race
    }).catch(() => { /* swallow */ });
  } catch {
    // Even constructing the fetch shouldn't be able to throw, but be defensive
  }

  return result;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  comps?: ExtractedComp[];
  timestamp: string;
}

export default function ImportPage() {
  const [messages, setMessages] = useState<Message[]>([{
    role: 'assistant',
    content: "Hi! I'm ready to help you import comps. Upload a PDF, paste text from an appraisal or closing statement, or share a property description. I'll extract the comparable sales data automatically.",
    timestamp: new Date().toISOString(),
  }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingComps, setPendingComps] = useState<ExtractedComp[]>([]);
  // Drag-and-drop state. Counter handles nested drag enter/leave events
  // (which fire for every child element the cursor crosses).
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const isDocumentPaste = (text: string): boolean => {
    if (text.length < 150) return false;
    const patterns = [
      /sale price/i, /acres/i, /county/i, /grantor/i, /grantee/i,
      /recording number/i, /price per acre/i, /land sale/i,
      /property identification/i, /transaction data/i, /sale date/i,
    ];
    return patterns.filter(p => p.test(text)).length >= 3;
  };

  const sendMessage = async (
    text: string,
    fileContent?: string,
    images?: string[]
  ) => {
    const userMessage: Message = {
      role: 'user',
      content: fileContent || images?.length ? `[Document uploaded]\n${text}` : text,
      timestamp: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('/api/import-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMessage].map(m => ({
            role: m.role,
            content: m.content,
          })),
          documentContent: fileContent || (isDocumentPaste(text) ? text : undefined),
          images,
        }),
      });

      const data = await response.json();

      // Browser-side auto-locate: server-side auto-locate fails inside Vercel
      // functions because function-to-self URL calls don't hit the edge cache.
      // Re-run from the browser where /api/parcels-by-owner cache hits work.
      //
      // SKIP when the AI already extracted explicit coords (from a "Geographic
      // Location" field in the doc). Those are authoritative — running browser
      // auto-locate on top could replace them with a less-precise match.
      if (Array.isArray(data.comps)) {
        for (let i = 0; i < data.comps.length; i++) {
          const c = data.comps[i];
          const label = c.property_name || c.county || 'comp';
          if (c.latitude != null && c.longitude != null) {
            console.log(`[import] ${label}: using AI-extracted coords (${c.latitude}, ${c.longitude}) — skipping browser auto-locate`);
            continue;
          }
          try {
            const located = await autoLocateInBrowserLogged(c);
            if (located) {
              console.log(`[import] auto-locate ✓ ${label}: ${located.match_reason}`);
              toast.success(`📍 ${label}: ${located.match_reason}`, { duration: 8000 });
              data.comps[i] = {
                ...c,
                latitude: located.latitude,
                longitude: located.longitude,
                parcel_id: located.parcel_id ?? c.parcel_id,
                geometry: located.geometry,
                _auto_located_confidence: located.match_confidence,
              };
            } else {
              console.log(`[import] auto-locate ✗ ${label} returned null — using server coords (${c.latitude}, ${c.longitude})`);
              toast(
                `📍 ${label}: auto-locate found no match — using AI's coords (${c.latitude?.toFixed?.(4) ?? '?'}, ${c.longitude?.toFixed?.(4) ?? '?'})`,
                { duration: 8000, icon: 'ℹ️' }
              );
            }
          } catch (e: any) {
            console.error(`[import] auto-locate threw for ${label}:`, e);
            toast.error(`📍 ${label}: auto-locate error — ${e?.message || 'unknown'}`, { duration: 8000 });
          }
        }
      }

      const assistantMessage: Message = {
        role: 'assistant',
        content: data.message,
        comps: data.comps,
        timestamp: new Date().toISOString(),
      };

      setMessages(prev => [...prev, assistantMessage]);

      if (data.comps && data.comps.length > 0) {
        setPendingComps(prev => [...prev, ...data.comps]);
      }
    } catch (error) {
      toast.error('Failed to process message');
    } finally {
      setLoading(false);
    }
  };

  // === BATCH UPLOAD PATH (>1 file) ============================================
  // Each file is extracted in ISOLATION — no prior chat history attached to
  // the vision API call. This prevents the token-bloat / context-confusion
  // bug where later files in a batch get processed against the cumulative
  // chat context of earlier files.
  //
  // Successful extractions auto-save to the Vault. The user sees ONE summary
  // toast at the end with a Vault link — no per-comp clicking required.
  // ============================================================================

  // Render a file → images. PDFs go through pdfToImages, image files become
  // a single-entry data-URL array.
  const fileToImages = async (file: File): Promise<string[]> => {
    if (file.type === 'application/pdf') {
      return await pdfToImages(file, { scale: 1.0, maxPages: 15 });
    }
    if (file.type.startsWith('image/')) {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      return [dataUrl];
    }
    return [];
  };

  // Per-file outcome — used to build a persistent log in the chat after
  // the batch completes so the user (and I) can see exactly what happened.
  type ExtractOutcome =
    | { kind: 'ok'; comps: ExtractedComp[] }
    | { kind: 'no_comps'; aiMessage?: string; rawExtracted?: number; filteredOut?: number }
    | { kind: 'http_error'; status: number; statusText: string }
    | { kind: 'network_error'; message: string }
    | { kind: 'render_failed'; message: string };

  // ISOLATED extraction call. Two retry mechanisms:
  //  1. Transient errors (429, 5xx) → exponential backoff, up to 3 attempts
  //  2. Empty `comps: []` result → retry ONCE with a "look harder" prompt
  //     telling the AI this is definitely a comp record even if it only
  //     contains one property. Catches the AI's tendency to be over-cautious.
  const extractCompsFromFile = async (
    file: File,
    attempt: number = 1,
    retryAggressive: boolean = false
  ): Promise<ExtractOutcome> => {
    let images: string[] = [];
    try {
      images = await fileToImages(file);
    } catch (e: any) {
      return { kind: 'render_failed', message: e?.message || 'render error' };
    }
    if (images.length === 0) {
      return { kind: 'render_failed', message: 'no pages rendered' };
    }

    const aggressivePreamble = retryAggressive
      ? `IMPORTANT: My first attempt to extract this document returned no comps. ` +
        `Look again — this is almost certainly a Type A single-property sale ` +
        `record. If you can find ANY combination of Sale Price, Sale Date, ` +
        `Grantor, Grantee, or Recording Number anywhere in the document, ` +
        `extract that property as a comp. Set is_comparable=true. Only return ` +
        `comps:[] if this is clearly a marketing flyer or has no sale data at all.\n\n`
      : '';

    try {
      const response = await fetch('/api/import-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: `${aggressivePreamble}[Document uploaded] Uploaded: ${file.name}`,
            },
          ],
          images,
        }),
      });
      // Retry transient errors with backoff.
      if (!response.ok) {
        const transient = response.status === 429 || response.status >= 500;
        if (transient && attempt < 3) {
          const delay = attempt * 2500;
          await new Promise((r) => setTimeout(r, delay));
          return extractCompsFromFile(file, attempt + 1, retryAggressive);
        }
        return { kind: 'http_error', status: response.status, statusText: response.statusText };
      }
      const data = await response.json();
      const comps: ExtractedComp[] = Array.isArray(data?.comps) ? data.comps : [];
      if (comps.length === 0) {
        if (!retryAggressive) {
          return extractCompsFromFile(file, 1, true);
        }
        return {
          kind: 'no_comps',
          aiMessage: data?.message,
          rawExtracted: data?.diagnostic?.raw_extracted,
          filteredOut: data?.diagnostic?.filtered_out,
        };
      }

      // Browser-side auto-locate — server-side fails inside Vercel functions
      // because function-to-self URLs don't hit the edge cache. Re-run from
      // here where /api/parcels-by-owner cache hits work.
      for (let i = 0; i < comps.length; i++) {
        const located = await autoLocateInBrowserLogged(comps[i]);
        if (located) {
          console.log(`[batch] auto-located ${comps[i].property_name || comps[i].county}: ${located.match_reason}`);
          comps[i] = {
            ...comps[i],
            latitude: located.latitude,
            longitude: located.longitude,
            parcel_id: located.parcel_id ?? comps[i].parcel_id,
            geometry: located.geometry,
            _auto_located_confidence: located.match_confidence,
          } as ExtractedComp;
        }
      }

      return { kind: 'ok', comps };
    } catch (e: any) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 2500));
        return extractCompsFromFile(file, attempt + 1, retryAggressive);
      }
      return { kind: 'network_error', message: e?.message || 'fetch failed' };
    }
  };

  // Self-healing insert. If the DB schema is behind the app (e.g. a new
  // column hasn't been migrated yet), Supabase returns
  // "Could not find the 'X' column of 'comps' in the schema cache". We parse
  // that, drop the offending field from the payload, and retry. The comp
  // still saves with whatever columns DO exist — the only cost is the new
  // metadata not landing for now. Eliminates the "must run migrations
  // before importing" failure mode.
  const insertCompResilient = async (
    payload: Record<string, any>,
    maxRetries: number = 8
  ): Promise<{ data: { id: string } | null; error: any }> => {
    let current = { ...payload };
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const { data, error } = await supabase
        .from('comps')
        .insert(current)
        .select('id')
        .maybeSingle();
      if (!error) return { data, error: null };
      // Look for the column-not-found pattern from PostgREST.
      const msg = String(error.message || '');
      const m = msg.match(/Could not find the '([\w_]+)' column/);
      if (!m) return { data: null, error };
      const missingCol = m[1];
      if (!(missingCol in current)) return { data: null, error };
      delete current[missingCol];
      console.warn(`saveCompSilent: schema missing '${missingCol}' — retrying without it`);
    }
    return { data: null, error: new Error('Insert exhausted retries after schema mismatches') };
  };

  // Silent insert — same fields as saveComp() but no toast and returns a
  // boolean for the batch summary to count successes. Also writes a row to
  // import_exemplars so we have data for the learning loop (path B).
  const saveCompSilent = async (comp: ExtractedComp): Promise<boolean> => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const conf =
      comp.confidence?.overall > 80 ? 'Verified'
      : comp.confidence?.overall > 50 ? 'Estimated'
      : 'Unverified';
    const { data: inserted, error } = await insertCompResilient({
      created_by: user.id,
      property_name: comp.property_name,
      county: comp.county || '',
      state: comp.state || 'TX',
      acres: comp.acres || 0,
      sale_price: comp.sale_price || 0,
      improvements_value: (comp as any).improvements_value,
      sale_date: (comp as any).sale_date,
      address: (comp as any).address,
      latitude: (comp as any).latitude,
      longitude: (comp as any).longitude,
      parcel_id: (comp as any).parcel_id,
      recording_number: (comp as any).recording_number,
      grantor: (comp as any).grantor,
      grantee: (comp as any).grantee,
      financing: (comp as any).financing,
      minerals_sold: (comp as any).minerals_sold,
      confirmation_source: (comp as any).confirmation_source,
      description: (comp as any).description,
      water: (comp as any).water || 'None',
      road_frontage: (comp as any).road_frontage || 'None',
      has_improvements: (comp as any).has_improvements || false,
      improvements_notes: (comp as any).improvements_notes,
      has_water_rights: (comp as any).has_water_rights ?? null,
      irrigation: (comp as any).irrigation ?? null,
      flood_plain: (comp as any).flood_plain ?? null,
      status: 'Sold',
      visibility: 'team',
      confidence: conf,
      boundary_geojson: (comp as any).geometry ?? null,
      // Math identity gate flag from extraction (see /api/import-chat).
      needs_extraction_review: comp.needs_extraction_review || false,
    });

    if (error || !inserted) return false;

    // === LEARNING LOOP — write an exemplar for this comp ==================
    // Captures what AI extracted, what auto-locate did, what the broker
    // ultimately accepted. Best-effort: if the import_exemplars table
    // doesn't exist yet (migration 016 not run), this silently no-ops.
    // ======================================================================
    try {
      const { error: exemplarError } = await supabase.from('import_exemplars').insert({
        comp_id: inserted.id,
        created_by: user.id,
        description: (comp as any).description ?? null,
        address: (comp as any).address ?? null,
        county: comp.county || null,
        state: comp.state || 'TX',
        acres: comp.acres ?? null,
        grantor: (comp as any).grantor ?? null,
        grantee: (comp as any).grantee ?? null,
        ai_auto_located: (comp as any).latitude != null && (comp as any).longitude != null,
        ai_match_confidence: (comp as any)._auto_located_confidence ?? null,
        ai_match_reason: (comp as any)._auto_located ?? null,
        final_lat: (comp as any).latitude ?? null,
        final_lng: (comp as any).longitude ?? null,
        was_manually_fixed: false,
      });
      if (exemplarError) {
        // Silently ignore — table likely doesn't exist (migration not run yet).
        // Comp itself saved successfully which is what matters.
      }
    } catch {
      // Swallow — exemplar tracking is purely opportunistic.
    }
    return true;
  };

  // Batch entrypoint. Single file → chat-based path (existing UX with
  // per-comp review). Multiple files → isolated extraction + auto-save.
  const handleMultipleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (files.length === 1) {
      await handleFileUpload(files[0]);
      return;
    }

    const toastId = 'batch-upload';
    let savedCount = 0;
    const outcomes: Array<{ file: string; outcome: ExtractOutcome }> = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      toast.loading(
        `Processing ${i + 1} of ${files.length}: ${file.name}`,
        { id: toastId }
      );
      const outcome = await extractCompsFromFile(file);
      outcomes.push({ file: file.name, outcome });
      if (outcome.kind === 'ok') {
        for (const comp of outcome.comps) {
          const ok = await saveCompSilent(comp);
          if (ok) savedCount++;
        }
      }
    }

    toast.dismiss(toastId);

    // Build a persistent, scrollable log in the chat so the user (and I) can
    // see exactly what happened to each file. Toasts disappear; chat doesn't.
    const failedCount = outcomes.filter((o) => o.outcome.kind !== 'ok').length;
    const lines = outcomes.map(({ file, outcome }) => {
      switch (outcome.kind) {
        case 'ok':
          return `✓ ${file} — saved ${outcome.comps.length} comp${outcome.comps.length === 1 ? '' : 's'}`;
        case 'no_comps': {
          const filterNote =
            outcome.rawExtracted && outcome.rawExtracted > 0
              ? ` [AI extracted ${outcome.rawExtracted}, all filtered out — likely tagged as subject_property]`
              : '';
          const aiNote = outcome.aiMessage ? ` (AI: "${outcome.aiMessage.slice(0, 120)}")` : '';
          return `⚠ ${file} — extraction returned no comps${filterNote}${aiNote}`;
        }
        case 'http_error':
          return `✗ ${file} — server error (HTTP ${outcome.status} ${outcome.statusText})`;
        case 'network_error':
          return `✗ ${file} — network error: ${outcome.message}`;
        case 'render_failed':
          return `✗ ${file} — could not render PDF (${outcome.message})`;
      }
    });
    const summary = `**Batch import complete — ${savedCount} comp${savedCount === 1 ? '' : 's'} saved, ${failedCount} issue${failedCount === 1 ? '' : 's'}.**\n\n${lines.join('\n')}`;

    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content: summary,
        timestamp: new Date().toISOString(),
      },
    ]);

    if (savedCount > 0) {
      toast.success(
        (t) => (
          <span>
            Imported <b>{savedCount}</b> comp{savedCount === 1 ? '' : 's'}
            {failedCount > 0 && <span className="text-amber-300"> ({failedCount} issue{failedCount === 1 ? '' : 's'} — see chat log)</span>}.{' '}
            <button
              onClick={() => {
                toast.dismiss(t.id);
                router.push('/dashboard/vault');
              }}
              className="underline font-bold text-sage"
            >
              View in Vault →
            </button>
          </span>
        ),
        { duration: 12000 }
      );
    } else {
      toast.error(
        `None of the ${files.length} files saved. See the chat log for per-file details.`,
        { duration: 10000 }
      );
    }
  };

  // Chunked PDF extraction for large appraisal reports. Splits images into
  // 5-page batches, runs AI extraction on each separately, accumulates the
  // unique comps, dedupes, then runs browser auto-locate on each.
  //
  // Why: GPT-4o vision has an input token budget that ~5 high-res images fits
  // comfortably but 20+ images blows past, returning "no comps" silently.
  // Chunking guarantees each call has enough budget to actually read the
  // pages it's given.
  const extractFromChunkedPdf = async (file: File, images: string[]) => {
    // 4-page chunks with 1-page overlap (stride 3). Tuned for the dominant
    // pattern in TX appraisal reports: 2 pages per comp (photo/ID/price on
    // page N, description/remarks on page N+1).
    //
    // For 24 pages (12 comps × 2 pages): 8 chunks. Each 2-page comp is
    // guaranteed to appear complete in at least one chunk — comps that
    // start on the last page of a chunk are caught whole by the next chunk
    // (which starts 3 pages back and extends 4 forward).
    //
    // Dedupe by (name|date|price) collapses the same comp seen in
    // overlapping chunks.
    const CHUNK_SIZE = 4;
    const STRIDE = 3;
    const chunks: string[][] = [];
    for (let i = 0; i < images.length; i += STRIDE) {
      const chunk = images.slice(i, i + CHUNK_SIZE);
      chunks.push(chunk);
      // Stop when we've reached the end (last chunk includes final pages)
      if (i + CHUNK_SIZE >= images.length) break;
    }

    // Show upload as one user message
    const userMessage: Message = {
      role: 'user',
      content: `[Document uploaded]\nUploaded: ${file.name} (${images.length} pages, processing ${chunks.length} chunks)`,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMessage]);

    const allComps: any[] = [];
    let errorCount = 0;
    const perChunkCounts: number[] = [];
    const perChunkMessages: string[] = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const startPage = chunkIdx * STRIDE + 1;
      const endPage = Math.min(chunkIdx * STRIDE + CHUNK_SIZE, images.length);
      const toastId = `chunk-${chunkIdx}`;
      toast.loading(`Extracting comps from pages ${startPage}-${endPage} of ${images.length}…`, { id: toastId });

      try {
        const response = await fetch('/api/import-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{
              role: 'user',
              content: `[Document uploaded]\nExtract any comparable land sales visible on these pages. This is part ${chunkIdx + 1} of ${chunks.length} of a multi-page appraisal report.`,
            }],
            images: chunks[chunkIdx],
          }),
        });
        toast.dismiss(toastId);

        if (!response.ok) {
          errorCount++;
          perChunkCounts.push(0);
          perChunkMessages.push(`HTTP ${response.status}`);
          console.warn(`Chunk ${chunkIdx + 1} HTTP ${response.status}`);
          continue;
        }
        const data = await response.json();
        const compCount = Array.isArray(data.comps) ? data.comps.length : 0;
        perChunkCounts.push(compCount);
        perChunkMessages.push(data.message?.slice(0, 80) || '');
        if (compCount > 0) {
          console.log(`[chunked] pages ${startPage}-${endPage}: ${compCount} comps`);
          allComps.push(...data.comps);
        } else {
          console.log(`[chunked] pages ${startPage}-${endPage}: 0 comps — AI said: ${data.message?.slice(0, 100)}`);
        }
      } catch (e: any) {
        toast.dismiss(toastId);
        errorCount++;
        perChunkCounts.push(0);
        perChunkMessages.push(`threw: ${e?.message || 'unknown'}`);
        console.error(`Chunk ${chunkIdx + 1} threw:`, e);
      }
    }

    // Deduplicate by (property_name + sale_date + sale_price). When the same
    // comp appears in multiple overlapping chunks, prefer the version with
    // the most complete data — specifically, the one with a boundary
    // geometry (from server-side enrichment), then the one with coords.
    // Otherwise the first occurrence wins.
    const byKey = new Map<string, any>();
    for (const c of allComps) {
      // Include grantee in the key so two distinct transactions of the SAME
      // property name (e.g. Wesla Ranches → 4F and Wesla Ranches → 9L) don't
      // collapse to one. Without grantee, AI mis-extracted or near-duplicate
      // sales got merged into one comp.
      const key = `${(c.property_name || '').toLowerCase().trim()}|${(c.grantee || '').toLowerCase().trim()}|${c.sale_date || ''}|${c.sale_price || 0}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, c);
        continue;
      }
      // Prefer the one with geometry, then with coords, then keep existing
      const newScore = (c.geometry ? 2 : 0) + (c.latitude != null ? 1 : 0);
      const oldScore = (existing.geometry ? 2 : 0) + (existing.latitude != null ? 1 : 0);
      if (newScore > oldScore) {
        byKey.set(key, c);
      }
    }
    const dedupedComps = Array.from(byKey.values());
    if (dedupedComps.length < allComps.length) {
      console.log(`[chunked] deduped: ${allComps.length} raw → ${dedupedComps.length} unique`);
    }

    // Run browser auto-locate for each unique comp (overrides any AI-guessed
    // coords for comps that don't have explicit "Geographic Location" fields).
    for (let i = 0; i < dedupedComps.length; i++) {
      const c = dedupedComps[i];
      // Skip if comp already has explicit coords (from "Geographic Location" field)
      if (c.latitude != null && c.longitude != null) {
        console.log(`[chunked] ${c.property_name}: using explicit doc coords (${c.latitude}, ${c.longitude})`);
        continue;
      }
      try {
        const located = await autoLocateInBrowserLogged(c);
        if (located) {
          dedupedComps[i] = {
            ...c,
            latitude: located.latitude,
            longitude: located.longitude,
            parcel_id: located.parcel_id ?? c.parcel_id,
            geometry: located.geometry,
            _auto_located_confidence: located.match_confidence,
          };
        }
      } catch (e) {
        console.error(`[chunked] autoLocate failed for ${c.property_name}:`, e);
      }
    }

    // Build diagnostic summary message — shows per-chunk counts so we can
    // see EXACTLY where extraction succeeded/failed across the document.
    const chunkBreakdown = perChunkCounts.length > 0
      ? `\n\nPer-chunk: ${perChunkCounts.map((n, i) => {
          const sp = i * STRIDE + 1;
          const ep = Math.min(i * STRIDE + CHUNK_SIZE, images.length);
          return `pp${sp}-${ep}: ${n}${perChunkMessages[i] && n === 0 ? ` (${perChunkMessages[i]})` : ''}`;
        }).join(' · ')}`
      : '';

    const summary = dedupedComps.length === 0
      ? errorCount > 0
        ? `Extraction failed for ${errorCount} of ${chunks.length} chunks. No comps recovered.${chunkBreakdown}`
        : `No comps extracted from ${chunks.length} chunks across ${images.length} pages. AI didn't recognize comp structure.${chunkBreakdown}`
      : `Extracted ${dedupedComps.length} comp${dedupedComps.length === 1 ? '' : 's'} from ${images.length} pages${errorCount > 0 ? ` (${errorCount} chunk${errorCount === 1 ? '' : 's'} errored)` : ''}.${chunkBreakdown}`;

    const assistantMessage: Message = {
      role: 'assistant',
      content: summary,
      comps: dedupedComps,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, assistantMessage]);

    if (dedupedComps.length > 0) {
      setPendingComps(prev => [...prev, ...dedupedComps]);
      toast.success(`Found ${dedupedComps.length} comp${dedupedComps.length === 1 ? '' : 's'}`, { duration: 4000 });
    } else {
      toast.error('No comps extracted from this document');
    }
  };

  const handleFileUpload = async (file: File) => {
    if (!file) return;
    setLoading(true);

    try {
      // PDFs: render pages client-side and send as images for vision extraction.
      // Images (jpg/png): pass straight through as a single-image array.
      if (file.type === 'application/pdf') {
        toast.loading('Rendering PDF pages…', { id: 'pdf-render' });
        // Higher quality now that we chunk — no token-budget worry per call
        const images = await pdfToImages(file, { scale: 1.5, maxPages: 60 });
        toast.dismiss('pdf-render');
        if (images.length === 0) {
          toast.error('Could not render PDF');
          return;
        }
        // For PDFs with >5 pages: chunked extraction (5 pages per AI call,
        // accumulate + dedupe comps from each chunk). Single-shot extraction
        // hits GPT-4o's input limit on large appraisal reports (20+ pages)
        // and returns "no comps" even when comps exist.
        if (images.length > 5) {
          await extractFromChunkedPdf(file, images);
          return;
        }
        await sendMessage(`Uploaded: ${file.name} (${images.length} pages)`, undefined, images);
        return;
      }

      if (file.type.startsWith('image/')) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        await sendMessage(`Uploaded: ${file.name}`, undefined, [dataUrl]);
        return;
      }

      // Fallback to server-side text parsing for other formats
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/parse-pdf', { method: 'POST', body: formData });
      const data = await response.json();
      if (data.text) {
        await sendMessage(`Uploaded: ${file.name}`, data.text);
      } else {
        toast.error('Could not read document');
      }
    } catch (err: any) {
      toast.dismiss('pdf-render');
      toast.error(err?.message || 'Failed to upload file');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!input.trim() || loading) return;
    await sendMessage(input.trim());
  };

  const saveComp = async (comp: ExtractedComp) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase.from('comps').insert({
      created_by: user.id,
      property_name: comp.property_name,
      county: comp.county || '',
      state: comp.state || 'TX',
      acres: comp.acres || 0,
      sale_price: comp.sale_price || 0,
      improvements_value: comp.improvements_value,
      sale_date: comp.sale_date,
      address: comp.address,
      latitude: comp.latitude,
      longitude: comp.longitude,
      parcel_id: comp.parcel_id,
      recording_number: comp.recording_number,
      grantor: comp.grantor,
      grantee: comp.grantee,
      financing: comp.financing,
      minerals_sold: comp.minerals_sold,
      confirmation_source: comp.confirmation_source,
      description: comp.description,
      water: comp.water || 'None',
      road_frontage: comp.road_frontage || 'None',
      has_improvements: comp.has_improvements || false,
      improvements_notes: comp.improvements_notes,
      wildlife_notes: comp.wildlife_notes,
      flood_plain_pct: comp.flood_plain_pct,
      status: 'Sold',
      visibility: 'team',
      confidence: comp.confidence.overall > 80 ? 'Verified' : comp.confidence.overall > 50 ? 'Estimated' : 'Unverified',
      boundary_geojson: (comp as any).geometry ?? null,
      // Carry the math-identity-gate flag through to the row so the vault
      // UI can show its warning badge. False (default) if the gate passed
      // or couldn't run (one of price/ppa/acres was missing).
      needs_extraction_review: comp.needs_extraction_review || false,
    });

    if (error) {
      toast.error('Failed to save comp');
    } else {
      const label = comp.property_name || `${comp.county || 'Comp'}`;
      if (comp.latitude != null && comp.longitude != null) {
        toast.success(
          (t) => (
            <span>
              {label} added to vault.{' '}
              <button
                onClick={() => {
                  toast.dismiss(t.id);
                  router.push(`/dashboard/map?focus=${comp.latitude},${comp.longitude},14`);
                }}
                className="underline font-bold text-sage"
              >
                View on map →
              </button>
            </span>
          ),
          { duration: 6000 }
        );
      } else {
        toast.success(`${label} added to vault!`);
      }
      setPendingComps(prev => prev.filter(c => c !== comp));
    }
  };

  const saveAllComps = async () => {
    for (const comp of pendingComps) {
      await saveComp(comp);
    }
  };

  // Drag-and-drop handlers — accept PDFs + images, ignore everything else.
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
      setIsDraggingOver(true);
    }
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDraggingOver(false);
    }
  };
  const handleDragOver = (e: React.DragEvent) => {
    // Required to enable drop behavior.
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    dragCounterRef.current = 0;
    const files = Array.from(e.dataTransfer?.files || []).filter(
      (f) => f.type === 'application/pdf' || f.type.startsWith('image/')
    );
    const skipped = (e.dataTransfer?.files?.length ?? 0) - files.length;
    if (skipped > 0) {
      toast(`Skipped ${skipped} non-PDF/image file${skipped === 1 ? '' : 's'}`, { icon: '⚠️', duration: 4000 });
    }
    if (files.length > 0) handleMultipleFiles(files);
  };

  return (
    <div className="flex h-full bg-night">
      {/* Chat area — drag-and-drop is wired here so PDFs can be dropped
          anywhere in this column. Drop overlay sits on top when dragging. */}
      <div
        className="flex-1 flex flex-col relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drag-over overlay — covers the chat column with a dashed sage
            border + drop affordance. Pointer-events-none so the drop event
            still hits the wrapper underneath. */}
        {isDraggingOver && (
          <div className="absolute inset-0 z-50 bg-sage/10 backdrop-blur-sm border-4 border-dashed border-sage rounded-lg flex items-center justify-center pointer-events-none">
            <div className="text-center px-6">
              <Upload size={56} className="text-sage mx-auto mb-3" />
              <p className="text-xl font-bold text-sage">Drop PDFs to import</p>
              <p className="text-sm text-slate-300 mt-2">Multiple files supported · PDF or image</p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex-shrink-0 bg-panel border-b border-border px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-sage/10 border border-sage/20 flex items-center justify-center">
            <FileText size={15} className="text-sage" />
          </div>
          <div>
            <h1 className="font-bold text-sm">Import Comps</h1>
            <p className="text-xs text-slate-500">Upload PDF, paste text, or describe a property</p>
          </div>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-card border border-border rounded-lg text-xs font-bold text-slate-300 hover:text-white hover:border-sage transition-colors"
            >
              <Upload size={12} />
              Upload PDFs
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length > 0) handleMultipleFiles(files);
                // Reset so the user can re-pick the same files later if needed.
                if (e.target) e.target.value = '';
              }}
            />
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                msg.role === 'user'
                  ? 'bg-sage/10 border border-sage/20 text-white'
                  : 'bg-card border border-border text-slate-200'
              }`}>
                {msg.role === 'assistant' && (
                  <div className="flex items-center gap-1.5 mb-2">
                    <div className="w-4 h-4 rounded bg-sage/20 flex items-center justify-center">
                      <span className="text-sage text-[8px] font-bold">AI</span>
                    </div>
                    <span className="text-xs font-bold text-sage">Landstack AI</span>
                  </div>
                )}
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>

                {/* Extracted comps */}
                {msg.comps && msg.comps.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {msg.comps.map((comp, ci) => (
                      <div key={ci} className="bg-night border border-border rounded-xl p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1">
                            <p className="text-sm font-bold text-white">
                              {comp.property_name || `${comp.county} County — ${comp.acres} ac`}
                            </p>
                            <p className="text-xs text-slate-400 mt-0.5">
                              {comp.county}, {comp.state} · {comp.acres} acres
                            </p>
                            <div className="flex items-center gap-3 mt-1.5">
                              <span className="text-emerald-400 font-mono text-xs font-bold">
                                ${comp.sale_price?.toLocaleString()}
                              </span>
                              {comp.ppa_land_only && (
                                <span className="text-emerald-400 font-mono text-xs">
                                  ${Math.round(comp.ppa_land_only).toLocaleString()}/ac (land)
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <div className={`w-2 h-2 rounded-full ${
                              comp.confidence.overall >= 80 ? 'bg-emerald-400' :
                              comp.confidence.overall >= 50 ? 'bg-amber-400' : 'bg-red-400'
                            }`} />
                            <span className="text-xs text-slate-500">{comp.confidence.overall}%</span>
                          </div>
                        </div>
                        <button
                          onClick={() => saveComp(comp)}
                          className="mt-2 w-full py-1.5 bg-sage/10 hover:bg-sage/20 border border-sage/20 text-sage rounded-lg text-xs font-bold transition-colors"
                        >
                          + Add to Vault
                        </button>
                      </div>
                    ))}

                    {msg.comps.length > 1 && (
                      <button
                        onClick={saveAllComps}
                        className="w-full py-2 bg-sage hover:bg-sage2 text-black rounded-xl text-xs font-bold transition-colors"
                      >
                        Add All {msg.comps.length} Comps to Vault
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-card border border-border rounded-2xl px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded bg-sage/20 flex items-center justify-center">
                    <span className="text-sage text-[8px] font-bold">AI</span>
                  </div>
                  <div className="flex gap-1">
                    <div className="w-1.5 h-1.5 bg-sage rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-1.5 h-1.5 bg-sage rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-1.5 h-1.5 bg-sage rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="flex-shrink-0 bg-panel border-t border-border p-3">
          <div className="flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-2.5 bg-card border border-border rounded-xl text-slate-400 hover:text-sage hover:border-sage transition-colors flex-shrink-0"
            >
              <Upload size={16} />
            </button>
            <div className="flex-1 relative">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder="Paste appraisal text, describe a sale, or ask a question..."
                rows={1}
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-sage transition-colors resize-none"
                style={{ minHeight: '42px', maxHeight: '120px' }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = 'auto';
                  target.style.height = Math.min(target.scrollHeight, 120) + 'px';
                }}
              />
            </div>
            <button
              onClick={handleSubmit}
              disabled={loading || !input.trim()}
              className="p-2.5 bg-sage hover:bg-sage2 text-black rounded-xl transition-colors flex-shrink-0 disabled:opacity-50"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="text-[10px] text-slate-600 mt-1.5 text-center">
            Paste from email, upload PDF, or take a photo · Press Enter to send
          </p>
        </div>
      </div>
    </div>
  );
}

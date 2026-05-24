'use client';

// Receiver page for the "Save to Landstack" browser bookmarklet.
//
// Flow:
//   1. Broker is on a listing page (Land.com, Lands of America, etc.)
//   2. Clicks the bookmarklet → extraction script runs in their tab
//   3. Script base64-encodes the extracted payload and opens
//      https://landstackai.vercel.app/import-from-bookmarklet#data=<b64>
//   4. This page (under the broker's authenticated Supabase session)
//      decodes the hash, POSTs to /api/import-url with the pre-fetched
//      payload, and shows the verification card.
//   5. Broker confirms / fixes fields / navigates back to listing.
//
// Why a separate route instead of just hitting /api/import-bookmarklet
// directly from the script: avoids CORS plumbing and API tokens. The
// browser tab opens to landstackai.vercel.app — the same origin we
// POST to — so the broker's existing session cookies flow naturally.
// No new auth surface to secure.
//
// The data lives in the URL HASH (not query string) so it's never sent
// in the navigation request to our server. Only when this page's JS
// reads window.location.hash and POSTs deliberately does the data
// leave the broker's machine.

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import toast from 'react-hot-toast';
import { Loader2, CheckCircle, AlertCircle, ExternalLink } from 'lucide-react';

type IngestState =
  | { kind: 'parsing' }
  | { kind: 'extracting'; hostname: string }
  | { kind: 'saving'; comp: any }
  | { kind: 'success'; comp: any; savedId: string | null }
  | { kind: 'error'; message: string; hint?: string };

export default function ImportFromBookmarklet() {
  const router = useRouter();
  const supabase = createClient();
  const [state, setState] = useState<IngestState>({ kind: 'parsing' });
  // StrictMode + React 18 double-effect guard: the receiver must
  // process the hash exactly once. If we re-run, the comp gets
  // double-saved.
  const processedRef = useRef(false);

  useEffect(() => {
    if (processedRef.current) return;
    processedRef.current = true;

    (async () => {
      // Step 1: decode the hash payload
      const hash = typeof window !== 'undefined' ? window.location.hash : '';
      const match = hash.match(/data=([^&]+)/);
      if (!match) {
        setState({
          kind: 'error',
          message: 'No payload in URL.',
          hint: 'This page expects to be opened by the Save to Landstack bookmarklet. Try clicking the bookmarklet again on a listing page.',
        });
        return;
      }

      let payload: any;
      try {
        const decoded = decodeURIComponent(escape(atob(decodeURIComponent(match[1]))));
        payload = JSON.parse(decoded);
      } catch (e) {
        setState({
          kind: 'error',
          message: 'Could not decode payload.',
          hint: 'The bookmarklet data was malformed. Try clicking the bookmarklet again.',
        });
        return;
      }

      // Step 2: check auth — if not signed in, send to login with a
      // returnTo so they come back here. Hash data survives the
      // redirect on most browsers.
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session) {
        toast.error('Please sign in to save this listing');
        const returnUrl = window.location.pathname + window.location.hash;
        router.push(`/auth/login?redirectedFrom=${encodeURIComponent(returnUrl)}`);
        return;
      }

      // Step 3: POST to /api/import-url with the bookmarklet payload
      const hostname = String(payload?.hostname || 'unknown');
      setState({ kind: 'extracting', hostname });
      try {
        const res = await fetch('/api/import-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: payload?.url || '',
            bookmarklet_payload: payload,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data?.ok || !data?.comp) {
          setState({
            kind: 'error',
            message: data?.error || 'Extraction failed',
            hint: data?.hint,
          });
          return;
        }

        // Step 4: save the comp via direct Supabase insert. Reuses
        // the same shape the import page uses for auto-save. We do
        // this here (vs. routing through the import page) so the
        // broker sees the success state immediately without an
        // extra navigation.
        setState({ kind: 'saving', comp: data.comp });
        const c = data.comp;
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          setState({ kind: 'error', message: 'Not signed in' });
          return;
        }
        const { data: inserted, error: insertErr } = await supabase
          .from('comps')
          .insert({
            created_by: user.id,
            property_name: c.property_name,
            county: c.county || '',
            state: c.state || 'TX',
            acres: c.acres || 0,
            sale_price: c.sale_price || 0,
            improvements_value: c.improvements_value,
            sale_date: c.sale_date,
            address: c.address,
            latitude: c.latitude,
            longitude: c.longitude,
            description: c.description,
            grantor: c.grantor,
            grantee: c.grantee,
            water: c.water || 'None',
            road_frontage: c.road_frontage || 'None',
            has_improvements: c.has_improvements || false,
            improvements_notes: c.improvements_notes,
            source_url: c.source_url || payload?.url || null,
            source_type: 'listing_url',
            status: 'Sold',
            visibility: 'team',
            confidence: 'Estimated',
            needs_location_review: true,
            needs_extraction_review: true,
          })
          .select('id')
          .single();
        if (insertErr || !inserted) {
          setState({
            kind: 'error',
            message: insertErr?.message || 'Could not save comp',
            hint: 'The data was extracted but saving to your vault failed. Try clicking the bookmarklet again or paste the listing text into Import manually.',
          });
          return;
        }
        toast.success('Saved to your vault under Needs Review');
        setState({ kind: 'success', comp: c, savedId: inserted.id });
      } catch (e: any) {
        setState({ kind: 'error', message: e?.message || 'Network error' });
      }
    })();
  }, [router, supabase]);

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white border border-beige rounded-2xl shadow-sm p-6 space-y-4">
        {state.kind === 'parsing' && (
          <>
            <div className="flex items-center gap-3">
              <Loader2 size={20} className="text-olive-2 animate-spin" />
              <p className="font-semibold text-ink">Reading bookmarklet data…</p>
            </div>
            <p className="text-sm text-ink-2 leading-relaxed">
              Decoding the listing info you captured.
            </p>
          </>
        )}

        {state.kind === 'extracting' && (
          <>
            <div className="flex items-center gap-3">
              <Loader2 size={20} className="text-olive-2 animate-spin" />
              <p className="font-semibold text-ink">Extracting from {state.hostname}…</p>
            </div>
            <p className="text-sm text-ink-2 leading-relaxed">
              Pulling property details out of the page content.
            </p>
          </>
        )}

        {state.kind === 'saving' && (
          <>
            <div className="flex items-center gap-3">
              <Loader2 size={20} className="text-olive-2 animate-spin" />
              <p className="font-semibold text-ink">Saving to your vault…</p>
            </div>
          </>
        )}

        {state.kind === 'success' && (
          <>
            <div className="flex items-center gap-3">
              <CheckCircle size={20} className="text-olive-2" />
              <p className="font-semibold text-ink">Saved!</p>
            </div>
            <div className="bg-cream rounded-lg p-3 space-y-1">
              <p className="text-sm font-semibold text-ink">
                {state.comp.property_name || 'Untitled listing'}
              </p>
              <p className="text-xs text-ink-2 font-mono">
                {[
                  state.comp.county,
                  state.comp.acres ? `${state.comp.acres} ac` : null,
                  state.comp.sale_price ? `$${Number(state.comp.sale_price).toLocaleString()}` : null,
                ].filter(Boolean).join(' · ')}
              </p>
            </div>
            <p className="text-sm text-ink-2 leading-relaxed">
              Saved to your vault under <span className="font-semibold">Needs Review</span> — listings come in partial, so you'll want to verify and add the missing fields (sale date, grantor/grantee) once the deal closes.
            </p>
            <div className="flex gap-2 pt-2">
              {state.savedId && (
                <button
                  onClick={() => router.push(`/dashboard/review/${state.savedId}`)}
                  className="flex-1 py-2 bg-olive hover:bg-olive-2 text-white rounded-lg text-sm font-bold transition-colors"
                >
                  Review now
                </button>
              )}
              <button
                onClick={() => router.push('/dashboard/vault')}
                className="flex-1 py-2 bg-cream border border-beige hover:border-olive text-ink-2 hover:text-ink rounded-lg text-sm font-bold transition-colors"
              >
                Open vault
              </button>
            </div>
            <p className="text-[11px] text-ink-3 italic text-center pt-1">
              You can close this tab and continue browsing.
            </p>
          </>
        )}

        {state.kind === 'error' && (
          <>
            <div className="flex items-center gap-3">
              <AlertCircle size={20} className="text-red-600" />
              <p className="font-semibold text-ink">Couldn't save</p>
            </div>
            <p className="text-sm text-ink-2 leading-relaxed">
              {state.message}
            </p>
            {state.hint && (
              <p className="text-xs text-ink-3 leading-relaxed border-l-2 border-beige pl-3">
                {state.hint}
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <a
                href="/dashboard/import"
                className="flex-1 py-2 bg-olive hover:bg-olive-2 text-white rounded-lg text-sm font-bold text-center transition-colors flex items-center justify-center gap-1.5"
              >
                <ExternalLink size={14} />
                Try Import manually
              </a>
              <button
                onClick={() => window.close()}
                className="flex-1 py-2 bg-cream border border-beige hover:border-olive text-ink-2 hover:text-ink rounded-lg text-sm font-bold transition-colors"
              >
                Close tab
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

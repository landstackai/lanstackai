'use client';

// Bookmarklet setup page.
//
// Brokers drag the "Save to Landstack" button to their browser's
// bookmarks bar. After that, on any listing page (Land.com, Lands of
// America, LandWatch, county GIS, even Zillow / Realtor.com), one
// click → comp lands in vault under Needs Review.
//
// The bookmarklet itself is a tiny loader (~200 chars) that fetches
// the actual extraction script from /api/bookmarklet on each click.
// That keeps the bookmark URL short AND lets us push extractor
// updates without asking brokers to re-drag a new bookmarklet.
//
// Why drag instead of click: bookmarklet URLs use the `javascript:`
// scheme. Clicking a `javascript:` link runs the script on the
// LANDSTACK page (useless — we want it to run on listing sites).
// Dragging the link to the bookmarks bar saves it as a bookmark
// the broker can invoke from any tab.

import { useState, useEffect } from 'react';
import { BookmarkPlus, ExternalLink, Copy, Check, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';

export default function BookmarkletSetupPage() {
  const [copied, setCopied] = useState(false);
  const [appHost, setAppHost] = useState('');

  useEffect(() => {
    // Resolve the host at runtime so dev / staging / prod all generate
    // the right script URL. Server-rendered <a href> can't see
    // window.location, so we defer to useEffect.
    setAppHost(window.location.origin);
  }, []);

  // The bookmarklet — a single line that dynamically loads the actual
  // extraction script. The `t=` param busts any cache so brokers get
  // the latest extractor logic every time they click.
  const bookmarkletCode = appHost
    ? `javascript:(function(){var s=document.createElement('script');s.src='${appHost}/api/bookmarklet?t='+Date.now();document.body.appendChild(s);})();`
    : '';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(bookmarkletCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('Bookmarklet copied to clipboard');
    } catch {
      toast.error('Copy failed — drag the button instead');
    }
  };

  return (
    <div className="min-h-screen bg-cream">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        {/* Header */}
        <div className="space-y-2">
          <p className="text-[11px] font-bold text-ink-3 uppercase tracking-wider">Settings</p>
          <h1 className="text-2xl font-semibold text-ink tracking-tight">Save to Landstack — Bookmarklet</h1>
          <p className="text-sm text-ink-2 leading-relaxed max-w-2xl">
            A one-click way to save any listing from <strong>Land.com</strong>, <strong>Lands of America</strong>, <strong>LandWatch</strong>, Zillow, Realtor.com, county GIS sites, or anywhere else — straight to your Landstack vault. Works on sites that block our regular URL import.
          </p>
        </div>

        {/* THE DRAG BUTTON */}
        <div className="bg-white border border-beige rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <BookmarkPlus size={18} className="text-olive-2" />
            <h2 className="text-base font-bold text-ink">Drag this button to your bookmarks bar</h2>
          </div>

          {/* Bookmarks bar drop target */}
          <div className="bg-cream-2/50 border border-dashed border-beige-2 rounded-xl p-6 text-center space-y-3">
            {appHost ? (
              <a
                href={bookmarkletCode}
                onClick={(e) => {
                  // Clicking a javascript: link inside Landstack runs
                  // the bookmarklet's loader on this page — not what
                  // the broker wants. Block the click and explain.
                  e.preventDefault();
                  toast('Drag the button to your bookmarks bar instead — clicking it here doesn\'t do anything useful.', { icon: '👆', duration: 4500 });
                }}
                draggable={true}
                className="inline-flex items-center gap-2 px-5 py-3 bg-olive hover:bg-olive-2 text-white rounded-lg text-sm font-bold transition-colors cursor-grab active:cursor-grabbing shadow-sm"
                title="Drag me to your bookmarks bar"
              >
                <BookmarkPlus size={15} />
                Save to Landstack
              </a>
            ) : (
              <div className="inline-flex items-center gap-2 px-5 py-3 bg-cream border border-beige text-ink-3 rounded-lg text-sm font-bold">
                Loading…
              </div>
            )}
            <p className="text-xs text-ink-3">
              Drag the button up to your <span className="font-mono">Bookmarks Bar</span>. If you don't see it: View menu → Show Bookmarks Bar (or <span className="font-mono">⇧⌘B</span>).
            </p>
          </div>

          {/* Manual copy fallback for browsers that block javascript: links */}
          <details className="bg-cream-2/40 border border-beige rounded-lg overflow-hidden">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-ink-2 hover:text-ink select-none">
              Drag not working? Add manually →
            </summary>
            <div className="p-3 pt-1 space-y-2 text-xs text-ink-2 leading-relaxed">
              <ol className="space-y-1 list-decimal list-inside">
                <li>Right-click your bookmarks bar → <strong>Add Bookmark</strong> (or <span className="font-mono">⌘D</span> on a blank tab)</li>
                <li>Name: <strong>Save to Landstack</strong></li>
                <li>URL: paste the code below</li>
              </ol>
              <div className="flex items-stretch gap-2">
                <code className="flex-1 bg-white border border-beige rounded p-2 text-[10px] font-mono break-all max-h-20 overflow-y-auto text-ink">
                  {bookmarkletCode || 'Loading…'}
                </code>
                <button
                  onClick={handleCopy}
                  disabled={!bookmarkletCode}
                  className="px-3 bg-cream border border-beige hover:border-olive rounded text-xs font-semibold text-ink-2 hover:text-ink transition-colors disabled:opacity-40 flex items-center gap-1.5"
                >
                  {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
                </button>
              </div>
            </div>
          </details>
        </div>

        {/* How to use */}
        <div className="bg-white border border-beige rounded-2xl p-6 shadow-sm space-y-4">
          <h2 className="text-base font-bold text-ink">How to use it</h2>
          <ol className="space-y-3 text-sm text-ink-2 leading-relaxed">
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-olive-tint border border-olive-border text-olive-2 font-bold text-xs flex items-center justify-center">1</span>
              <div>
                Visit a listing page —{' '}
                <a href="https://www.landsofamerica.com/" target="_blank" rel="noopener" className="text-olive-2 underline">Lands of America</a>,{' '}
                <a href="https://www.land.com/" target="_blank" rel="noopener" className="text-olive-2 underline">Land.com</a>,{' '}
                <a href="https://www.landwatch.com/" target="_blank" rel="noopener" className="text-olive-2 underline">LandWatch</a>, brokerage site, MLS portal, county GIS — anywhere you can see the property.
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-olive-tint border border-olive-border text-olive-2 font-bold text-xs flex items-center justify-center">2</span>
              <div>
                Click <strong>Save to Landstack</strong> in your bookmarks bar.
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-olive-tint border border-olive-border text-olive-2 font-bold text-xs flex items-center justify-center">3</span>
              <div>
                A new tab opens with the extracted comp. It's already saved to your vault under <strong>Needs Review</strong>. Verify the fields, then close the tab and keep browsing.
              </div>
            </li>
          </ol>
        </div>

        {/* Why this works where URL import doesn't */}
        <div className="bg-cream-2/50 border border-beige rounded-xl p-5 space-y-2">
          <h3 className="text-sm font-bold text-ink">Why the bookmarklet works where URL paste doesn't</h3>
          <p className="text-xs text-ink-2 leading-relaxed">
            Land.com, Lands of America, and LandWatch are JavaScript-rendered — the listing data isn't in the HTML until your browser runs the page's scripts. When you click the bookmarklet, the extraction runs <em>inside your browser tab</em> on the page you're already viewing, so it sees the same fully-rendered content you do. It also uses your existing browser session, so it works on private MLS portals where Landstack alone can't reach.
          </p>
        </div>

        {/* Limitations honesty box */}
        <div className="bg-amber-50/40 border border-amber-200 rounded-xl p-5 space-y-2">
          <h3 className="text-sm font-bold text-ink">Honest about what it captures</h3>
          <p className="text-xs text-ink-2 leading-relaxed">
            Listings are marketing copy, not deed records. You'll get the property name, acres, asking price, address, description, and photos. You <em>won't</em> get sale_date, grantor, or grantee — those come from the closing documents and you'll fill them in once the deal closes. Confidence is capped at 65% so the comp doesn't enter your vault as Verified.
          </p>
        </div>
      </div>
    </div>
  );
}

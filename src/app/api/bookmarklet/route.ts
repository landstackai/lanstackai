import { NextResponse } from 'next/server';

// GET /api/bookmarklet
//
// Returns a JavaScript file that runs inside the broker's browser tab
// when they click the "Save to Landstack" bookmarklet. The bookmarklet
// itself (the thing they drag to their bookmarks bar) is a tiny loader:
//
//   javascript:(function(){var s=document.createElement('script');
//     s.src='https://landstackai.vercel.app/api/bookmarklet?t='+Date.now();
//     document.body.appendChild(s)})()
//
// Keeping the actual extraction logic on the server means we can update
// site-specific scrapers without asking the broker to re-drag a new
// bookmarklet every time.
//
// What this script does when it runs:
//   1. Detects the current site (URL hostname)
//   2. Runs site-specific DOM extractors that pull structured data
//      from the rendered page (price, acres, address, photos, etc.)
//   3. Falls back to generic extractors (OpenGraph, JSON-LD,
//      __NEXT_DATA__) for sites without custom mappings
//   4. Opens a new tab to /import-from-bookmarklet with the extracted
//      payload encoded in the URL hash
//   5. That receiver page (under the broker's authenticated session)
//      runs the data through the existing AI extraction + auto-save
//      pipeline (same as PDF / URL imports — PR #45/#46)
//
// Why a popup instead of inline POST: CORS. The bookmarklet runs on
// lands.com / landwatch.com / wherever — cross-origin POSTs need the
// receiver to allow that origin. Opening a tab on landstackai.vercel.app
// lets the page POST same-origin to /api/import-url using the broker's
// existing Supabase session — no CORS plumbing, no API tokens.

export async function GET() {
  // Resolve the production host for the popup URL. We can't always
  // trust window.location at script-eval time (could be data: or
  // about:blank in edge cases), so the popup target is baked into
  // the served script.
  const APP_HOST = process.env.NEXT_PUBLIC_APP_URL || 'https://landstackai.vercel.app';

  const script = `
(function() {
  var APP_HOST = ${JSON.stringify(APP_HOST)};

  // Visual feedback: small overlay while we work. The bookmarklet
  // runs on third-party sites, so we keep the overlay neutral — no
  // landstack branding visible to anyone watching over the broker's
  // shoulder.
  var overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;top:20px;right:20px;z-index:2147483647;' +
    'background:#1A1815;color:#F5F1E8;padding:12px 18px;' +
    'border-radius:8px;font:13px/1.4 -apple-system,system-ui,sans-serif;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:280px;';
  overlay.textContent = 'Reading listing…';
  document.body.appendChild(overlay);

  function done(msg, ok) {
    overlay.textContent = msg;
    overlay.style.background = ok ? '#5C6B3E' : '#8B2C1A';
    setTimeout(function() { overlay.remove(); }, 3000);
  }

  // ── Site-specific extractors ───────────────────────────────────────
  // Each extractor returns a partial comp object (any fields it can
  // find) or null if the page doesn't match. Sites we haven't mapped
  // fall through to extractGeneric below, which is good enough for
  // most.

  // Generic extractor — works across most modern listing sites by
  // looking at common structured-data sources in order:
  //   1. __NEXT_DATA__ (Next.js sites leak full props here)
  //   2. JSON-LD schema.org blocks (REQUIRED by Google for indexing,
  //      so most polished listing sites include them)
  //   3. OpenGraph meta tags (social-share metadata, widely supported)
  //   4. Common itemprop / data-testid CSS selectors
  //   5. document.body.innerText for AI fallback
  function extractGeneric() {
    var result = { _source: 'generic' };

    // Next.js leak — full page props in a single <script id="__NEXT_DATA__">
    var nextData = document.getElementById('__NEXT_DATA__');
    if (nextData && nextData.textContent) {
      try {
        result._next_data = JSON.parse(nextData.textContent);
      } catch (e) {}
    }

    // JSON-LD blocks
    var jsonLd = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function(el) {
      try { jsonLd.push(JSON.parse(el.textContent || '')); } catch (e) {}
    });
    if (jsonLd.length > 0) result._json_ld = jsonLd;

    // OpenGraph
    var og = {};
    document.querySelectorAll('meta[property^="og:"]').forEach(function(el) {
      var prop = el.getAttribute('property');
      var content = el.getAttribute('content');
      if (prop && content) og[prop] = content;
    });
    if (Object.keys(og).length > 0) result._opengraph = og;

    // Standard meta description / keywords / title
    result.page_title = document.title || '';
    var desc = document.querySelector('meta[name="description"]');
    if (desc) result.meta_description = desc.getAttribute('content') || '';

    // Common itemprops + data-testids that listing sites use
    var probes = [
      ['price', '[itemprop="price"],[data-testid*="price"i]'],
      ['address', '[itemprop="address"],[data-testid*="address"i]'],
      ['acres', '[data-testid*="acre"i],[data-testid*="lot-size"i]'],
    ];
    probes.forEach(function(p) {
      var el = document.querySelector(p[1]);
      if (el) result['probe_' + p[0]] = (el.textContent || '').trim().slice(0, 200);
    });

    // Page text — the AI's fallback signal when nothing structured
    // is available. Strip scripts/styles/nav first via a copy.
    var clone = document.body.cloneNode(true);
    ['script','style','noscript','svg','iframe','nav','header','footer'].forEach(function(tag) {
      clone.querySelectorAll(tag).forEach(function(el) { el.remove(); });
    });
    var text = (clone.innerText || clone.textContent || '').replace(/\\s+/g, ' ').trim();
    result.page_text = text.slice(0, 12000); // cap to keep payload small

    return result;
  }

  // Site-specific tweaks layer ON TOP of the generic extractor. They
  // pull richer signals where the DOM is predictable.
  function extractLandsOfAmerica() {
    var data = extractGeneric();
    data._source = 'landsofamerica';
    // LoA puts listing detail in JSON-LD or in window.__APOLLO_STATE__
    // — both are caught by extractGeneric. Site-specific tweaks
    // (richer photo URLs, broker contact, etc.) can be added here as
    // we hit edge cases.
    return data;
  }
  function extractLandDotCom() {
    var data = extractGeneric();
    data._source = 'land.com';
    return data;
  }
  function extractLandWatch() {
    var data = extractGeneric();
    data._source = 'landwatch';
    return data;
  }
  function extractZillow() {
    var data = extractGeneric();
    data._source = 'zillow';
    return data;
  }
  function extractRealtor() {
    var data = extractGeneric();
    data._source = 'realtor.com';
    return data;
  }

  // ── Dispatch on hostname ───────────────────────────────────────────
  var host = (window.location.hostname || '').toLowerCase();
  var payload;
  try {
    if (host.indexOf('landsofamerica.com') !== -1) {
      payload = extractLandsOfAmerica();
    } else if (host.indexOf('land.com') !== -1) {
      payload = extractLandDotCom();
    } else if (host.indexOf('landwatch.com') !== -1) {
      payload = extractLandWatch();
    } else if (host.indexOf('zillow.com') !== -1) {
      payload = extractZillow();
    } else if (host.indexOf('realtor.com') !== -1) {
      payload = extractRealtor();
    } else {
      payload = extractGeneric();
    }
  } catch (e) {
    done('Extraction failed: ' + (e && e.message ? e.message : 'unknown'), false);
    return;
  }

  payload.url = window.location.href;
  payload.hostname = host;

  // Hand off to the receiver page via a new tab. The hash carries the
  // payload — base64-encoded so URL-special chars don't break parsing.
  // Hashes are NOT sent to the server during navigation, so the data
  // never leaves the broker's machine until the receiver page POSTs
  // it deliberately.
  try {
    var encoded;
    try {
      encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    } catch (e) {
      done('Payload too large to encode', false);
      return;
    }
    var receiverUrl = APP_HOST + '/import-from-bookmarklet#data=' + encoded;
    window.open(receiverUrl, '_blank');
    done('Opening Landstack…', true);
  } catch (e) {
    done('Could not open Landstack tab — popup blocked?', false);
  }
})();
`;

  return new NextResponse(script, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Allow the script to be loaded from any origin (it's served
      // from landstackai.vercel.app and consumed on listing sites).
      'Access-Control-Allow-Origin': '*',
      // Browsers cache <script src> for the page lifetime by default;
      // tell them not to so we can push extractor updates without
      // brokers having to re-drag the bookmarklet.
      'Cache-Control': 'no-store, must-revalidate',
    },
  });
}

#!/usr/bin/env python3
"""
Backfill auto listing matches for comps that have no source_url.

    python3 scripts/backfill-listing-match.py            # DRY RUN — search + report only
    python3 scripts/backfill-listing-match.py --apply    # write results per confidence tier

Mirrors /api/comp/[id]/find-listing auto mode (keep the rules in sync
with that route):
    high   → source_url + listing_match_confidence='high_auto'
    medium → suggested_listing_url + 'medium_suggested' (agent confirms in UI)
    none   → nothing written

Writes only fill EMPTY fields — a comp that already has source_url is
skipped entirely, so this can never clobber broker-entered links.

Cost: ~$0.25/comp (claude-opus-5-5 + web search). ~68 comps ≈ $17.
"""

import os
import sys
import re
import json
import time
import urllib.request
import psycopg2
from concurrent.futures import ThreadPoolExecutor, as_completed

MODEL = 'claude-opus-5-5'
URL_OK = re.compile(r'https?://(?:[a-z0-9-]+\.)*(zillow|realtor|land|landsofamerica|landwatch|westandswoperanches)\.com/[^\s)\]]+', re.I)


def load_env():
    env = {}
    with open(os.path.join(os.path.dirname(__file__), '..', '.env.local')) as f:
        for line in f:
            line = line.strip()
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                env[k] = v.strip().strip('"\'')
    return env


def pooler_url(env):
    db_url = env['SUPABASE_DB_URL']
    m = re.match(r'^postgresql://postgres:([^@]+)@db\.([^.]+)\.supabase\.co:5432/postgres', db_url)
    if m:
        pwd, ref = m.group(1), m.group(2)
        return f'postgresql://postgres.{ref}:{pwd}@aws-1-us-east-1.pooler.supabase.com:5432/postgres'
    return db_url


def build_prompt(row):
    (_id, name, addr, county, state, acres, price, date, grantor, grantee, desc) = row
    facts = ', '.join([x for x in [
        name, addr,
        f'{county} County' if county else None,
        state or 'TX',
        f'{float(acres):,.0f} acres' if acres else None,
        f'sold for approximately ${float(price):,.0f}' if price else None,
        f'around {date}' if date else None,
    ] if x])
    parties = ' · '.join([x for x in [
        f'Sold by: {grantor}' if grantor else None,
        f'Bought by: {grantee}' if grantee else None,
    ] if x])
    description = (desc or '')[:1200]
    return f"""Find a real estate listing on one of these sites that matches this Texas land property:
- westandswoperanches.com  (the broker's own site — check here FIRST; many
                            comps are West and Swope's own past deals)
- landsofamerica.com   (preferred for ranches / large land tracts)
- landwatch.com        (preferred for ranches / large land tracts)
- land.com             (preferred for ranches / large land tracts)
- zillow.com           (general)

CORE FACTS:
{facts}
{f'PARTIES:\n{parties}' if parties else ''}
{f'DESCRIPTION (cross-reference road names, creek names, subdivision, neighbors):\n{description}' if description else ''}

A listing is the same property only if it matches on AT LEAST 3 specific
identifiers (road/address, county AND nearest town, named water feature,
acreage within ±5%, named improvements, subdivision/abstract, elevation
signature, fencing/wildlife notes). Acres + county alone is NOT a match.

EXCEPTION — westandswoperanches.com ONLY: matching property name + same
county + acreage within ±5% is sufficient on the broker's own site.

CONFIDENCE TIERS:
  "high"   — meets the full bar above; 95%+ sure it is the same property.
  "medium" — exactly 2 specific identifiers AND acreage within ±15%, on
             a property detail page. A human will confirm or dismiss it.

REJECT (url: null) IF fewer than 2 identifiers match, acreage differs
more than ±15%, or the URL is a search-results/browse/agent page (must
be a property detail page). A missing link is far better than a wrong
one. NEVER report "high" when the honest tier is "medium".

End your reply with EXACTLY one line of valid JSON, no fences:
{{"url": "https://...", "confidence": "high", "reason": "short sentence"}}
or {{"url": "https://...", "confidence": "medium", "reason": "short sentence"}}
or {{"url": null, "confidence": null, "reason": "why no confident match"}}"""


def call_claude(api_key, prompt):
    body = json.dumps({
        'model': MODEL,
        'max_tokens': 4000,
        'output_config': {'effort': 'high'},
        'tools': [{
            'type': 'web_search_20260209',
            'name': 'web_search',
            'max_uses': 6,
            'allowed_domains': ['westandswoperanches.com', 'landsofamerica.com',
                                'landwatch.com', 'land.com', 'zillow.com'],
        }],
        'messages': [{'role': 'user', 'content': prompt}],
    }).encode()
    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages', data=body,
        headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01',
                 'Content-Type': 'application/json'})
    resp = json.loads(urllib.request.urlopen(req, timeout=180).read())
    text = '\n'.join(b.get('text', '') for b in resp.get('content', []) if b.get('type') == 'text').strip()
    objs = re.findall(r'\{[^{}]*\}', text)
    url, conf, reason = None, None, None
    if objs:
        try:
            parsed = json.loads(objs[-1])
            if isinstance(parsed.get('url'), str):
                m = URL_OK.search(parsed['url'])
                url = m.group(0).rstrip('.,;!?') if m else None
            if parsed.get('confidence') in ('high', 'medium'):
                conf = parsed['confidence']
            if isinstance(parsed.get('reason'), str):
                reason = parsed['reason'][:200]
        except Exception:
            pass
    if url and not conf:
        conf = 'medium'  # never let a formatting slip auto-write source_url
    return url, conf, reason


def main():
    apply = '--apply' in sys.argv
    env = load_env()
    conn = psycopg2.connect(pooler_url(env), connect_timeout=15)
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("""
      SELECT id, property_name, address, county, state, acres, sale_price,
             sale_date, grantor, grantee, description
      FROM comps
      WHERE (source_url IS NULL OR trim(source_url) = '')
        AND suggested_listing_url IS NULL
      ORDER BY created_at DESC
    """)
    rows = cur.fetchall()
    print(f'{"DRY RUN" if not apply else "APPLY"} — {len(rows)} comps without a listing URL\n')

    api_key = env['ANTHROPIC_API_KEY']
    results = {'high': 0, 'medium': 0, 'none': 0, 'error': 0}

    def work(row):
        try:
            return row, call_claude(api_key, build_prompt(row))
        except Exception as e:
            return row, ('__error__', None, str(e)[:160])

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(work, r) for r in rows]
        for fut in as_completed(futures):
            row, (url, conf, reason) = fut.result()
            comp_id, name = row[0], (row[1] or '(unnamed)')
            if url == '__error__':
                results['error'] += 1
                print(f'  ⚠ ERROR     {name[:40]:42s} {reason}')
                continue
            if not url:
                results['none'] += 1
                print(f'  · no match  {name[:40]:42s} {reason or ""}')
                continue
            results[conf] += 1
            tag = '✓ HIGH  ' if conf == 'high' else '? MEDIUM'
            print(f'  {tag}  {name[:40]:42s} {url}')
            print(f'            └ {reason or ""}')
            if apply:
                if conf == 'high':
                    cur.execute("""UPDATE comps SET source_url=%s,
                                   listing_match_confidence='high_auto',
                                   listing_match_reason=%s
                                   WHERE id=%s AND (source_url IS NULL OR trim(source_url)='')""",
                                (url, reason, comp_id))
                else:
                    cur.execute("""UPDATE comps SET suggested_listing_url=%s,
                                   listing_match_confidence='medium_suggested',
                                   listing_match_reason=%s
                                   WHERE id=%s AND suggested_listing_url IS NULL""",
                                (url, reason, comp_id))

    print(f'\nDone: {results["high"]} high · {results["medium"]} medium · '
          f'{results["none"]} no match · {results["error"]} errors'
          f'{"  (nothing written — dry run)" if not apply else ""}')
    conn.close()


if __name__ == '__main__':
    main()

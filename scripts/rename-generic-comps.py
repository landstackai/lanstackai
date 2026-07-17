#!/usr/bin/env python3
"""
Rename comps whose property_name is generic ("Land Sale N",
"Comparable N", "Sale #N") or null. Two runs:

    python3 scripts/rename-generic-comps.py            # DRY RUN — prints proposed changes only
    python3 scripts/rename-generic-comps.py --apply    # actually UPDATE the rows

Fallback chain per broker spec:
    1. Name from write-up  → Claude vision on description text
    2. Address (street)
    3. "<acres>± ac · <city>"
    4. "<road from address> · <county>"

Cost: ~$0.005 per Claude call. ~40 comps ≈ $0.20 total.
"""

import os
import sys
import re
import json
import psycopg2
import anthropic

MODEL = 'claude-sonnet-4-5-20250929'

NAME_FROM_DESC_PROMPT = """You are helping normalize property names in a Texas land brokerage's
comp database. Below is the free-text description of one comp.

Return the actual property name if the description explicitly names it — e.g.:
  - "the Buck Thorne Ranch"
  - "commonly known as Miller Creek Vista Ranch"
  - "The Cypress Mill Ranch is a..."
  - "the Bar-K Estate"

DO NOT INVENT a name. If no property name is stated in the text, return null.
DO NOT return generic labels like "Land Sale 3", "Comparable 2", "the property".

Return ONLY one of:
  {"name": "The Full Property Name Here"}
  {"name": null}

DESCRIPTION:
"""


def load_env():
    env = {}
    with open('/Users/louieswope/Downloads/lanstackai/.env.local') as f:
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


def is_generic(name):
    if not name or not name.strip():
        return True
    n = name.strip().lower()
    return bool(re.match(r'^(land\s+sale|comparable|comp\s+#?|sale\s+no|sale\s+#|property\s+[a-e])\s*[0-9]*\s*$', n))


def ask_claude_name(client, description):
    """Return extracted name string, or None."""
    if not description or len(description.strip()) < 20:
        return None
    try:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=100,
            temperature=0,
            messages=[{
                'role': 'user',
                'content': NAME_FROM_DESC_PROMPT + description.strip()[:4000],
            }],
        )
        text = resp.content[0].text.strip()
        text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text, flags=re.MULTILINE).strip()
        obj = json.loads(text)
        name = obj.get('name')
        if not name or not isinstance(name, str):
            return None
        name = name.strip()
        # Reject if Claude smuggled in a generic name anyway
        if is_generic(name):
            return None
        return name
    except Exception as e:
        print(f'    (claude error: {e})')
        return None


def fallback_name(row):
    """Build a name from address/acres/city/county when no write-up name found."""
    _, _, addr, acres, county, city = row[:6]
    # Fallback 1: address (street portion — strip city/state/zip if present)
    if addr:
        # Split off trailing ", City, ST 12345" — keep the street portion
        street = re.split(r',\s*[A-Za-z\s.]+,?\s*TX?\s*\d*', addr, maxsplit=1)[0].strip()
        street = street.rstrip(',').strip()
        if street and len(street) >= 3:
            return street
    # Fallback 2: acres + city
    if acres and city:
        acres_str = f'{acres:.0f}±' if float(acres) == int(acres) else f'{acres:.2f}±'
        return f'{acres_str} ac · {city}'
    # Fallback 3: acres + county
    if acres and county:
        acres_str = f'{acres:.0f}±' if float(acres) == int(acres) else f'{acres:.2f}±'
        return f'{acres_str} ac · {county}'
    return None


def main():
    apply = '--apply' in sys.argv
    env = load_env()
    conn = psycopg2.connect(pooler_url(env), connect_timeout=15)
    conn.autocommit = False
    cur = conn.cursor()

    cur.execute("""
      SELECT id, property_name, address, acres, county, city, description
      FROM comps
      WHERE property_name IS NULL
         OR trim(property_name) = ''
         OR property_name ~* '^\\s*(land\\s+sale|comparable|comp\\s+#?|sale\\s+no|sale\\s+#|property\\s+[a-e])\\s*[0-9]*\\s*$'
      ORDER BY county, property_name
    """)
    rows = cur.fetchall()

    if not rows:
        print('No generic-named comps found.')
        conn.close()
        return

    print(f'{"DRY RUN" if not apply else "APPLYING"} — {len(rows)} comps to rename\n')

    client = anthropic.Anthropic(api_key=env['ANTHROPIC_API_KEY'])
    changes = []
    for row in rows:
        comp_id, current, addr, acres, county, city, desc = row
        current_label = current if current and current.strip() else '(null/empty)'

        # 1. Try Claude on description
        proposed = ask_claude_name(client, desc)
        source = 'description'
        if not proposed:
            proposed = fallback_name(row)
            source = 'fallback'
        if not proposed:
            proposed = f'{county} County comp'
            source = 'last-resort'

        changes.append((comp_id, current_label, proposed, source))
        marker = '✓' if proposed and proposed != current_label else '·'
        print(f'  {marker} [{source:11s}] "{current_label}"  →  "{proposed}"')

    if not apply:
        print(f'\n(dry run — no rows updated. Re-run with --apply to write changes.)')
        conn.close()
        return

    updated = 0
    for comp_id, current, proposed, _ in changes:
        if proposed and proposed != current:
            cur.execute('UPDATE comps SET property_name = %s WHERE id = %s', (proposed, comp_id))
            updated += 1
    conn.commit()
    print(f'\n✓ Updated {updated} rows.')
    conn.close()


if __name__ == '__main__':
    main()

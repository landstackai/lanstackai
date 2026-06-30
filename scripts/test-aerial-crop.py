#!/usr/bin/env python3
"""
Aerial-crop validation test.

Pulls 10 random comps with aerial_image (the full appraisal-page render
from the server/Claude extraction path), asks Claude vision to identify
the bounding box of the aerial photograph on the page, crops it using
Pillow, and saves both the original page AND the cropped aerial to
/tmp/aerial-crop-tests/ for visual inspection.

Purpose: prove the Claude-vision-crop approach actually works on Landstack's
real PDF layouts before we commit to wiring it into the import pipeline.

Cost: ~10 × $0.005 = ~$0.05 in Claude calls. No production writes.

Run:
    cd ~/Downloads/lanstackai
    python3 scripts/test-aerial-crop.py
"""

import os
import sys
import re
import json
import base64
import io
import time
from pathlib import Path

import psycopg2
from PIL import Image
import anthropic

OUTPUT_DIR = Path('/tmp/aerial-crop-tests')
MODEL = 'claude-sonnet-4-5-20250929'  # match what the rest of the app uses
SAMPLE_SIZE = 10

# Same crop prompt we'd use in production. Asks for normalized 0..1 coords
# so we don't need to round-trip the source image dimensions (Claude doesn't
# always echo them accurately).
CROP_PROMPT = """Look at this image of an appraisal-report page.

Identify the bounding box of the LARGEST aerial photograph on the page —
the satellite or aerial view of the actual property. Ignore any small
inset maps, location maps, or icons. If there is no aerial photograph on
this page, return null.

Return ONLY a JSON object (no prose, no markdown fences) in this exact shape:
{"x": <float 0-1>, "y": <float 0-1>, "width": <float 0-1>, "height": <float 0-1>}
or
null

Coordinates are normalized: x=0 is the LEFT edge of the page, x=1 is the
RIGHT edge, y=0 is the TOP, y=1 is the BOTTOM. (x, y) is the top-left
corner of the bounding box, (width, height) is its size.
"""


def load_env():
    env = {}
    with open('.env.local') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            env[k] = v.strip().strip('"\'')
    return env


def parse_data_url(data_url: str):
    """Extract media-type and raw bytes from a data: URL."""
    m = re.match(r'^data:([^;]+);base64,(.*)$', data_url, re.DOTALL)
    if not m:
        return None, None
    return m.group(1), base64.b64decode(m.group(2))


def ask_claude_for_bbox(client, image_bytes: bytes, media_type: str):
    """Send the image to Claude vision and return bbox dict or None."""
    b64 = base64.b64encode(image_bytes).decode('ascii')
    response = client.messages.create(
        model=MODEL,
        max_tokens=200,
        temperature=0,
        messages=[
            {
                'role': 'user',
                'content': [
                    {
                        'type': 'image',
                        'source': {
                            'type': 'base64',
                            'media_type': media_type,
                            'data': b64,
                        },
                    },
                    {'type': 'text', 'text': CROP_PROMPT},
                ],
            }
        ],
    )
    text = response.content[0].text.strip()
    # Strip markdown fences if Claude included them despite the prompt.
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text, flags=re.MULTILINE).strip()
    if text.lower() == 'null':
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        print(f'    ✗ Could not parse Claude response: {text[:200]}')
        return None


def crop_with_bbox(img: Image.Image, bbox: dict) -> Image.Image:
    """Crop the image using normalized 0-1 bbox coords."""
    W, H = img.size
    x = max(0, int(bbox['x'] * W))
    y = max(0, int(bbox['y'] * H))
    w = min(W - x, int(bbox['width'] * W))
    h = min(H - y, int(bbox['height'] * H))
    return img.crop((x, y, x + w, y + h))


def slugify(s: str) -> str:
    if not s:
        return 'unknown'
    return re.sub(r'[^a-zA-Z0-9._-]+', '_', s)[:50]


def main():
    env = load_env()
    db_url = env.get('SUPABASE_DB_URL')
    api_key = env.get('ANTHROPIC_API_KEY')
    if not db_url:
        print('ERROR: SUPABASE_DB_URL not set in .env.local')
        sys.exit(1)

    # If the direct URL is IPv6-only (laptop's network may not route IPv6),
    # derive the IPv4 session-pooler URL by converting the host. Same pattern
    # we used for the parcels DB — Supabase's pooler hostnames follow
    # aws-1-us-east-1.pooler.supabase.com:5432 with username `postgres.<ref>`.
    m = re.match(r'^postgresql://postgres:([^@]+)@db\.([^.]+)\.supabase\.co:5432/postgres', db_url)
    if m:
        pwd, ref = m.group(1), m.group(2)
        db_url = f'postgresql://postgres.{ref}:{pwd}@aws-1-us-east-1.pooler.supabase.com:5432/postgres'
        print(f'(using IPv4 session-pooler URL for {ref})')
    if not api_key:
        print('ERROR: ANTHROPIC_API_KEY not set in .env.local')
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f'Output dir: {OUTPUT_DIR}')

    client = anthropic.Anthropic(api_key=api_key)

    # Pull 10 random comps with an aerial image. Limit to recent comps
    # so we're testing the current extraction pipeline's output, not
    # historical / experimental rows.
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
    # Note: pgbouncer in session-pooler mode misbehaves with parameterized
    # LIMIT — substitute the integer directly. SAMPLE_SIZE is a script constant
    # (no SQL injection risk).
    cur.execute(
        f"""
        SELECT id,
               COALESCE(property_name, county, 'comp') AS name,
               county,
               aerial_image,
               length(aerial_image) AS img_len
        FROM comps
        WHERE aerial_image IS NOT NULL
          AND aerial_image LIKE 'data:image%%'
          AND length(aerial_image) > 1000
        ORDER BY RANDOM()
        LIMIT {int(SAMPLE_SIZE)}
        """
    )
    rows = cur.fetchall()
    conn.close()
    print(f'Pulled {len(rows)} comps with aerial_image\n')

    summary = []
    for idx, (comp_id, name, county, aerial_data_url, img_len) in enumerate(rows, 1):
        slug = f'{idx:02d}_{slugify(name)}'
        print(f'[{idx}/{len(rows)}] {name} ({county}) — {img_len // 1024} KB')

        # 1. Decode and save original
        media_type, raw_bytes = parse_data_url(aerial_data_url)
        if not raw_bytes:
            print(f'    ✗ Could not decode data URL')
            summary.append((slug, name, 'decode_failed', None))
            continue

        try:
            img = Image.open(io.BytesIO(raw_bytes))
        except Exception as e:
            print(f'    ✗ Could not open image: {e}')
            summary.append((slug, name, 'image_open_failed', None))
            continue

        orig_path = OUTPUT_DIR / f'{slug}_original.jpg'
        img.convert('RGB').save(orig_path, 'JPEG', quality=85)
        print(f'    ✓ saved original {img.size[0]}×{img.size[1]} → {orig_path.name}')

        # 2. Ask Claude for the bbox
        t0 = time.time()
        try:
            bbox = ask_claude_for_bbox(client, raw_bytes, media_type)
        except Exception as e:
            print(f'    ✗ Claude call failed: {e}')
            summary.append((slug, name, f'claude_error: {str(e)[:80]}', None))
            continue
        elapsed = time.time() - t0

        if bbox is None:
            print(f'    ⊘ Claude says: no aerial on this page ({elapsed:.1f}s)')
            summary.append((slug, name, 'no_aerial', None))
            continue

        print(f'    ✓ bbox: x={bbox["x"]:.2f} y={bbox["y"]:.2f} w={bbox["width"]:.2f} h={bbox["height"]:.2f} ({elapsed:.1f}s)')

        # 3. Crop and save
        try:
            cropped = crop_with_bbox(img, bbox)
            crop_path = OUTPUT_DIR / f'{slug}_cropped.jpg'
            cropped.convert('RGB').save(crop_path, 'JPEG', quality=85)
            print(f'    ✓ saved cropped {cropped.size[0]}×{cropped.size[1]} → {crop_path.name}')
            summary.append((slug, name, 'ok', f'{cropped.size[0]}×{cropped.size[1]}'))
        except Exception as e:
            print(f'    ✗ Crop failed: {e}')
            summary.append((slug, name, f'crop_failed: {e}', None))

    print(f'\n{"═" * 70}')
    print(f'  Summary')
    print(f'{"═" * 70}')
    for slug, name, status, dims in summary:
        marker = '✓' if status == 'ok' else '⊘' if status == 'no_aerial' else '✗'
        dims_str = f' ({dims})' if dims else ''
        print(f'  {marker} {slug:30s} {status}{dims_str}')

    ok_count = sum(1 for _, _, s, _ in summary if s == 'ok')
    no_aerial_count = sum(1 for _, _, s, _ in summary if s == 'no_aerial')
    fail_count = len(summary) - ok_count - no_aerial_count

    print(f'\n  {ok_count} cropped successfully')
    print(f'  {no_aerial_count} reported no aerial')
    print(f'  {fail_count} failed')
    print(f'\n  Files: {OUTPUT_DIR}')
    print(f'  Open with: open {OUTPUT_DIR}')


if __name__ == '__main__':
    main()

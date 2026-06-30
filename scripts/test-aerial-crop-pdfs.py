#!/usr/bin/env python3
"""
End-to-end aerial-crop validation on real PDFs.

Takes raw PDF files (not pre-extracted aerial_image rows), renders each page
to a JPG, asks Claude vision to identify the bounding box of the property's
aerial photograph on that page, and crops it.

Output: pairs of {page_NN_original.jpg, page_NN_cropped.jpg} under
        /tmp/aerial-crop-tests-pdfs/<pdf_slug>/

Cost: ~$0.005 per page in Claude vision. PDF rendering is local (free, via
poppler's pdftoppm).
"""

import os
import sys
import re
import json
import base64
import io
import time
import subprocess
import tempfile
import shutil
from pathlib import Path

from PIL import Image
import anthropic

PDFS = [
    '/Users/louieswope/Downloads/comanche christina.pdf',
    '/Users/louieswope/Downloads/Land Sales - Christina.pdf',
    '/Users/louieswope/Downloads/Retrospective Appraisal Report_A-25-0165, 5098 FM 486, Thorndale.pdf',
]

OUTPUT_ROOT = Path('/tmp/aerial-crop-tests-pdfs')
MODEL = 'claude-sonnet-4-5-20250929'
DPI = 100  # plenty for Claude vision; keeps file sizes reasonable

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
    with open('/Users/louieswope/Downloads/lanstackai/.env.local') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            env[k] = v.strip().strip('"\'')
    return env


def slugify(s: str) -> str:
    return re.sub(r'[^a-zA-Z0-9._-]+', '_', s)[:60].strip('_')


def render_pdf_to_jpgs(pdf_path: str, out_dir: Path) -> list:
    """Use pdftoppm to render all pages of a PDF to JPGs. Returns sorted list of paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = out_dir / 'page'
    subprocess.run(
        ['pdftoppm', '-jpeg', '-r', str(DPI), pdf_path, str(prefix)],
        check=True,
        capture_output=True,
    )
    return sorted(out_dir.glob('page-*.jpg'))


def ask_claude_for_bbox(client, jpg_bytes: bytes):
    """Send the rendered page to Claude and return bbox dict or None."""
    b64 = base64.b64encode(jpg_bytes).decode('ascii')
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
                            'media_type': 'image/jpeg',
                            'data': b64,
                        },
                    },
                    {'type': 'text', 'text': CROP_PROMPT},
                ],
            }
        ],
    )
    text = response.content[0].text.strip()
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text, flags=re.MULTILINE).strip()
    if text.lower() == 'null':
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {'_parse_error': text[:200]}


def crop_with_bbox(img: Image.Image, bbox: dict) -> Image.Image:
    W, H = img.size
    x = max(0, int(bbox['x'] * W))
    y = max(0, int(bbox['y'] * H))
    w = min(W - x, int(bbox['width'] * W))
    h = min(H - y, int(bbox['height'] * H))
    return img.crop((x, y, x + w, y + h))


def process_pdf(client, pdf_path: str, out_root: Path):
    name = Path(pdf_path).stem
    slug = slugify(name)
    out_dir = out_root / slug
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    print(f'\n══ {name} ══')
    print(f'  rendering pages to {out_dir}/ ...')
    pages = render_pdf_to_jpgs(pdf_path, out_dir)
    print(f'  → {len(pages)} pages rendered')

    results = []
    for i, page_path in enumerate(pages, 1):
        with open(page_path, 'rb') as f:
            jpg_bytes = f.read()
        try:
            img = Image.open(io.BytesIO(jpg_bytes))
        except Exception as e:
            print(f'  [{i:2d}] {page_path.name}: image open failed: {e}')
            continue

        t0 = time.time()
        try:
            bbox = ask_claude_for_bbox(client, jpg_bytes)
        except Exception as e:
            print(f'  [{i:2d}] {page_path.name}: Claude failed: {str(e)[:80]}')
            results.append((i, 'claude_error', None))
            continue
        elapsed = time.time() - t0

        if bbox is None:
            print(f'  [{i:2d}] no aerial ({elapsed:.1f}s)')
            results.append((i, 'no_aerial', None))
            # Remove the rendered page since it has no aerial of interest
            page_path.unlink()
            continue

        if '_parse_error' in bbox:
            print(f'  [{i:2d}] Claude parse error: {bbox["_parse_error"][:80]}')
            results.append((i, 'parse_error', None))
            continue

        # Rename original
        orig_path = out_dir / f'page_{i:02d}_original.jpg'
        page_path.rename(orig_path)

        # Crop and save
        try:
            cropped = crop_with_bbox(img, bbox)
            crop_path = out_dir / f'page_{i:02d}_cropped.jpg'
            cropped.convert('RGB').save(crop_path, 'JPEG', quality=85)
            print(f'  [{i:2d}] ✓ bbox=({bbox["x"]:.2f},{bbox["y"]:.2f},{bbox["width"]:.2f},{bbox["height"]:.2f}) '
                  f'→ {cropped.size[0]}×{cropped.size[1]} ({elapsed:.1f}s)')
            results.append((i, 'ok', f'{cropped.size[0]}×{cropped.size[1]}'))
        except Exception as e:
            print(f'  [{i:2d}] crop failed: {e}')
            results.append((i, 'crop_failed', None))

    # Summary for this PDF
    ok = sum(1 for _, s, _ in results if s == 'ok')
    no_aerial = sum(1 for _, s, _ in results if s == 'no_aerial')
    fail = len(results) - ok - no_aerial
    print(f'  ── {name}: {ok} cropped, {no_aerial} no-aerial, {fail} failed')
    return results


def main():
    env = load_env()
    api_key = env.get('ANTHROPIC_API_KEY')
    if not api_key:
        print('ERROR: ANTHROPIC_API_KEY not set')
        sys.exit(1)

    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)
    OUTPUT_ROOT.mkdir(parents=True)

    client = anthropic.Anthropic(api_key=api_key)

    grand_total = {'ok': 0, 'no_aerial': 0, 'fail': 0}
    for pdf in PDFS:
        if not Path(pdf).exists():
            print(f'SKIP: {pdf} not found')
            continue
        results = process_pdf(client, pdf, OUTPUT_ROOT)
        grand_total['ok'] += sum(1 for _, s, _ in results if s == 'ok')
        grand_total['no_aerial'] += sum(1 for _, s, _ in results if s == 'no_aerial')
        grand_total['fail'] += sum(1 for _, s, _ in results if s not in ('ok', 'no_aerial'))

    print(f'\n{"═" * 70}')
    print(f'  GRAND TOTAL')
    print(f'{"═" * 70}')
    print(f'  {grand_total["ok"]} aerials successfully cropped')
    print(f'  {grand_total["no_aerial"]} pages had no aerial (correctly identified)')
    print(f'  {grand_total["fail"]} failures')
    print(f'\n  Open results:  open {OUTPUT_ROOT}')


if __name__ == '__main__':
    main()

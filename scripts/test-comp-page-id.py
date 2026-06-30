#!/usr/bin/env python3
"""
Test whether Claude correctly identifies which PDF pages contain comparable
sales (NOT the subject property, NOT support maps, NOT cover pages).

This validates the FIRST step of the production extraction pipeline: page
identification. The aerial-crop step downstream only sees the pages this
step tags as comps.

Sends the PDF to Claude with a simplified version of the production
CLAUDE_PDF_SYSTEM_PROMPT focused on page identification, then prints the
identified comp pages so we can compare against expected results.

Cost: ~$0.05-0.10 per PDF.
"""

import os, sys, re, json, base64
import anthropic

PDFS = [
    ('/Users/louieswope/Downloads/comanche christina.pdf',
     'expected: 3 comp aerials on pages 1, 3, 5'),
    ('/Users/louieswope/Downloads/Land Sales - Christina.pdf',
     'expected: 2 comp aerials on pages 1, 3'),
    ('/Users/louieswope/Downloads/Retrospective Appraisal Report_A-25-0165, 5098 FM 486, Thorndale.pdf',
     'expected: 6 land sales on pages 37, 39, 41, 43, 45, 47'),
]

MODEL = 'claude-sonnet-4-5-20250929'

# Mirrors the production CLAUDE_PDF_SYSTEM_PROMPT's instructions about
# what counts as a comp vs subject property, just stripped to the
# page-identification question.
PROMPT = """You are Landstack AI — a land/ranch real estate extraction specialist.

Read every page of this PDF and identify each COMPARABLE SALE (comp).
SKIP the subject property (the property being valued — its sale isn't being recorded).

A comp is recognizable by:
  - A "Land Sale N" / "Sale N" / "Sale No. N" / "Comparable N" / "Comp #N" / "Property A/B/C" header
  - OR an "Identification" + "Transaction Information" + "Property Information" block on a single-comp sheet

For each comp, return:
  - name (e.g. "Land Sale 1", or use property name if no number)
  - pages: array of PDF page numbers this comp's data lives on (1-indexed)
  - aerial_page: which one of those pages contains the aerial photograph (or null if none)

Return ONLY a JSON object (no markdown, no prose) of this shape:
{
  "doc_type": "<one-line description>",
  "comps": [
    {"name": "Land Sale 1", "pages": [37, 38], "aerial_page": 37},
    ...
  ]
}
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


def identify_comps(client, pdf_path):
    with open(pdf_path, 'rb') as f:
        pdf_bytes = f.read()
    b64 = base64.standard_b64encode(pdf_bytes).decode('ascii')
    response = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        temperature=0,
        messages=[
            {
                'role': 'user',
                'content': [
                    {
                        'type': 'document',
                        'source': {
                            'type': 'base64',
                            'media_type': 'application/pdf',
                            'data': b64,
                        },
                    },
                    {'type': 'text', 'text': PROMPT},
                ],
            }
        ],
    )
    raw = response.content[0].text.strip()
    raw = re.sub(r'^```(?:json)?\s*|\s*```$', '', raw, flags=re.MULTILINE).strip()
    return json.loads(raw)


def main():
    env = load_env()
    client = anthropic.Anthropic(api_key=env['ANTHROPIC_API_KEY'])

    for pdf, expected in PDFS:
        name = os.path.basename(pdf)
        print(f'\n══ {name} ══')
        print(f'  {expected}')
        try:
            result = identify_comps(client, pdf)
            print(f'  doc_type: {result.get("doc_type")}')
            print(f'  {len(result.get("comps", []))} comps identified:')
            for c in result.get('comps', []):
                pages_str = ','.join(str(p) for p in c.get('pages', []))
                aerial = c.get('aerial_page')
                print(f'    • {c.get("name", "?"):30s} pages=[{pages_str}]  aerial={aerial}')
        except Exception as e:
            print(f'  ✗ failed: {e}')


if __name__ == '__main__':
    main()

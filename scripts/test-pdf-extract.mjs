#!/usr/bin/env node
//
// Local PDF extraction test runner.
//
// Loads a PDF, extracts text per page using pdf.js (the same library
// the client uses), prints what each page contains. This is the first
// diagnostic to run when "boundary detection didn't qualify" — does
// pdf.js actually see the header text we're trying to regex against?
//
// Usage:
//   node scripts/test-pdf-extract.mjs "/path/to/document.pdf"
//
// Output: for each page, prints:
//   • Total text length
//   • Whether "Land Sale" / "Sale No" / "Comparable" / "Comp" appear
//   • First 400 chars of normalized text
//
// If our regex patterns DO appear in the text, our boundary detection
// should match them — and the bug is in the matcher, not the data. If
// they DON'T appear, the headers are rasterized (rendered as part of
// an image), and no amount of regex tweaking will help; vision is the
// only viable path.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('usage: node scripts/test-pdf-extract.mjs "/path/to/file.pdf"');
    process.exit(1);
  }

  // Use the pdfjs-dist legacy build for Node compatibility.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const buffer = await readFile(resolve(pdfPath));
  const data = new Uint8Array(buffer);

  const pdf = await pdfjs.getDocument({ data }).promise;
  console.log(`\nLoaded PDF: ${pdfPath}`);
  console.log(`Pages: ${pdf.numPages}\n`);
  console.log('─'.repeat(80));

  // Patterns the regex-based boundary detector tries.
  const PATTERNS = [
    { name: 'Land Sale N', re: /\bland\s*sale\s*#?\s*(\d{1,3})\b/i },
    { name: 'Sale No. N',  re: /\bsale\s*(?:no\.?|number|#)\s*(\d{1,3})\b/i },
    { name: 'Comparable N', re: /\bcomp(?:arable)?\s*(?:sale|#)?\s*(\d{1,3})\b/i },
  ];

  // Mirrors the normalization in pdfBoundaryDetection.ts so we see
  // exactly what the matcher sees.
  const normalize = (text) =>
    text
      .replace(/[     ​‌‍﻿]/g, ' ')
      .replace(/[­]/g, '')
      .replace(/[‐-―]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const rawText = content.items.map((item) => item.str).join(' ');
    const text = normalize(rawText);

    console.log(`\nPAGE ${i}`);
    console.log(`  text length: ${text.length} chars (raw: ${rawText.length})`);

    // Check which header patterns match anywhere on the page.
    const matches = [];
    for (const pat of PATTERNS) {
      const m = text.match(pat.re);
      if (m) {
        const where = text.indexOf(m[0]);
        matches.push(`${pat.name} → "${m[0]}" at char ${where}`);
      }
    }
    if (matches.length === 0) {
      console.log('  pattern matches: NONE');
    } else {
      console.log('  pattern matches:');
      for (const line of matches) console.log(`    ✓ ${line}`);
    }

    console.log(`  first 400 chars: "${text.slice(0, 400)}"`);
  }

  console.log('\n' + '─'.repeat(80));
  console.log('Done.\n');
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});

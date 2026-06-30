// Aerial cropping via Claude vision + sharp.
//
// Server-side helper used by import-pdf-orchestrator. Given a rendered
// appraisal page (JPG buffer), asks Claude vision to identify the
// bounding box of the largest aerial photograph on the page, then
// crops to just that aerial using sharp.
//
// WHY THIS EXISTS
//
// Before this helper, import-pdf-orchestrator stored the entire
// rendered page in aerial_image. That meant the bottom-left "Source
// aerial" thumbnail on the review page showed an unreadable text
// block (Property Identification + Transaction Data sections, etc.)
// at 220×160px. With this helper we keep the full-page render
// separate (for the new Review Comp Card modal) and put just the
// aerial photo in the thumbnail.
//
// PROMPT CHOICE
//
// Asks Claude for normalized (0-1) coordinates rather than pixel
// counts because Claude doesn't always echo image dimensions back
// accurately. Normalized coords are robust to whatever DPI the page
// was rendered at.
//
// EDGE CASES HANDLED
//
//   1. No aerial on page → returns { cropped: null, reason: 'no_aerial' }.
//      Caller stores aerial_image=null, broker sees "No aerial available"
//      placeholder + still gets the full page in source_page_image.
//
//   2. Claude returns malformed JSON (missing 'height' key, written
//      as 'h' instead) → defensive parsing accepts both forms. If
//      still unparseable → falls back to no_aerial.
//
//   3. Claude vision call throws → returns { cropped: null, reason:
//      'vision_error: ...' }. Best-effort: extraction shouldn't fail
//      because of a thumbnail crop issue.
//
// COST
//
// ~$0.005 per call. Christina's scale (~12 PDFs/mo × ~1 aerial each)
// is ~$0.06/mo. Negligible.

import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

const MODEL = 'claude-sonnet-4-5-20250929';

const CROP_PROMPT = `Look at this image of an appraisal-report page.

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
corner of the bounding box, (width, height) is its size.`;

export type CropResult = {
  cropped: Buffer | null;
  reason: 'ok' | 'no_aerial' | 'parse_error' | 'crop_error' | 'vision_error';
  detail?: string;
  bbox?: { x: number; y: number; width: number; height: number };
};

type RawBbox = {
  x?: number;
  y?: number;
  // Accept both spellings — Claude occasionally abbreviates 'width'/'height'
  // to 'w'/'h' even when the prompt asks for the long names. ~3% of calls
  // in empirical testing. Defensive parsing here prevents that quirk from
  // causing thumbnail-extraction failures.
  width?: number;
  w?: number;
  height?: number;
  h?: number;
};

function normalizeBbox(raw: RawBbox | null): CropResult['bbox'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = typeof raw.x === 'number' ? raw.x : null;
  const y = typeof raw.y === 'number' ? raw.y : null;
  const width = typeof raw.width === 'number' ? raw.width : typeof raw.w === 'number' ? raw.w : null;
  const height = typeof raw.height === 'number' ? raw.height : typeof raw.h === 'number' ? raw.h : null;
  if (x === null || y === null || width === null || height === null) return null;
  // Clamp to valid range; out-of-range coords would crash sharp.
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.max(0, Math.min(1, width)),
    height: Math.max(0, Math.min(1, height)),
  };
}

function parseClaudeResponse(text: string): RawBbox | null {
  // Strip markdown fences if Claude added them despite the prompt.
  let cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  if (cleaned.toLowerCase() === 'null') return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Crop the aerial photograph out of a rendered appraisal page.
 *
 * @param pageJpg - JPG buffer of the full rendered page (from ConvertAPI)
 * @param apiKey - Anthropic API key (typically process.env.ANTHROPIC_API_KEY)
 * @returns CropResult with the cropped JPG buffer, or null if no aerial / error
 */
export async function cropAerialFromPageJpg(
  pageJpg: Buffer,
  apiKey: string,
): Promise<CropResult> {
  if (!apiKey) {
    return { cropped: null, reason: 'vision_error', detail: 'ANTHROPIC_API_KEY not set' };
  }
  const client = new Anthropic({ apiKey });

  // 1. Ask Claude for the aerial bbox.
  let rawText: string;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: pageJpg.toString('base64'),
              },
            },
            { type: 'text', text: CROP_PROMPT },
          ],
        },
      ],
    });
    const block = response.content[0];
    if (block.type !== 'text') {
      return { cropped: null, reason: 'vision_error', detail: 'non-text response block' };
    }
    rawText = block.text;
  } catch (e: any) {
    return { cropped: null, reason: 'vision_error', detail: e?.message ?? String(e) };
  }

  // 2. Parse + normalize the bbox (defensive on h/w abbreviation).
  const raw = parseClaudeResponse(rawText);
  if (raw === null) {
    // Could be a genuine "null" response (no aerial) or a parse failure.
    if (rawText.trim().toLowerCase() === 'null') {
      return { cropped: null, reason: 'no_aerial' };
    }
    return { cropped: null, reason: 'parse_error', detail: rawText.slice(0, 200) };
  }

  const bbox = normalizeBbox(raw);
  if (!bbox) {
    return { cropped: null, reason: 'parse_error', detail: `missing fields: ${JSON.stringify(raw)}` };
  }

  // 3. Crop using sharp. Convert normalized 0-1 coords to pixel offsets
  //    based on the actual rendered page dimensions.
  try {
    const meta = await sharp(pageJpg).metadata();
    const W = meta.width;
    const H = meta.height;
    if (!W || !H) {
      return { cropped: null, reason: 'crop_error', detail: 'could not read image dimensions' };
    }
    const left = Math.max(0, Math.round(bbox.x * W));
    const top = Math.max(0, Math.round(bbox.y * H));
    const width = Math.min(W - left, Math.max(1, Math.round(bbox.width * W)));
    const height = Math.min(H - top, Math.max(1, Math.round(bbox.height * H)));
    const cropped = await sharp(pageJpg)
      .extract({ left, top, width, height })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { cropped, reason: 'ok', bbox };
  } catch (e: any) {
    return { cropped: null, reason: 'crop_error', detail: e?.message ?? String(e) };
  }
}

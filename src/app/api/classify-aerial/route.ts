import { NextRequest, NextResponse } from 'next/server';
import { classifyAerial } from '@/lib/utils/aerialAnalysis';

// POST /api/classify-aerial
//
// Body: { images: string[] } — array of base64 data URLs
// Returns: { classifications: ('AERIAL' | 'PHOTO' | 'OTHER' | null)[] }
//
// Thin server-side wrapper for the classifyAerial vision call. Exists so
// the browser-side import flow can run aerial-vs-photo classification
// without exposing the OpenAI key. Runs all classifications in parallel.
//
// Used by the import pipeline to filter candidate aerials before
// attaching them to comps — prevents house photos and logos from
// sneaking through as "the parcel aerial."
//
// Cost: ~$0.0001 per image (gpt-4o-mini, detail:'low'). A 5-page
// appraisal classifies for ~$0.0005 total, runs in 3-5s in parallel.
//
// Auth: none required. The cost-per-call is too small to bother gating,
// and the route doesn't accept arbitrary user content (just data URLs
// the user already had in their browser).

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const images = Array.isArray(body?.images) ? body.images : null;
  if (!images || images.length === 0) {
    return NextResponse.json({ error: 'images array required' }, { status: 400 });
  }
  if (images.length > 30) {
    return NextResponse.json({ error: 'too many images (max 30)' }, { status: 400 });
  }

  // Run all classifications in parallel. classifyAerial swallows its own
  // errors and returns null, so a single bad image doesn't tank the
  // whole batch.
  const classifications = await Promise.all(
    images.map((img: any) =>
      typeof img === 'string' ? classifyAerial(img) : Promise.resolve(null)
    )
  );

  return NextResponse.json({ classifications });
}
